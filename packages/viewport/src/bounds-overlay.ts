import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  LineDashedMaterial,
  LineSegments,
  Sphere,
  Vector3,
} from 'three/webgpu';

const corners = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
] as const;
const edges = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
] as const;

/** Preserve every unknown-collision box in one draw call. Update only changed boxes. */
export class BoundsOverlay {
  readonly root = new Group();
  private readonly lines = new LineSegments(
    new BufferGeometry(),
    new LineDashedMaterial({
      color: '#f5b83d',
      dashSize: 3,
      gapSize: 2,
      depthTest: false,
    }),
  );
  private previous: Box3[] = [];
  private capacity = 0;
  constructor(color = '#f5b83d') {
    this.lines.material.color.set(color);
    this.root.add(this.lines);
  }

  set(boxes: Box3[]): void {
    this.root.visible = boxes.length > 0;
    if (boxes.length > this.capacity) {
      this.capacity = 2 ** Math.ceil(Math.log2(Math.max(16, boxes.length)));
      this.lines.geometry.dispose();
      this.lines.geometry = new BufferGeometry();
      this.lines.geometry.setAttribute(
        'position',
        new BufferAttribute(new Float32Array(this.capacity * 72), 3).setUsage(DynamicDrawUsage),
      );
      this.lines.geometry.setAttribute(
        'lineDistance',
        new BufferAttribute(new Float32Array(this.capacity * 24), 1).setUsage(DynamicDrawUsage),
      );
      this.previous = [];
    }
    if (!boxes.length) {
      this.previous = [];
      return;
    }
    const geometry = this.lines.geometry;
    const positions = geometry.getAttribute('position') as BufferAttribute;
    const distances = geometry.getAttribute('lineDistance') as BufferAttribute;
    let changed = boxes.length !== this.previous.length;
    const a = new Vector3(),
      b = new Vector3();
    boxes.forEach((box, index) => {
      if (this.previous[index]?.equals(box)) return;
      changed = true;
      const vertex = (corner: readonly number[], point: Vector3) =>
        point.set(
          corner[0] ? box.max.x : box.min.x,
          corner[1] ? box.max.y : box.min.y,
          corner[2] ? box.max.z : box.min.z,
        );
      let distance = 0;
      edges.forEach(([from, to], edge) => {
        vertex(corners[from], a);
        vertex(corners[to], b);
        const offset = index * 24 + edge * 2;
        positions.setXYZ(offset, a.x, a.y, a.z);
        positions.setXYZ(offset + 1, b.x, b.y, b.z);
        distances.setX(offset, distance);
        distance += a.distanceTo(b);
        distances.setX(offset + 1, distance);
      });
      positions.addUpdateRange(index * 72, 72);
      distances.addUpdateRange(index * 24, 24);
    });
    if (changed) {
      positions.needsUpdate = true;
      distances.needsUpdate = true;
      geometry.setDrawRange(0, boxes.length * 24);
      geometry.boundingBox = new Box3();
      for (const box of boxes) geometry.boundingBox.union(box);
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
    }
    this.previous = boxes;
  }
  dispose(): void {
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    this.root.clear();
    this.previous = [];
  }
}
