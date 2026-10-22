import {
  Box3,
  BufferAttribute,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  LineBasicNodeMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  MeshBasicNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu';
import type { BufferGeometry, OrthographicCamera, PerspectiveCamera } from 'three/webgpu';
import { attribute, mat4, max, min, positionGeometry, positionLocal, uniform, vec3, vec4 } from 'three/tsl';
import type { InstancePath } from '@brickloop/core';
import { fromLDraw, pathStartsWith } from '@brickloop/core';
import type { DocumentProjection, ProjectedRow } from './document-projection';
import { BoundsOverlay } from './bounds-overlay';
import { disposeObjects } from './scene-content';
import { reviewColors } from './theme';

export interface ReviewOverlay {
  added: InstancePath[];
  changed: InstancePath[];
  moved: { path: InstancePath; from: number[] }[];
  ghosts: {
    partId?: string;
    modelId?: string;
    colorId: string;
    transform: number[];
    kind: 'removed' | 'movedFrom';
    bounds?: number[];
  }[];
  focus?: InstancePath | number | null;
  visible: boolean;
}
interface MaskBatch {
  mesh: InstancedMesh;
  rows: { row: ProjectedRow; color: Color; selected: boolean }[];
}

/** Data changes rebuild batches; orbit frames only update one arrow-size uniform. */
export class ReviewLayer {
  readonly root = new Group();
  readonly maskRoot = new Group();
  private readonly marks = new Group();
  private readonly focus = new BoundsOverlay('#ffffff');
  private readonly removed = new BoundsOverlay(reviewColors.removed);
  private readonly moved = new BoundsOverlay(reviewColors.movedFrom);
  private readonly arrowPixel = uniform(1);
  private maskBatches: MaskBatch[] = [];
  private selection: InstancePath[] = [];
  private overlay: ReviewOverlay | null = null;
  private ghostBounds: Box3[] = [];
  boxGhosts = 0;
  updates = 0;
  constructor(private readonly projection: DocumentProjection) {
    this.root.visible = this.maskRoot.visible = false;
    this.root.add(this.marks, this.focus.root, this.removed.root, this.moved.root);
  }
  get hasOutline(): boolean {
    return this.maskRoot.visible && this.maskBatches.length > 0;
  }
  private bounds(ghost: ReviewOverlay['ghosts'][number]): Box3 {
    const source = ghost.bounds;
    const local = source
      ? new Box3(new Vector3(source[0], source[1], source[2]), new Vector3(source[3], source[4], source[5]))
      : (this.projection.definitions.get(ghost.partId ?? '')?.bounds.clone() ??
        new Box3(new Vector3(-10, -24, -10), new Vector3(10, 0, 10)));
    return local.applyMatrix4(new Matrix4().fromArray(fromLDraw(ghost.transform)));
  }
  private geometry(partId: string): BufferGeometry {
    const source = this.projection.definitions.get(partId)!.geometry;
    // Review masks and ghosts are disposed independently of the live document.
    // Own their attributes so disposal cannot invalidate the live GPU index buffer.
    return source.clone();
  }
  setSelection(selection: InstancePath[]): void {
    this.selection = selection;
    const selected = new Set(selection.map((path) => path.join('/')));
    const black = new Color(0);
    for (const batch of this.maskBatches) {
      let changed = false;
      batch.rows.forEach((entry, index) => {
        const active = entry.row.path.some((_, depth) => selected.has(entry.row.path.slice(0, depth + 1).join('/')));
        if (entry.selected === active) return;
        entry.selected = active;
        batch.mesh.setColorAt(index, active ? black : entry.color);
        changed = true;
      });
      if (changed && batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
    }
  }
  set(overlay: ReviewOverlay | null): void {
    const previous = this.overlay;
    this.overlay = overlay;
    this.root.visible = this.maskRoot.visible = !!overlay?.visible;
    const unchanged =
      previous &&
      overlay &&
      previous.added === overlay.added &&
      previous.changed === overlay.changed &&
      previous.moved === overlay.moved &&
      previous.ghosts === overlay.ghosts;
    if (!unchanged) {
      this.updates++;
      disposeObjects(this.marks);
      disposeObjects(this.maskRoot);
      this.maskBatches = [];
      this.boxGhosts = 0;
      this.ghostBounds = [];
      const paths = [overlay?.added ?? [], overlay?.changed ?? [], overlay?.moved.map((row) => row.path) ?? []].map(
        (rows) => new Set(rows.map((path) => path.join('/'))),
      );
      const masks = new Map<string, MaskBatch['rows']>();
      for (const row of this.projection.rows) {
        if (!row.visible) continue;
        const channels = paths.map((set) =>
          row.path.some((_, index) => set.has(row.path.slice(0, index + 1).join('/'))) ? 1 : 0,
        );
        if (!channels.some(Boolean)) continue;
        const rows = masks.get(row.partId) ?? [];
        rows.push({ row, color: new Color(channels[0]!, channels[1]!, channels[2]!), selected: false });
        masks.set(row.partId, rows);
      }
      for (const [partId, rows] of masks) {
        const mesh = new InstancedMesh(
          this.geometry(partId),
          new MeshBasicMaterial({ color: 'white', side: DoubleSide, toneMapped: false }),
          rows.length,
        );
        rows.forEach((entry, index) => {
          mesh.setMatrixAt(index, entry.row.matrix);
          mesh.setColorAt(index, entry.color);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.needsUpdate = true;
        mesh.computeBoundingSphere();
        this.maskRoot.add(mesh);
        this.maskBatches.push({ mesh, rows });
      }
      this.setSelection(this.selection);
      const boxes = { removed: [] as Box3[], movedFrom: [] as Box3[] };
      const ghosts = new Map<
        string,
        { partId: string; kind: ReviewOverlay['ghosts'][number]['kind']; matrices: Matrix4[] }
      >();
      overlay?.ghosts.forEach((ghost, index) => {
        const bounds = this.bounds(ghost);
        this.ghostBounds.push(bounds);
        if (index < 500 && ghost.partId && this.projection.isRegistered(ghost.partId)) {
          const key = `${ghost.partId}/${ghost.kind}`;
          const batch = ghosts.get(key) ?? { partId: ghost.partId, kind: ghost.kind, matrices: [] };
          batch.matrices.push(new Matrix4().fromArray(fromLDraw(ghost.transform)));
          ghosts.set(key, batch);
        } else {
          this.boxGhosts++;
          boxes[ghost.kind].push(bounds);
        }
      });
      for (const batch of ghosts.values()) {
        const color = reviewColors[batch.kind];
        const mesh = new InstancedMesh(
          this.geometry(batch.partId),
          new MeshBasicMaterial({
            color,
            opacity: 0.35,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            side: DoubleSide,
            toneMapped: false,
          }),
          batch.matrices.length,
        );
        batch.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.renderOrder = 10;
        this.marks.add(mesh);
        if (batch.kind === 'removed') {
          // Instanced real part edges distinguish a deletion ghost from a red live brick.
          const geometry = new InstancedBufferGeometry();
          geometry.setAttribute(
            'position',
            new BufferAttribute(this.projection.definitions.get(batch.partId)!.edges, 3),
          );
          for (let column = 0; column < 4; column++) {
            const data = new Float32Array(batch.matrices.length * 4);
            batch.matrices.forEach((matrix, index) =>
              data.set(matrix.elements.slice(column * 4, column * 4 + 4), index * 4),
            );
            geometry.setAttribute(`transform${column}`, new InstancedBufferAttribute(data, 4));
          }
          geometry.instanceCount = batch.matrices.length;
          const material = new LineBasicNodeMaterial({
            color,
            opacity: 0.85,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
          });
          material.positionNode = mat4(
            attribute('transform0', 'vec4'),
            attribute('transform1', 'vec4'),
            attribute('transform2', 'vec4'),
            attribute('transform3', 'vec4'),
          ).mul(vec4(positionLocal, 1)).xyz;
          const edges = new LineSegments(geometry, material);
          edges.frustumCulled = false;
          edges.renderOrder = 11;
          this.marks.add(edges);
        }
      }
      this.removed.set(boxes.removed);
      this.moved.set(boxes.movedFrom);
      const arrows: { matrix: Matrix4; length: number }[] = [];
      const rows = new Map(this.projection.rows.map((row) => [row.path.join('/'), row]));
      const oldBounds = new Map(
        overlay?.ghosts.map((ghost, index) => [ghost.transform.join(','), this.ghostBounds[index]!]),
      );
      const y = new Vector3(0, 1, 0);
      for (const movement of overlay?.moved ?? []) {
        const current = this.projection.bounds([movement.path]);
        if (current.isEmpty()) continue;
        const row = rows.get(movement.path.join('/'));
        const old =
          oldBounds.get(movement.from.join(','))?.getCenter(new Vector3()) ??
          (row
            ? this.projection.definitions
                .get(row.partId)
                ?.bounds.clone()
                .applyMatrix4(new Matrix4().fromArray(fromLDraw(movement.from)))
                .getCenter(new Vector3())
            : new Vector3(...movement.from.slice(0, 3)));
        if (!old) continue;
        const direction = current.getCenter(new Vector3()).sub(old),
          length = direction.length();
        if (length < 0.001) continue;
        arrows.push({
          matrix: new Matrix4().compose(
            old,
            new Quaternion().setFromUnitVectors(y, direction.normalize()),
            new Vector3(1, 1, 1),
          ),
          length,
        });
      }
      if (arrows.length)
        for (const cone of [false, true]) {
          const geometry = cone ? new ConeGeometry(1, 1, 8) : new CylinderGeometry(1, 1, 1, 6);
          geometry.translate(0, 0.5, 0);
          geometry.setAttribute(
            'arrowLength',
            new InstancedBufferAttribute(new Float32Array(arrows.map((arrow) => arrow.length)), 1),
          );
          for (let column = 0; column < 4; column++) {
            const data = new Float32Array(arrows.length * 4);
            arrows.forEach((arrow, index) =>
              data.set(arrow.matrix.elements.slice(column * 4, column * 4 + 4), index * 4),
            );
            geometry.setAttribute(`arrowTransform${column}`, new InstancedBufferAttribute(data, 4));
          }
          const length = attribute('arrowLength', 'float'),
            head = min(length.mul(0.28), this.arrowPixel.mul(12));
          const radius = cone ? head.mul(0.4) : min(length.mul(0.045), this.arrowPixel.mul(1.35));
          const material = new MeshBasicNodeMaterial({
            color: reviewColors.movedFrom,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
          });
          const local = vec3(
            positionGeometry.x.mul(radius),
            cone
              ? length.sub(head).add(positionGeometry.y.mul(head))
              : positionGeometry.y.mul(max(length.sub(head), 0)),
            positionGeometry.z.mul(radius),
          );
          // positionNode runs after Three's instance transform. Start from raw geometry
          // and apply the arrow frame once, after its pixel-sized local dimensions.
          material.positionNode = mat4(
            attribute('arrowTransform0', 'vec4'),
            attribute('arrowTransform1', 'vec4'),
            attribute('arrowTransform2', 'vec4'),
            attribute('arrowTransform3', 'vec4'),
          ).mul(vec4(local, 1)).xyz;
          const mesh = new InstancedMesh(geometry, material, arrows.length);
          arrows.forEach((arrow, index) => mesh.setMatrixAt(index, arrow.matrix));
          mesh.instanceMatrix.needsUpdate = true;
          mesh.frustumCulled = false;
          mesh.renderOrder = 14;
          this.marks.add(mesh);
        }
    }
    const focused = overlay?.focus;
    const bounds =
      typeof focused === 'number' ? this.ghostBounds[focused] : focused ? this.projection.bounds([focused]) : undefined;
    const selected = Array.isArray(focused) && this.selection.some((path) => pathStartsWith(focused, path));
    this.focus.set(!selected && bounds && !bounds.isEmpty() ? [bounds.clone().expandByScalar(1)] : []);
  }
  prepareRender(camera: PerspectiveCamera | OrthographicCamera, height: number, distance: number): void {
    this.arrowPixel.value =
      ('isOrthographicCamera' in camera
        ? (camera.top - camera.bottom) / camera.zoom
        : 2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, height);
  }
  fitGhost(index: number): Box3 | undefined {
    return this.ghostBounds[index]?.clone();
  }
  dispose(): void {
    disposeObjects(this.marks);
    disposeObjects(this.maskRoot);
    this.maskBatches = [];
    this.focus.dispose();
    this.removed.dispose();
    this.moved.dispose();
    this.root.clear();
  }
}
