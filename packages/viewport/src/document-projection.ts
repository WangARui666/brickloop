import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  LineBasicNodeMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  Mesh,
  LineBasicMaterial,
  Sphere,
  Vector3,
} from 'three/webgpu';
import type { OrthographicCamera, PerspectiveCamera, Ray, MeshStandardMaterial } from 'three/webgpu';
import { attribute, mat4, positionLocal, vec4 } from 'three/tsl';
import { MeshBVH } from 'three-mesh-bvh';
import { pathStartsWith, resolvePath, resolveContext, groupAncestors } from '@brickloop/core';
import type { BrkDocument, InstancePath, Workspace } from '@brickloop/core';
import type { ColorDef } from '@brickloop/catalog';
import type { PartMesh } from '@brickloop/ldraw';
import { partMaterial } from './parts';
import { Occurrences } from './occurrences';
import { BoundsTree } from './bounds-tree';
import { dimContextColor } from './context-color';
import { loadingMesh } from './loading-mesh';
import { transformPreviews } from '../../core/src/history/transform-preview';
import { MaterialBatches, geometryGroup } from './material-batches';
import { markRange } from './update-range';

export const pathKey = (path: readonly string[]): string => path.join('/');
export type EdgeMode = 'auto' | 'always';
export function pickPath(paths: readonly InstancePath[], instanceId: number | undefined): InstancePath | null {
  return instanceId === undefined ? null : (paths[instanceId] ?? null);
}
interface Definition {
  mesh: PartMesh;
  geometry: BufferGeometry;
  bvh: MeshBVH;
  bounds: Box3;
  edges: Float32Array;
  surfaces: BufferGeometry[];
}
export interface ProjectedRow {
  path: InstancePath;
  partId: string;
  colorId: string;
  matrix: Matrix4;
  bounds: Box3;
  visible: boolean;
  editable: boolean;
  dimmed: boolean;
}
interface Batch {
  object: InstancedMesh;
  mask: InstancedMesh;
  lines: LineSegments;
  paths: InstancePath[];
  capacity: number;
  rows: ProjectedRow[];
  definition: Definition;
  maskState: { kind: number; matrix: Matrix4 }[];
  bounds: Box3;
  maxScale: number;
  edgeShown: boolean;
}
const zero = new Matrix4().makeScale(0, 0, 0);

/** WebGPU releases node-generated instance attributes through the geometry lifecycle.
 * Give each mesh its own wrapper while retaining shared definition vertex/index data. */
function batchGeometry(source: BufferGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex(source.index);
  for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute);
  geometry.groups = source.groups.map((group) => ({ ...group }));
  geometry.boundingBox = source.boundingBox;
  geometry.boundingSphere = source.boundingSphere;
  return geometry;
}

/** Persistent definition/color batches. Matrix/edge upload ranges only cover changed slots. */
export class DocumentProjection {
  isRegistered(partId: string): boolean {
    const definition = this.definitions.get(partId);
    return !!definition && definition.mesh !== this.loading;
  }
  readonly root = new Group();
  readonly maskRoot = new Group();
  readonly definitions = new Map<string, Definition>();
  readonly batches = new Map<string, Batch>();
  private readonly merged = new MaterialBatches();
  private merging = false;
  private transientHits = new Map<string, Group>();
  get previewing() {
    return !!this.lastDocument && transformPreviews.has(this.lastDocument);
  }
  private writePreviewRow(row: ProjectedRow) {
    const key = pathKey(row.path),
      hidden = this.transientHits.has(key);
    const batch = this.rowBatches.get(row)!,
      slot = this.rowSlots.get(row)!;
    const matrix = row.visible && !hidden ? row.matrix : zero;
    batch.object.setMatrixAt(slot, matrix);
    markRange(batch.object.instanceMatrix, slot * 16, 16);
    batch.object.instanceMatrix.needsUpdate = true;
    for (let column = 0; column < 4; column++) {
      const attr = batch.lines.geometry.getAttribute(`transform${column}`) as InstancedBufferAttribute;
      const e = matrix.elements;
      attr.setXYZW(slot, e[column * 4]!, e[column * 4 + 1]!, e[column * 4 + 2]!, e[column * 4 + 3]!);
      markRange(attr, slot * 4, 4);
      attr.needsUpdate = true;
    }
    this.merged.hide(key, hidden);
    this.merged.update(row);
    this.transientHits.get(key)?.matrix.copy(row.matrix);
  }
  /** Collision previews affect only their participants, without repartitioning the scene. */
  previewCollisions(paths: InstancePath[]) {
    const rows = new Map(
      paths.flatMap((path) => (this.byPrefix.get(pathKey(path)) ?? []).map((row) => [pathKey(row.path), row] as const)),
    );
    for (const [key, group] of this.transientHits)
      if (!rows.has(key)) {
        this.root.remove(group);
        group.traverse((object) => {
          if (object instanceof Mesh || object instanceof LineSegments) {
            object.geometry.dispose();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach((material) => material.dispose());
          }
        });
        this.transientHits.delete(key);
        const row = this.byPath.get(key);
        if (row) this.writePreviewRow(row);
      }
    for (const [key, row] of rows) {
      if (!this.transientHits.has(key)) {
        const batch = this.rowBatches.get(row)!;
        const materials = (batch.object.material as MeshStandardMaterial[]).map((source) => {
          const material = source.clone();
          material.transparent = true;
          material.opacity = 0.38;
          material.depthWrite = false;
          return material;
        });
        const group = new Group();
        group.matrixAutoUpdate = false;
        const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(batch.definition.edges, 3));
        group.add(
          new Mesh(batchGeometry(batch.definition.geometry), materials),
          new LineSegments(geometry, new LineBasicMaterial({ color: '#f0616d' })),
        );
        this.transientHits.set(key, group);
        this.root.add(group);
      }
      this.writePreviewRow(row);
    }
  }
  rows: ProjectedRow[] = [];
  stats = {
    batches: 0,
    matrixWrites: 0,
    allocations: 0,
    syncMs: 0,
    syncWorkMs: 0,
    pickMs: 0,
    pickCandidates: 0,
    boundsRefits: 0,
    cachedDefinitions: 0,
    meshRegistrationMs: 0,
    geometryBvhMs: 0,
  };
  private sources = new Map<string, PartMesh>();
  private occurrences = new Occurrences();
  private tree = new BoundsTree<ProjectedRow>();
  private byPath = new Map<string, ProjectedRow>();
  private byPrefix = new Map<string, ProjectedRow[]>();
  private rowBatches = new WeakMap<ProjectedRow, Batch>();
  private instanceRows = new Map<string, number[]>();
  private rowSlots = new WeakMap<ProjectedRow, number>();
  private lastDocument: BrkDocument | undefined;
  private lastState = '';
  private selected: InstancePath[] = [];
  private primary: InstancePath | undefined;
  private hovered: InstancePath | null = null;
  private colors: readonly ColorDef[] = [];
  collisionPaths = new Set<string>();
  edgeMode: EdgeMode = 'auto';
  private readonly loading = loadingMesh();
  private loadingDefinition: Definition | undefined;
  private batchKey(partId: string, colorId: string, dimmed: boolean, hit: boolean) {
    return `${this.definitions.get(partId)?.mesh === this.loading ? '$loading' : partId}/${colorId}/${dimmed ? 'context' : 'active'}/${hit ? 'hit' : 'clear'}`;
  }
  get loadedCount() {
    return this.rows.filter((row) => this.definitions.get(row.partId)?.mesh !== this.loading).length;
  }

  register(partId: string, mesh: PartMesh): void {
    const started = performance.now();
    if (mesh === this.loading) {
      const shared = this.loadingDefinition;
      if (shared) {
        this.definitions.set(partId, shared);
        return;
      }
    }
    this.sources.set(partId, mesh);
    if (this.definitions.get(partId)?.mesh === mesh) return;
    this.lastDocument = undefined;
    const old = this.definitions.get(partId);
    if (old && old.mesh !== this.loading) {
      old.geometry.dispose();
      old.surfaces.forEach((geometry) => geometry.dispose());
    }
    const positions: number[] = [],
      normals: number[] = [],
      indices: number[] = [];
    const geometry = new BufferGeometry();
    mesh.batches.forEach((batch, i) => {
      const offset = positions.length / 3;
      geometry.addGroup(indices.length, batch.indices.length, i);
      for (const value of batch.positions) positions.push(value);
      for (const value of batch.normals) normals.push(value);
      for (const value of batch.indices) indices.push(value + offset);
    });
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const [x, y, z, a, b, c] = mesh.bboxLdu;
    const edges = new Float32Array(mesh.edges.reduce((sum, entry) => sum + entry.positions.length, 0));
    let cursor = 0;
    for (const edge of mesh.edges) {
      edges.set(edge.positions, cursor);
      cursor += edge.positions.length;
    }
    const bvhStarted = performance.now();
    const bvh = new MeshBVH(geometry);
    this.stats.geometryBvhMs += performance.now() - bvhStarted;
    this.definitions.set(partId, {
      mesh,
      geometry,
      bvh,
      bounds: new Box3(new Vector3(x, y, z), new Vector3(a, b, c)),
      edges,
      surfaces: geometry.groups.map((group) => geometryGroup(geometry, group.start, group.count)),
    });
    if (mesh === this.loading) this.loadingDefinition = this.definitions.get(partId);
    this.stats.meshRegistrationMs += performance.now() - started;
  }

  sync(document: BrkDocument, workspace: Workspace, colors: readonly ColorDef[]): void {
    const started = performance.now();
    const state = JSON.stringify([
      workspace.activeModelPath,
      workspace.hidden,
      workspace.panelState.stepViewing,
      workspace.panelState.stepId,
      workspace.panelState.activeGroupId,
      [...this.collisionPaths],
    ]);
    const preview = transformPreviews.get(document);
    const previousPreview = this.lastDocument && transformPreviews.get(this.lastDocument);
    if (
      preview &&
      this.lastState === state &&
      this.colors === colors &&
      (this.lastDocument === preview.base || previousPreview?.base === preview.base)
    ) {
      const changed = new Set(
        [...preview.ids, ...(previousPreview?.ids ?? [])].flatMap((id) => this.instanceRows.get(id) ?? []),
      );
      this.stats.matrixWrites = 0;
      for (const index of changed) {
        const row = this.rows[index]!;
        const matrix = new Matrix4().fromArray(resolvePath(document, row.path)!.worldMatrix);
        if (row.matrix.equals(matrix)) continue;
        row.matrix = matrix;
        row.bounds = this.definitions.get(row.partId)!.bounds.clone().applyMatrix4(matrix);
        const batch = this.rowBatches.get(row)!;
        this.writePreviewRow(row);
        // Conservative growth during a gesture; full sync shrinks the bound after commit/cancel.
        batch.bounds.union(row.bounds);
        batch.object.boundingBox = batch.bounds;
        batch.object.boundingSphere = batch.bounds.getBoundingSphere(new Sphere());
        batch.lines.geometry.boundingSphere = batch.object.boundingSphere;
        this.stats.matrixWrites++;
      }
      this.tree.refit([...changed]);
      this.stats.boundsRefits = this.tree.stats.refits;
      this.lastDocument = document;
      this.highlight(workspace.selection, workspace.selection.at(-1), this.hovered);
      this.stats.syncMs = this.stats.syncWorkMs = performance.now() - started;
      return;
    }
    if (
      this.lastDocument === document &&
      this.lastState === state &&
      this.colors.length === colors.length &&
      colors.every((color, index) => color === this.colors[index])
    ) {
      this.stats.matrixWrites = 0;
      this.stats.boundsRefits = 0;
      this.highlight(workspace.selection, workspace.selection.at(-1), this.hovered);
      this.stats.syncMs = performance.now() - started;
      return;
    }
    const sameContext = this.lastState === state;
    this.previewCollisions([]);
    const previousOrder = this.rows;
    this.lastDocument = document;
    this.lastState = state;
    this.colors = colors;
    const byColor = new Map(colors.map((color) => [color.id as string, color]));
    const groups = new Map<string, ProjectedRow[]>();
    const viewing = workspace.panelState.stepViewing === true;
    const model = viewing ? resolveContext(document, { activeModelPath: workspace.activeModelPath })?.model : undefined;
    const stepIndex = model ? Math.max(0, model.stepIds.indexOf(String(workspace.panelState.stepId))) : -1;
    const previousRows = this.byPath;
    this.byPath = new Map();
    const stepIndices = new Map(model?.stepIds.map((id, index) => [id, index]));
    this.rows = this.occurrences.expand(document).flatMap((item) => {
      if (item.instance.ref.kind !== 'part') return [];
      const partId = item.instance.ref.partId;
      if (!this.definitions.has(partId) && this.sources.has(partId)) this.register(partId, this.sources.get(partId)!);
      if (!this.definitions.has(partId)) this.register(partId, this.loading);
      const definition = this.definitions.get(partId);
      if (!definition) return [];
      const keyPath = pathKey(item.path);
      const before = previousRows.get(keyPath);
      const matrix = item.matrix;
      if (
        sameContext &&
        !viewing &&
        !workspace.panelState.activeGroupId &&
        before?.matrix === matrix &&
        before.partId === partId &&
        before.colorId === item.colorId
      ) {
        const key = this.batchKey(partId, item.colorId, before.dimmed, this.collisionPaths.has(keyPath));
        if (this.batches.get(key)?.definition === definition) {
          const list = groups.get(key) ?? [];
          list.push(before);
          groups.set(key, list);
          this.byPath.set(keyPath, before);
          return [before];
        }
      }
      const top = model?.instances[item.path[workspace.activeModelPath.length] ?? ''];
      const index = top ? (stepIndices.get(top.stepId) ?? -1) : -1;
      const row: ProjectedRow = {
        path: item.path,
        partId,
        colorId: item.colorId,
        matrix,
        bounds:
          before?.matrix === matrix &&
          before.partId === partId &&
          this.batches.get(this.batchKey(partId, item.colorId, before.dimmed, this.collisionPaths.has(keyPath)))
            ?.definition === definition
            ? before.bounds
            : definition.bounds.clone().applyMatrix4(matrix),
        visible:
          !workspace.hidden.some((path) => pathStartsWith(item.path, path)) &&
          (!viewing || (index >= 0 && index <= stepIndex && pathStartsWith(item.path, workspace.activeModelPath))),
        dimmed: false,
        editable:
          pathStartsWith(item.path, workspace.activeModelPath) &&
          (!workspace.panelState.activeGroupId ||
            groupAncestors(
              document,
              resolvePath(document, item.path.slice(0, workspace.activeModelPath.length + 1))?.instance.groupId ?? null,
            ).some((group) => group.id === workspace.panelState.activeGroupId)),
      };
      row.dimmed = !row.editable || (viewing && index < stepIndex);
      this.byPath.set(keyPath, row);
      const key = this.batchKey(partId, item.colorId, row.dimmed, this.collisionPaths.has(keyPath));
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
      return [row];
    });
    this.tree.update(this.rows, [...this.byPath.keys()]);
    this.instanceRows.clear();
    this.rows.forEach((row, index) => {
      for (const id of row.path) {
        const list = this.instanceRows.get(id) ?? [];
        list.push(index);
        this.instanceRows.set(id, list);
      }
    });
    const changedRows = this.rows.filter((row, index) => row !== previousOrder[index]);
    const sameOrder =
      this.rows.length === previousOrder.length &&
      this.rows.every((row, index) => row.path === previousOrder[index]?.path);
    if (sameOrder && changedRows.length <= 64) {
      for (const row of changedRows) {
        const before = previousRows.get(pathKey(row.path))!;
        for (let depth = 1; depth <= row.path.length; depth++) {
          const list = this.byPrefix.get(pathKey(row.path.slice(0, depth)))!;
          list[list.indexOf(before)] = row;
        }
      }
    } else {
      this.byPrefix.clear();
      for (const row of this.rows) {
        let prefix = '';
        for (const id of row.path) {
          prefix = prefix ? `${prefix}/${id}` : id;
          const list = this.byPrefix.get(prefix);
          if (list) list.push(row);
          else this.byPrefix.set(prefix, [row]);
        }
      }
    }
    this.stats.boundsRefits = this.tree.stats.refits;
    this.stats.matrixWrites = 0;
    for (const [key, batch] of this.batches) {
      if (!groups.has(key)) {
        this.releaseBatch(batch);
        this.batches.delete(key);
      }
    }
    for (const [key, rows] of groups) {
      const first = rows[0]!;
      const definition = this.definitions.get(first.partId)!;
      const color = byColor.get(first.colorId) ?? colors.find((entry) => entry.ldrawCode === 71);
      if (!color) continue;
      let batch = this.batches.get(key);
      if (!batch || batch.capacity < rows.length || batch.definition !== definition) {
        if (batch) this.releaseBatch(batch);
        const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(rows.length)));
        const materials = definition.mesh.batches.map((entry) => {
          const material = partMaterial(
            entry.color === 'main' ? color : (colors.find((value) => value.ldrawCode === entry.color) ?? color),
            definition.mesh.doubleSided,
          );
          if (definition.mesh === this.loading) {
            material.color.set('#9299a3');
            material.roughness = 0.8;
          }
          if (first.dimmed) {
            dimContextColor(material.color);
            material.transparent = true;
            material.opacity *= 0.85;
          }
          if (this.collisionPaths.has(pathKey(first.path))) {
            material.transparent = true;
            material.opacity = 0.38;
            material.depthWrite = false;
          }
          return material;
        });
        const object = new InstancedMesh(batchGeometry(definition.geometry), materials, capacity);
        const mask = new InstancedMesh(
          batchGeometry(definition.geometry),
          new MeshBasicMaterial({ color: 'white', toneMapped: false, side: DoubleSide }),
          capacity,
        );
        object.name = key;
        object.instanceMatrix.setUsage(DynamicDrawUsage);
        mask.instanceMatrix.setUsage(DynamicDrawUsage);
        const edgeGeometry = new InstancedBufferGeometry();
        edgeGeometry.setAttribute('position', new BufferAttribute(definition.edges, 3));
        for (let column = 0; column < 4; column++)
          edgeGeometry.setAttribute(
            `transform${column}`,
            new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(DynamicDrawUsage),
          );
        const edgeMaterial = new LineBasicNodeMaterial({
          color: this.collisionPaths.has(pathKey(first.path)) ? '#f0616d' : color.edgeRgb,
          transparent: color.alpha < 1,
          opacity: color.alpha < 1 ? 0.5 : 1,
        });
        edgeMaterial.positionNode = mat4(
          attribute('transform0', 'vec4'),
          attribute('transform1', 'vec4'),
          attribute('transform2', 'vec4'),
          attribute('transform3', 'vec4'),
        ).mul(vec4(positionLocal, 1)).xyz;
        const lines = new LineSegments(edgeGeometry, edgeMaterial);
        batch = {
          object,
          mask,
          lines,
          paths: [],
          rows: [],
          capacity,
          definition,
          maskState: [],
          bounds: new Box3(),
          maxScale: 1,
          edgeShown: true,
        };
        this.batches.set(key, batch);
        this.root.add(object, lines);
        this.maskRoot.add(mask);
        this.stats.allocations++;
      }
      let boundsChanged = batch.rows.length !== rows.length;
      rows.forEach((row, index) => {
        const before = batch.rows[index];
        if (!before || before.visible !== row.visible || !before.matrix.equals(row.matrix)) {
          batch.maxScale = Math.max(batch.maxScale, row.matrix.getMaxScaleOnAxis());
          boundsChanged = true;
          batch.object.setMatrixAt(index, row.visible ? row.matrix : zero);
          markRange(batch.object.instanceMatrix, index * 16, 16);
          batch.object.instanceMatrix.needsUpdate = true;
          const e = (row.visible ? row.matrix : zero).elements;
          for (let column = 0; column < 4; column++) {
            const attr = batch.lines.geometry.getAttribute(`transform${column}`) as InstancedBufferAttribute;
            attr.setXYZW(index, e[column * 4]!, e[column * 4 + 1]!, e[column * 4 + 2]!, e[column * 4 + 3]!);
            markRange(attr, index * 4, 4);
            attr.needsUpdate = true;
          }
          this.stats.matrixWrites++;
        }
        this.rowBatches.set(row, batch);
        this.rowSlots.set(row, index);
      });
      batch.object.count = rows.length;
      (batch.lines.geometry as InstancedBufferGeometry).instanceCount = rows.length;
      batch.paths = rows.map((row) => row.path);
      batch.rows = rows;
      if (boundsChanged) {
        batch.bounds.makeEmpty();
        for (const row of rows) if (row.visible) batch.bounds.union(row.bounds);
        batch.object.boundingBox = batch.bounds.clone();
        batch.object.boundingSphere = batch.bounds.getBoundingSphere(new Sphere());
        // Edge vertices are transformed in the shader: culling must use instance bounds.
        batch.lines.geometry.boundingBox = batch.bounds.clone();
        batch.lines.geometry.boundingSphere = batch.object.boundingSphere.clone();
      }
    }
    this.stats.batches = this.batches.size;
    const merge = new Set(this.rows.map((row) => row.partId)).size >= 64;
    this.merging = merge;
    if (merge) {
      this.root.add(this.merged.root);
      this.merged.sync(
        [...this.batches.values()].flatMap((batch) => {
          batch.object.visible = false;
          this.root.remove(batch.object, batch.lines);
          const materials = batch.object.material as MeshStandardMaterial[];
          return [
            ...batch.definition.surfaces.map((geometry, index) => ({
              geometry,
              material: materials[index]!,
              rows: batch.rows,
            })),
            {
              geometry: batch.lines.geometry,
              material: batch.lines.material as LineBasicNodeMaterial,
              rows: batch.rows,
              lines: true,
            },
          ];
        }),
        this.loadedCount === this.rows.length,
      );
      for (const batch of this.batches.values()) this.merged.edges(batch.rows, batch.edgeShown);
    } else {
      this.merged.clear();
      for (const batch of this.batches.values()) {
        batch.object.visible = true;
        if (batch.object.parent !== this.root) this.root.add(batch.object);
        if (batch.lines.parent !== this.root) this.root.add(batch.lines);
      }
    }
    const active = new Set(this.rows.map((row) => row.partId));
    for (const id of this.sources.keys()) if (!active.has(id)) this.sources.delete(id);
    const unused = [...this.definitions.keys()].filter((id) => !active.has(id));
    // Bound dormant derived geometry/BVH memory. The desktop owns source meshes and
    // does not re-register them on tab switches, so keep references for lazy rebuilding.
    for (const id of unused.slice(0, Math.max(0, unused.length - 64))) {
      const definition = this.definitions.get(id)!;
      if (definition.mesh !== this.loading) {
        definition.geometry.dispose();
        definition.surfaces.forEach((geometry) => geometry.dispose());
      }
      this.definitions.delete(id);
    }
    this.stats.cachedDefinitions = this.definitions.size;
    this.lastDocument = document;
    this.highlight(workspace.selection, workspace.selection.at(-1), this.hovered);
    this.stats.syncMs = performance.now() - started;
    this.stats.syncWorkMs = this.stats.syncMs;
  }

  highlight(selection: InstancePath[], primary: InstancePath | undefined, hovered: InstancePath | null): void {
    this.selected = selection;
    this.primary = primary;
    this.hovered = hovered;
    const kinds = new Map<ProjectedRow, number>();
    if (hovered) for (const row of this.byPrefix.get(pathKey(hovered)) ?? []) if (row.visible) kinds.set(row, 3);
    for (const path of selection)
      for (const row of this.byPrefix.get(pathKey(path)) ?? [])
        if (row.visible) kinds.set(row, primary && pathStartsWith(row.path, primary) ? 2 : 1);
    const masks = new Map<Batch, { row: ProjectedRow; kind: number }[]>();
    for (const [row, kind] of kinds) {
      const batch = this.rowBatches.get(row);
      if (!batch) continue;
      const list = masks.get(batch) ?? [];
      list.push({ row, kind });
      masks.set(batch, list);
    }
    for (const batch of this.batches.values()) {
      let changed = false;
      let maskIndex = 0;
      (masks.get(batch) ?? []).forEach(({ row, kind }) => {
        const index = maskIndex++;
        const before = batch.maskState[index];
        if (before?.kind === kind && (!kind || before.matrix.equals(row.matrix))) return;
        batch.mask.setMatrixAt(index, kind ? row.matrix : zero);
        markRange(batch.mask.instanceMatrix, index * 16, 16);
        batch.mask.setColorAt(index, new Color(kind === 1 ? 1 : 0, kind === 2 ? 1 : 0, kind === 3 ? 1 : 0));
        if (batch.mask.instanceColor) markRange(batch.mask.instanceColor, index * 3, 3);
        batch.maskState[index] = { kind, matrix: row.matrix };
        changed = true;
      });
      batch.mask.count = maskIndex;
      batch.mask.visible = maskIndex > 0;
      if (maskIndex > 0 && batch.mask.parent !== this.maskRoot) this.maskRoot.add(batch.mask);
      else if (maskIndex === 0) this.maskRoot.remove(batch.mask);
      // The content batch is a conservative bound for its selected subset.
      batch.mask.boundingBox = batch.object.boundingBox;
      batch.mask.boundingSphere = batch.object.boundingSphere;
      if (changed) {
        batch.mask.instanceMatrix.needsUpdate = true;
        if (batch.mask.instanceColor) batch.mask.instanceColor.needsUpdate = true;
      }
    }
  }
  get hasHighlight(): boolean {
    return this.selected.length > 0 || this.hovered !== null;
  }
  /** Subpixel edges add noise and vertex work in distant large scenes. Keep them at close
   * range, in small models, and whenever callers explicitly request full detail. */
  prepareRender(camera: PerspectiveCamera | OrthographicCamera, height: number): void {
    this.root.updateWorldMatrix(true, false);
    const position = camera.position.clone().applyMatrix4(this.root.matrixWorld.clone().invert());
    const point = new Vector3();
    for (const batch of this.batches.values()) {
      let show = true;
      if (this.edgeMode === 'auto' && this.rows.length >= 1000 && !batch.bounds.isEmpty()) {
        const size = batch.definition.bounds.getSize(point).length() * batch.maxScale;
        const distance = Math.max(1, batch.bounds.distanceToPoint(position));
        const span =
          'isOrthographicCamera' in camera
            ? (camera.top - camera.bottom) / camera.zoom
            : 2 * distance * Math.tan((camera.fov * Math.PI) / 360);
        const pixels = (size * height) / span;
        // Hysteresis avoids flickering near the boundary while orbiting.
        show = pixels >= (batch.edgeShown ? 3 : 4);
      }
      if (this.merging && batch.edgeShown !== show) this.merged.edges(batch.rows, show);
      batch.edgeShown = show;
      batch.lines.visible = !this.merging && show;
    }
  }
  bounds(paths?: InstancePath[]): Box3 {
    const bounds = new Box3();
    if (paths) {
      for (const path of paths)
        for (const row of path.length ? (this.byPrefix.get(pathKey(path)) ?? []) : this.rows)
          if (row.visible) bounds.union(row.bounds);
    } else for (const row of this.rows) if (row.visible) bounds.union(row.bounds);
    return bounds;
  }
  pick(ray: Ray, editableOnly = true): ProjectedRow | null {
    const started = performance.now();
    this.stats.pickCandidates = 0;
    let nearest = Infinity;
    let result: ProjectedRow | null = null;
    const hitPoint = new Vector3();
    this.tree.query(ray, (row) => {
      if (!row.visible || (editableOnly && !row.editable)) return;
      const definition = this.definitions.get(row.partId)!;
      const local = ray.clone().applyMatrix4(row.matrix.clone().invert());
      const hit = definition.bvh.raycastFirst(local, DoubleSide);
      if (!hit) return;
      hitPoint.copy(hit.point).applyMatrix4(row.matrix);
      const distance = hitPoint.distanceToSquared(ray.origin);
      if (distance < nearest) {
        nearest = distance;
        result = row;
      }
    });
    this.stats.pickCandidates = this.tree.stats.candidates;
    this.stats.pickMs = performance.now() - started;
    return result;
  }
  private releaseBatch(batch: Batch): void {
    this.root.remove(batch.object, batch.lines);
    this.maskRoot.remove(batch.mask);
    // Dispose before materials, while the renderer still knows this mesh's node attributes.
    batch.object.geometry.dispose();
    batch.mask.geometry.dispose();
    batch.object.dispose();
    batch.mask.dispose();
    const materials = Array.isArray(batch.object.material) ? batch.object.material : [batch.object.material];
    materials.forEach((material) => material.dispose());
    (batch.mask.material as MeshBasicMaterial).dispose();
    batch.lines.geometry.dispose();
    (batch.lines.material as LineBasicNodeMaterial).dispose();
  }
  dispose(): void {
    this.previewCollisions([]);
    this.merged.clear();
    this.batches.forEach((batch) => this.releaseBatch(batch));
    new Set([...this.definitions.values(), ...(this.loadingDefinition ? [this.loadingDefinition] : [])]).forEach(
      (definition) => {
        definition.geometry.dispose();
        definition.surfaces.forEach((geometry) => geometry.dispose());
      },
    );
    this.loadingDefinition = undefined;
    this.batches.clear();
    this.definitions.clear();
    this.sources.clear();
    this.rows = [];
    this.byPath.clear();
    this.byPrefix.clear();
    this.occurrences.clear();
    this.tree.clear();
    this.lastDocument = undefined;
  }
}
