import { expandInstances, pathStartsWith, resolvePath, multiply } from '@brickloop/core';
import type { BrkDocument, InstancePath } from '@brickloop/core';
import { insertionRange, solveRotation } from './constraints';
import { isCompatible, linearPair, occupancyChannel } from './rules';
import { ConnectorIndex } from './spatial';
import type { Connector, ConnectorInstance, ConnectorRef, WorldConnector } from './types';
import { connectorKey, pathKey, segmentEnd } from './world';
import { angle, compareText, distance, dot, scale, sub } from './vector';

export interface ConnectionEdge {
  a: ConnectorRef;
  b: ConnectorRef;
}
export interface GraphOptions {
  positionTolerance?: number;
  angleTolerance?: number;
  bucketSize?: number;
}
export interface GraphSource {
  /** A complete snapshot; changedPaths allows adapters to reuse unaffected world matrices. */
  instances(changedPaths?: readonly InstancePath[]): readonly ConnectorInstance[];
}
export class ConnectionGraph {
  readonly index: ConnectorIndex;
  readonly positionTolerance: number;
  readonly angleTolerance: number;
  private source: GraphSource;
  private edges = new Map<string, ConnectionEdge>();
  private adjacency = new Map<string, Set<string>>();
  constructor(source: GraphSource | readonly ConnectorInstance[], options: GraphOptions = {}) {
    this.source = Array.isArray(source) ? { instances: () => source } : (source as GraphSource);
    this.positionTolerance = options.positionTolerance ?? 0.5;
    this.angleTolerance = options.angleTolerance ?? 1;
    if (
      !Number.isFinite(this.positionTolerance) ||
      this.positionTolerance < 0 ||
      !Number.isFinite(this.angleTolerance) ||
      this.angleTolerance < 0
    )
      throw new RangeError('Invalid graph tolerance');
    this.index = new ConnectorIndex([], options.bucketSize ?? 10);
    const instances = this.source.instances();
    for (const instance of instances) this.index.set(instance);
    for (const instance of instances) this.connect(instance.path);
  }
  private connected(a: WorldConnector, b: WorldConnector): boolean {
    const ac = a.connector,
      bc = b.connector;
    if (!isCompatible(ac, bc).ok) return false;
    if (
      ac.type !== 'ball' &&
      bc.type !== 'ball' &&
      angle(ac.frame.axis, scale(bc.frame.axis, -1)) > this.angleTolerance
    )
      return false;
    const rotation = solveRotation(ac, bc);
    if (rotation.residual > 1e-6 || rotation.change > this.angleTolerance) return false;
    const pair = linearPair(ac, bc),
      range = insertionRange(ac, bc);
    if (pair && range) {
      const delta = sub(pair.male.frame.origin, pair.hole.frame.origin),
        axial = dot(delta, pair.hole.frame.axis);
      return (
        distance(delta, scale(pair.hole.frame.axis, axial)) <= this.positionTolerance &&
        range.min <= range.max &&
        range.offset >= range.min - this.positionTolerance &&
        range.offset <= range.max + this.positionTolerance
      );
    }
    return distance(ac.frame.origin, bc.frame.origin) <= this.positionTolerance;
  }
  private connect(path: InstancePath): void {
    for (const a of this.index.entriesOf(path))
      for (const b of this.index.querySegment(
        a.connector.frame.origin,
        segmentEnd(a.connector),
        this.positionTolerance,
      )) {
        if (pathKey(a.ref.path) === pathKey(b.ref.path) || !this.connected(a, b)) continue;
        const [first, second] = compareText(a.key, b.key) < 0 ? [a, b] : [b, a],
          key = JSON.stringify([first.key, second.key]);
        this.edges.set(key, { a: first.ref, b: second.ref });
        for (const endpoint of [a.ref.path, b.ref.path]) {
          const p = pathKey(endpoint);
          let set = this.adjacency.get(p);
          if (!set) this.adjacency.set(p, (set = new Set()));
          set.add(key);
        }
      }
  }
  /** Updates changed occurrences and every path containing their shared instance IDs.
   * Deleted paths must be included, even though they no longer resolve. [] is a no-op. */
  update(changedPaths: readonly InstancePath[]): { updatedInstances: number; removedInstances: number } {
    if (!changedPaths.length) return { updatedInstances: 0, removedInstances: 0 };
    const ids = new Set(changedPaths.flatMap((p) => (p.length ? [p[p.length - 1]!] : [])));
    const affected = (p: InstancePath): boolean =>
      changedPaths.some((c) => pathStartsWith(p, c)) || p.some((id) => ids.has(id));
    const previous = this.index.paths().filter(affected),
      next = this.source.instances(changedPaths).filter((i) => affected(i.path));
    for (const path of previous) {
      for (const key of this.adjacency.get(pathKey(path)) ?? []) {
        const edge = this.edges.get(key)!;
        this.adjacency.get(pathKey(edge.a.path))?.delete(key);
        this.adjacency.get(pathKey(edge.b.path))?.delete(key);
        this.edges.delete(key);
      }
      this.adjacency.delete(pathKey(path));
      this.index.delete(path);
    }
    for (const instance of next) this.index.set(instance);
    for (const instance of next) this.connect(instance.path);
    const current = new Set(next.map((i) => pathKey(i.path)));
    return { updatedInstances: next.length, removedInstances: previous.filter((p) => !current.has(pathKey(p))).length };
  }
  edgesOf(path: readonly string[]): ConnectionEdge[] {
    return [...(this.adjacency.get(pathKey(path)) ?? [])].sort(compareText).map((k) => this.edges.get(k)!);
  }
  connectedTo(path: readonly string[]): InstancePath[] {
    if (!this.index.paths().some((p) => pathKey(p) === pathKey(path))) return [];
    const pending = [Array.from(path)],
      found = new Map<string, InstancePath>();
    while (pending.length) {
      const p = pending.pop()!,
        key = pathKey(p);
      if (found.has(key)) continue;
      found.set(key, p);
      for (const edge of this.edgesOf(p)) pending.push(pathKey(edge.a.path) === key ? edge.b.path : edge.a.path);
    }
    return [...found.values()].sort((a, b) => compareText(pathKey(a), pathKey(b)));
  }
  components(): InstancePath[][] {
    const visited = new Set<string>(),
      components: InstancePath[][] = [];
    for (const path of this.index.paths().sort((a, b) => compareText(pathKey(a), pathKey(b)))) {
      if (visited.has(pathKey(path))) continue;
      const component = this.connectedTo(path);
      for (const p of component) visited.add(pathKey(p));
      components.push(component);
    }
    return components;
  }
  isOccupied = (ref: ConnectorRef, other: WorldConnector, excludedPaths: readonly string[][] = []): boolean => {
    const endpoint = this.index.entriesOf(ref.path).find((e) => e.key === connectorKey(ref));
    if (!endpoint) return false;
    const channel = occupancyChannel(endpoint.connector, other.connector),
      excluded = new Set(excludedPaths.map(pathKey));
    return this.edgesOf(ref.path).some((edge) => {
      if (connectorKey(edge.a) !== connectorKey(ref) && connectorKey(edge.b) !== connectorKey(ref)) return false;
      const opposite = connectorKey(edge.a) === connectorKey(ref) ? edge.b : edge.a;
      if (excluded.has(pathKey(opposite.path))) return false;
      const entry = this.index.entriesOf(opposite.path).find((e) => e.key === connectorKey(opposite));
      return entry !== undefined && occupancyChannel(endpoint.connector, entry.connector) === channel;
    });
  };
}

/** Uses core expansion initially; later traverses only affected subtrees. Reverse
 * occurrence paths retain deleted IDs until the corresponding update completes. */
export function documentConnectorSource(
  getDocument: () => BrkDocument,
  getConnectors: (partId: string) => readonly Connector[],
): GraphSource {
  let cache: ConnectorInstance[] | undefined;
  let previous: BrkDocument | undefined;
  let visits = new Map<string, InstancePath[]>();
  const modelVisits = (doc: BrkDocument): Map<string, InstancePath[]> => {
    const result = new Map<string, InstancePath[]>();
    const walk = (modelId: string, path: InstancePath, ancestors: Set<string>): void => {
      if (ancestors.has(modelId)) throw new RangeError('Cyclic model reference');
      const model = doc.models[modelId];
      if (!model) throw new RangeError('Missing model reference');
      const paths = result.get(modelId) ?? [];
      paths.push(path);
      result.set(modelId, paths);
      for (const instance of Object.values(model.instances))
        if (instance.ref.kind === 'model')
          walk(instance.ref.modelId, [...path, instance.id], new Set(ancestors).add(modelId));
    };
    walk(doc.rootModelId, [], new Set());
    return result;
  };
  const parentModel = (doc: BrkDocument, p: InstancePath): string | undefined => {
    if (p.length <= 1) return doc.rootModelId;
    const parent = resolvePath(doc, p.slice(0, -1));
    return parent?.instance.ref.kind === 'model' ? parent.instance.ref.modelId : undefined;
  };
  return {
    instances(changedPaths) {
      const doc = getDocument(),
        nextVisits = modelVisits(doc);
      if (!cache || !changedPaths || changedPaths.some((p) => !p.length)) {
        cache = expandInstances(doc).map((e) => ({
          path: e.path,
          worldMatrix: e.worldMatrix,
          connectors: getConnectors(e.partId),
        }));
        visits = nextVisits;
        previous = doc;
        return cache;
      }
      const roots = new Map<string, InstancePath>();
      for (const p of changedPaths) {
        roots.set(pathKey(p), p);
        const models = new Set([parentModel(doc, p), previous ? parentModel(previous, p) : undefined]);
        for (const id of models)
          if (id)
            for (const parent of [...(visits.get(id) ?? []), ...(nextVisits.get(id) ?? [])]) {
              const path = [...parent, p[p.length - 1]!];
              roots.set(pathKey(path), path);
            }
      }
      const paths = [...roots.values()].filter(
        (p) => ![...roots.values()].some((q) => q.length < p.length && pathStartsWith(p, q)),
      );
      cache = cache.filter((e) => !paths.some((p) => pathStartsWith(e.path, p)));
      for (const p of paths) {
        const resolved = resolvePath(doc, p);
        if (!resolved) continue;
        if (resolved.instance.ref.kind === 'part')
          cache.push({
            path: p,
            worldMatrix: resolved.worldMatrix,
            connectors: getConnectors(resolved.instance.ref.partId),
          });
        else
          for (const child of expandInstances(doc, resolved.instance.ref.modelId))
            cache.push({
              path: [...p, ...child.path],
              worldMatrix: multiply(resolved.worldMatrix, child.worldMatrix),
              connectors: getConnectors(child.partId),
            });
      }
      visits = nextVisits;
      previous = doc;
      return cache;
    },
  };
}
