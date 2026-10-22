import { expandInstances, transformDirection, transformPoint, pathStartsWith } from '@brickloop/core';
import type { BrkDocument, InstancePath, Matrix4 } from '@brickloop/core';
import { ConnectionGraph, ConnectorIndex, instantiateConnectors, solveSnap } from '@brickloop/connect';
import type { ConnectorInstance, SnapCandidate, SnapPointer, WorldConnector } from '@brickloop/connect';
import { CollisionWorld, runChecks } from '@brickloop/collide';
import type { CheckOptions, CollisionResult, ColliderShape, CheckContext } from '@brickloop/collide';
import type { AssemblyPart } from '../../shared/assembly-api';
import type { AssemblyCatalog } from '../../shared/assembly-api';

export interface AssemblySnapshot {
  doc: BrkDocument;
  parts: [string, AssemblyPart][];
  collision: boolean;
  hidden?: InstancePath[];
  catalog?: AssemblyCatalog;
}
export interface PreviewRequest {
  selection: { path: InstancePath; partId: string; matrix: number[]; fallback: number[] }[];
  primaryPath: InstancePath;
  enabled: boolean;
  collision: boolean;
  continuous: boolean;
  handleDrag?: boolean;
  pointer?: SnapPointer;
}
export interface PreviewResult {
  transforms: { path: InstancePath; transform: number[] }[];
  chosen: SnapCandidate | null;
  collision: CollisionResult;
  markers: WorldConnector[];
  timing: { snapMs: number; collisionMs: number };
}
const emptyCollision = (): CollisionResult => ({
  status: 'none',
  pairs: [],
  unknownPaths: [],
  reasons: [],
  testedPairs: 0,
});
const key = (path: readonly string[]) => JSON.stringify(path);

/** Desktop adapter: scopes the graph and maps file review states without changing either package. */
export function connectivityAdapter(
  graph: ConnectionGraph,
  parts: ReadonlyMap<string, AssemblyPart>,
): NonNullable<CheckContext['connectivity']> {
  return {
    isConnectorDataReviewed: (id) => (parts.has(id) ? parts.get(id)!.connectors.status === 'reviewed' : undefined),
    components(scope) {
      const remaining = new Map(scope.map((path) => [key(path), path]));
      const components: InstancePath[][] = [];
      for (const root of scope) {
        if (!remaining.has(key(root))) continue;
        const pending = [root];
        const component: InstancePath[] = [];
        while (pending.length) {
          const path = pending.pop()!;
          if (!remaining.delete(key(path))) continue;
          component.push(path);
          for (const edge of graph.edgesOf(path)) {
            const other = key(edge.a.path) === key(path) ? edge.b.path : edge.a.path;
            if (remaining.has(key(other))) pending.push(other);
          }
        }
        components.push(component);
      }
      return components;
    },
  };
}

/** Convert public collider data for the public preview API. Non-rigid transforms are conservative/unknown. */
export function previewShapes(
  part: AssemblyPart | undefined,
  matrix: Matrix4,
): { shapes: ColliderShape[]; approximate: boolean } {
  if (!part) return { shapes: [], approximate: true };
  const axes = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ].map((v) => transformDirection(matrix, v as [number, number, number]));
  const rigid =
    axes.every((a) => Math.abs(Math.hypot(...a) - 1) < 1e-6) &&
    axes.every((a, i) => axes.every((b, j) => i === j || Math.abs(a.reduce((s, v, k) => s + v * b[k]!, 0)) < 1e-6));
  if (!rigid) {
    const b = part.collider.bounds,
      points: ReturnType<typeof transformPoint>[] = [];
    for (const x of [b[0], b[3]])
      for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) points.push(transformPoint(matrix, [x, y, z]));
    const min = [0, 1, 2].map((i) => Math.min(...points.map((p) => p[i]!)));
    const max = [0, 1, 2].map((i) => Math.max(...points.map((p) => p[i]!)));
    return {
      approximate: true,
      shapes: [
        {
          kind: 'box',
          center: min.map((v, i) => (v + max[i]!) / 2) as [number, number, number],
          halfSize: min.map((v, i) => (max[i]! - v) / 2) as [number, number, number],
          rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        },
      ],
    };
  }
  return {
    approximate: part.collider.approximate,
    shapes: part.collider.shapes.map((shape) => {
      const center = transformPoint(matrix, shape.center) as [number, number, number];
      if (shape.kind === 'cylinder')
        return { ...shape, center, axis: transformDirection(matrix, shape.axis) as [number, number, number] };
      const rotation = [0, 3, 6].flatMap((i) =>
        Array.from(transformDirection(matrix, shape.rotation.slice(i, i + 3) as [number, number, number])),
      ) as Extract<ColliderShape, { kind: 'box' }>['rotation'];
      return { ...shape, center, rotation };
    }),
  };
}
export class AssemblyEngine {
  constructor(private readonly previewBudgetMs = 4) {}
  private doc: BrkDocument | undefined;
  readonly parts = new Map<string, AssemblyPart>();
  graph = new ConnectionGraph([]);
  private snapIndex: ConnectorIndex | undefined;
  private hidden: InstancePath[] = [];
  world = new CollisionWorld();
  private rows = new Map<string, ReturnType<typeof expandInstances>[number]>();
  private previous: SnapCandidate | null = null;
  private catalog: AssemblyCatalog | undefined;
  sync(snapshot: AssemblySnapshot, includeGraph = true) {
    const reset = this.doc?.documentId !== snapshot.doc.documentId;
    const changedParts = new Set<string>();
    for (const [id, part] of snapshot.parts) {
      this.parts.set(id, part);
      changedParts.add(id);
    }
    this.catalog = snapshot.catalog ?? this.catalog;
    this.doc = snapshot.doc;
    const rows = new Map(expandInstances(this.doc).map((row) => [key(row.path), row]));
    const changed = [...this.rows].filter(([k]) => !rows.has(k)).map(([, row]) => row.path);
    for (const [k, row] of rows) {
      const before = this.rows.get(k);
      if (
        !before ||
        before.partId !== row.partId ||
        changedParts.has(row.partId) ||
        row.worldMatrix.some((v, i) => v !== before.worldMatrix[i])
      )
        changed.push(row.path);
    }
    this.rows = rows;
    if (reset || changed.length > 128) {
      this.graph = new ConnectionGraph({
        instances: () =>
          [...this.rows.values()].map((row) => ({
            path: row.path,
            worldMatrix: row.worldMatrix,
            connectors: this.parts.get(row.partId)?.connectors.connectors ?? [],
          })),
      });
      this.world = new CollisionWorld();
      for (const row of rows.values()) this.setWorld(row);
    } else {
      this.graph.update(changed);
      for (const path of changed) {
        const row = rows.get(key(path));
        if (row) this.setWorld(row);
        else this.world.remove(path);
      }
    }
    this.rows = rows;
    this.hidden = snapshot.hidden ?? this.hidden;
    this.snapIndex = this.hidden.length
      ? new ConnectorIndex(
          [...rows.values()]
            .filter((row) => !this.hidden.some((path) => pathStartsWith(row.path, path)))
            .map((row) => ({
              path: row.path,
              worldMatrix: row.worldMatrix,
              connectors: this.parts.get(row.partId)?.connectors.connectors ?? [],
            })),
        )
      : undefined;
    this.world.enabled = snapshot.collision;
    this.previous = null;
    if (!includeGraph) return { markers: [], edges: [], components: [] };
    return {
      markers: [...rows.values()].flatMap((row) => this.graph.index.entriesOf(row.path)),
      edges: [...rows.values()].flatMap((row) => this.graph.edgesOf(row.path)),
      components: connectivityAdapter(this.graph, this.parts).components([...rows.values()].map((row) => row.path)),
    };
  }
  private setWorld(row: ReturnType<typeof expandInstances>[number]) {
    const collider = this.parts.get(row.partId)?.collider;
    this.world.set({ path: row.path, transform: row.worldMatrix, ...(collider ? { collider } : {}) });
  }
  preview(request: PreviewRequest): PreviewResult {
    const selection: ConnectorInstance[] = request.selection.map((row) => ({
      path: row.path,
      worldMatrix: new Float64Array(row.matrix),
      connectors: this.parts.get(row.partId)?.connectors.connectors ?? [],
    }));
    const start = performance.now();
    const snap = solveSnap({
      selection,
      primaryPath: request.primaryPath,
      enabled: request.enabled,
      continuous: request.continuous,
      index: this.snapIndex ?? this.graph.index,
      previous: this.previous,
      isOccupied: this.graph.isOccupied,
      ...(request.pointer ? { pointer: request.pointer } : {}),
      // A transform handle is drawn away from the part. Keep the world capture at 12 LDU,
      // but allow its screen-space offset when dragging an axis handle.
      ...(request.handleDrag ? { config: { screenRadius: 160 } } : {}),
    });
    const snapMs = performance.now() - start;
    const collisionStart = performance.now();
    const excluded = request.selection.map((row) => row.path);
    const query = (transforms: PreviewResult['transforms']): CollisionResult => {
      if (!request.collision) return emptyCollision();
      if (performance.now() - collisionStart >= this.previewBudgetMs)
        return {
          ...emptyCollision(),
          status: 'unknown',
          unknownPaths: transforms.map((row) => row.path),
          reasons: ['budget'],
        };
      const results = transforms.map((row) => {
        const partId = request.selection.find((item) => key(item.path) === key(row.path))!.partId;
        return this.world.query(
          {
            path: row.path,
            ...previewShapes(this.parts.get(partId), new Float64Array(row.transform)),
            excludePaths: excluded,
          },
          { enabled: true, budgetMs: Math.max(0, this.previewBudgetMs - (performance.now() - collisionStart)) },
        );
      });
      if (transforms.length > 1) {
        const movingWorld = new CollisionWorld({
          instances: transforms.map((row) => {
            const partId = request.selection.find((item) => key(item.path) === key(row.path))!.partId;
            const collider = this.parts.get(partId)?.collider;
            return { path: row.path, transform: new Float64Array(row.transform), ...(collider ? { collider } : {}) };
          }),
        });
        results.push(
          movingWorld.queryAll(undefined, {
            budgetMs: Math.max(0, this.previewBudgetMs - (performance.now() - collisionStart)),
          }),
        );
      }
      return {
        status: results.some((r) => r.status === 'unknown')
          ? 'unknown'
          : results.some((r) => r.status === 'hit')
            ? 'hit'
            : 'none',
        pairs: results.flatMap((r) => r.pairs),
        unknownPaths: results.flatMap((r) => r.unknownPaths),
        reasons: [...new Set(results.flatMap((r) => r.reasons))],
        testedPairs: results.reduce((sum, r) => sum + r.testedPairs, 0),
      };
    };
    const transforms =
      snap.chosen?.transforms ?? request.selection.map((row) => ({ path: row.path, transform: row.fallback }));
    const collision = query(transforms);
    // Every returned candidate gets a real preview result; exhausted budgets remain explicitly unknown.
    if (snap.chosen) snap.chosen.collision = collision.status;
    for (const candidate of snap.candidates)
      if (candidate !== snap.chosen) candidate.collision = query(candidate.transforms).status;
    this.previous = snap.chosen;
    const markers = snap.chosen
      ? [snap.chosen.source, snap.chosen.target].flatMap((ref) => {
          const moving = transforms.find((row) => key(row.path) === key(ref.path));
          const entries = moving
            ? instantiateConnectors({
                path: ref.path,
                worldMatrix: new Float64Array(moving.transform),
                connectors:
                  this.parts.get(request.selection.find((row) => key(row.path) === key(ref.path))!.partId)?.connectors
                    .connectors ?? [],
              })
            : this.graph.index.entriesOf(ref.path);
          return entries.filter((entry) => entry.ref.connectorId === ref.connectorId);
        })
      : [];
    return {
      transforms,
      chosen: snap.chosen,
      collision,
      markers,
      timing: { snapMs, collisionMs: performance.now() - collisionStart },
    };
  }
  check(options: CheckOptions) {
    if (!this.doc) return { issues: [], collision: emptyCollision(), durationMs: 0 };
    const start = performance.now();
    const visiblePaths = [...this.rows.values()]
      .filter((row) => !this.hidden.some((path) => pathStartsWith(row.path, path)))
      .map((row) => row.path);
    const collision = options.collisionEnabled
      ? this.world.queryAll(visiblePaths, { budgetMs: options.collisionBudgetMs ?? 100 })
      : emptyCollision();
    const issues = this.checkIssues(options);
    return { issues, collision, durationMs: performance.now() - start };
  }
  /** AI callers need issues only; the interactive overlay has a separate visible scope. */
  checkIssues(options: CheckOptions) {
    if (!this.doc) return [];
    const catalog = this.catalog;
    const catalogParts = new Map(catalog?.parts.map((part) => [part.id, part]));
    const catalogColors = new Set(catalog?.colors);
    return runChecks(
      this.doc,
      {
        connectivity: connectivityAdapter(this.graph, this.parts),
        geometry: (id) => ({ missing: this.parts.get(id)?.missing ?? [] }),
        collisionWorld: this.world,
        ...(catalog
          ? {
              catalog: {
                isFactoryPart: (id: string) => catalogParts.get(id)?.factory === true,
                isFactoryColor: (id: string) => catalogColors.has(id),
                availableColors: (id: string) => catalogParts.get(id)?.colors ?? [],
              },
            }
          : {}),
      },
      { ...options, collisionBudgetMs: options.collisionBudgetMs ?? 100 },
    );
  }
}
