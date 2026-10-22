import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  Group,
  LineBasicNodeMaterial,
  LineSegments,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
  RGBAFormat,
  Sphere,
  Box3,
} from 'three/webgpu';
import {
  attribute,
  int,
  ivec2,
  mat3,
  mat4,
  modelNormalMatrix,
  normalLocal,
  positionLocal,
  textureLoad,
  vec4,
} from 'three/tsl';
import type { ProjectedRow } from './document-projection';

interface Input {
  geometry: BufferGeometry;
  material: MeshStandardMaterial | LineBasicNodeMaterial;
  rows: ProjectedRow[];
  lines?: boolean;
}
interface Slot {
  draw: Draw;
  index: number;
  matrix: Matrix4;
  visible: boolean;
  edgesVisible: boolean;
  hidden: boolean;
}
interface Draw {
  object: Mesh | LineSegments;
  texture: DataTexture;
  data: Float32Array;
  lines: boolean;
}
const zero = new Matrix4().makeScale(0, 0, 0);
const materialKey = (input: Input) => {
  const m = input.material;
  return JSON.stringify([
    input.lines,
    m.color.getHex(),
    m.opacity,
    m.transparent,
    m.depthWrite,
    m.side,
    m instanceof MeshStandardMaterial ? [m.metalness, m.roughness, m.emissive.getHex(), m.emissiveIntensity] : null,
  ]);
};

/** One indexed draw per material. A vertex carries its occurrence slot; matrix textures
 * let a gesture update one slot without transforming/copying the static vertex buffers.
 * This also works on backends that implement BatchedMesh multi-draw as a CPU draw loop. */
class MaterialBatchPage {
  readonly root = new Group();
  private signature = '';
  private draws: Draw[] = [];
  private byPath = new Map<string, Slot[]>();
  sync(inputs: Input[]) {
    const groups = new Map<string, Input[]>();
    for (const input of inputs) {
      if (!input.geometry.getAttribute('position').count) continue;
      const key = materialKey(input),
        list = groups.get(key) ?? [];
      list.push(input);
      groups.set(key, list);
    }
    const signature = JSON.stringify(
      [...groups].map(([key, list]) => [
        key,
        list.map((item) => [item.geometry.uuid, item.rows.map((row) => row.path.join('/'))]),
      ]),
    );
    if (signature === this.signature) {
      for (const input of inputs) for (const row of input.rows) this.update(row);
      return;
    }
    this.clear();
    this.signature = signature;
    for (const list of groups.values()) {
      const lines = list[0]!.lines === true;
      const count = list.reduce((n, item) => n + item.rows.length, 0);
      const vertices = list.reduce((n, item) => n + item.geometry.getAttribute('position').count * item.rows.length, 0);
      const indexCount = list.reduce(
        (n, item) =>
          n + (item.geometry.index?.count ?? item.geometry.getAttribute('position').count) * item.rows.length,
        0,
      );
      const positions = new Float32Array(vertices * 3),
        normals = lines ? undefined : new Float32Array(vertices * 3);
      const slots = new Float32Array(vertices),
        indices = new Uint32Array(indexCount);
      // Eight texels per slot: four matrix columns, three inverse-transpose normal columns.
      const data = new Float32Array(32 * Math.max(1, count));
      const texture = new DataTexture(data, 8, Math.max(1, count), RGBAFormat, FloatType);
      texture.onUpdate = () => texture.clearUpdateRanges();
      texture.needsUpdate = true;
      const material = lines
        ? new LineBasicNodeMaterial().copy(list[0]!.material as LineBasicNodeMaterial)
        : new MeshStandardNodeMaterial().copy(list[0]!.material as MeshStandardMaterial);
      const slotNode = int(attribute('shapeSlot', 'float'));
      const column = (x: number) => textureLoad(texture, ivec2(x, slotNode));
      material.positionNode = mat4(column(0), column(1), column(2), column(3)).mul(vec4(positionLocal, 1)).xyz;
      if (material instanceof MeshStandardNodeMaterial) {
        material.normalNode = modelNormalMatrix
          .mul(mat3(column(4).xyz, column(5).xyz, column(6).xyz).mul(normalLocal))
          .toVarying()
          .normalize();
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      if (normals) geometry.setAttribute('normal', new BufferAttribute(normals, 3));
      geometry.setAttribute('shapeSlot', new BufferAttribute(slots, 1));
      geometry.setIndex(new BufferAttribute(indices, 1));
      const object = lines ? new LineSegments(geometry, material) : new Mesh(geometry, material);
      const draw: Draw = { object, texture, data, lines };
      this.draws.push(draw);
      this.root.add(object);
      const bounds = new Box3();
      let vertex = 0,
        index = 0,
        slotIndex = 0;
      for (const input of list)
        for (const row of input.rows) {
          const source = input.geometry,
            p = source.getAttribute('position');
          positions.set(p.array, vertex * 3);
          if (normals) normals.set(source.getAttribute('normal').array, vertex * 3);
          slots.fill(slotIndex, vertex, vertex + p.count);
          if (source.index) for (const value of source.index.array) indices[index++] = vertex + value;
          else for (let i = 0; i < p.count; i++) indices[index++] = vertex + i;
          const slot: Slot = {
            draw,
            index: slotIndex++,
            matrix: row.matrix.clone(),
            visible: row.visible,
            edgesVisible: true,
            hidden: false,
          };
          this.write(slot);
          const key = row.path.join('/'),
            entries = this.byPath.get(key) ?? [];
          entries.push(slot);
          this.byPath.set(key, entries);
          if (row.visible) bounds.union(row.bounds);
          vertex += p.count;
        }
      geometry.boundingBox = bounds;
      geometry.boundingSphere = bounds.getBoundingSphere(new Sphere());
    }
  }
  private write(slot: Slot) {
    const { draw, index } = slot;
    const matrix = slot.visible && slot.edgesVisible && !slot.hidden ? slot.matrix : zero;
    draw.data.set(matrix.elements, index * 32);
    if (!draw.lines) {
      const n = new Matrix3().getNormalMatrix(matrix).elements;
      for (let col = 0; col < 3; col++) draw.data.set(n.slice(col * 3, col * 3 + 3), index * 32 + 16 + col * 4);
    }
    draw.texture.addUpdateRange(index * 32, 32);
    draw.texture.needsUpdate = true;
  }
  update(row: ProjectedRow) {
    for (const slot of this.byPath.get(row.path.join('/')) ?? []) {
      if (slot.matrix.equals(row.matrix) && slot.visible === row.visible) continue;
      slot.matrix.copy(row.matrix);
      slot.visible = row.visible;
      this.write(slot);
      const geometry = slot.draw.object.geometry;
      geometry.boundingBox?.union(row.bounds);
      if (geometry.boundingBox) geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere());
    }
  }
  edges(rows: ProjectedRow[], visible: boolean) {
    for (const row of rows)
      for (const slot of this.byPath.get(row.path.join('/')) ?? []) {
        if (!slot.draw.lines || slot.edgesVisible === visible) continue;
        slot.edgesVisible = visible;
        this.write(slot);
      }
  }
  hide(path: string, hidden: boolean) {
    for (const slot of this.byPath.get(path) ?? []) {
      if (slot.hidden === hidden) continue;
      slot.hidden = hidden;
      this.write(slot);
    }
  }
  clear() {
    for (const { object, texture } of this.draws) {
      object.geometry.dispose();
      if (Array.isArray(object.material)) object.material.forEach((m) => m.dispose());
      else object.material.dispose();
      texture.dispose();
    }
    this.draws = [];
    this.byPath.clear();
    this.root.clear();
    this.signature = '';
  }
}

/** Stable pages keep completed definition ranges alive during progressive loading.
 * Once all definitions arrive, compact once into the final material draws. */
export class MaterialBatches {
  readonly root = new Group();
  private readonly compact = new MaterialBatchPage();
  private readonly pages = new Map<number, MaterialBatchPage>();
  private readonly parts = new Map<string, number>();
  private complete = false;
  sync(inputs: Input[], complete: boolean) {
    this.complete = complete;
    if (complete) {
      for (const page of this.pages.values()) {
        page.clear();
        this.root.remove(page.root);
      }
      this.pages.clear();
      if (this.compact.root.parent !== this.root) this.root.add(this.compact.root);
      this.compact.sync(inputs);
      return;
    }
    this.compact.clear();
    const groups = new Map<number, Input[]>();
    for (const input of inputs) {
      const rows = new Map<number, ProjectedRow[]>();
      for (const row of input.rows) {
        if (!this.parts.has(row.partId)) this.parts.set(row.partId, this.parts.size);
        const page = Math.floor(this.parts.get(row.partId)! / 128),
          list = rows.get(page) ?? [];
        list.push(row);
        rows.set(page, list);
      }
      for (const [page, subset] of rows) {
        const list = groups.get(page) ?? [];
        list.push({ ...input, rows: subset });
        groups.set(page, list);
      }
    }
    for (const [index, page] of this.pages)
      if (!groups.has(index)) {
        page.clear();
        this.root.remove(page.root);
        this.pages.delete(index);
      }
    for (const [index, list] of groups) {
      let page = this.pages.get(index);
      if (!page) {
        page = new MaterialBatchPage();
        this.pages.set(index, page);
        this.root.add(page.root);
      }
      page.sync(list);
    }
  }
  update(row: ProjectedRow) {
    if (this.complete) this.compact.update(row);
    else this.pages.get(Math.floor((this.parts.get(row.partId) ?? 0) / 128))?.update(row);
  }
  hide(path: string, hidden: boolean) {
    if (this.complete) this.compact.hide(path, hidden);
    else for (const page of this.pages.values()) page.hide(path, hidden);
  }
  edges(rows: ProjectedRow[], visible: boolean) {
    if (this.complete) this.compact.edges(rows, visible);
    else for (const page of this.pages.values()) page.edges(rows, visible);
  }
  clear() {
    this.compact.clear();
    for (const page of this.pages.values()) page.clear();
    this.pages.clear();
    this.parts.clear();
    this.root.clear();
    this.complete = false;
  }
}

export function geometryGroup(source: BufferGeometry, start: number, count: number) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', source.getAttribute('position'));
  geometry.setAttribute('normal', source.getAttribute('normal'));
  geometry.setIndex(new BufferAttribute(new Uint32Array(source.index!.array.slice(start, start + count)), 1));
  return geometry;
}
