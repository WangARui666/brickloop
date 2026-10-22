import { type Budget, integer } from './limits.js';

const STRIDE = 2_097_152,
  OFFSET = 1_048_576;
export function key(x: number, z: number) {
  return (x + OFFSET) * STRIDE + z + OFFSET;
}
export function unkey(k: number): [number, number] {
  return [Math.floor(k / STRIDE) - OFFSET, (k % STRIDE) - OFFSET];
}
/** Sparse 16×16 chunks per plate layer: 4 bytes/cell in occupied chunks, no per-cell objects. */
export class Voxels {
  readonly layers = new Map<number, Map<number, Uint32Array>>();
  readonly colors: string[] = [''];
  private readonly colorIds = new Map<string, number>();
  size = 0;
  constructor(readonly budget: Budget) {}
  get(x: number, y: number, z: number): number {
    const cx = Math.floor(x / 16),
      cz = Math.floor(z / 16);
    return this.layers.get(y)?.get(key(cx, cz))?.[(z - cz * 16) * 16 + x - cx * 16] ?? 0;
  }
  set(x: number, y: number, z: number, color: string | null) {
    integer(x, 'cell.x');
    integer(y, 'cell.y');
    integer(z, 'cell.z');
    const cx = Math.floor(x / 16),
      cz = Math.floor(z / 16),
      k = key(cx, cz),
      i = (z - cz * 16) * 16 + x - cx * 16;
    let layer = this.layers.get(y),
      chunk = layer?.get(k);
    if (color === null && !chunk) return;
    if (!layer) {
      layer = new Map();
      this.layers.set(y, layer);
      this.budget.memory(256);
    }
    if (!chunk) {
      chunk = new Uint32Array(256);
      layer.set(k, chunk);
      this.budget.memory(2048);
    }
    let c = 0;
    if (color !== null) {
      c = this.colorIds.get(color) ?? this.colors.length;
      if (!this.colorIds.has(color)) {
        this.colorIds.set(color, c);
        this.colors.push(color);
        this.budget.memory(128 + color.length * 2);
      }
    }
    const delta = Number(c !== 0) - Number(chunk[i] !== 0);
    this.budget.voxel(delta);
    this.size += delta;
    chunk[i] = c;
  }
  *cells(y: number): Generator<[number, number, number]> {
    for (const [k, chunk] of this.layers.get(y) ?? []) {
      const [cx, cz] = unkey(k);
      for (let i = 0; i < 256; i++) if (chunk[i]) yield [cx * 16 + (i % 16), cz * 16 + Math.floor(i / 16), chunk[i]!];
    }
  }
  sortedLevels() {
    return [...this.layers.keys()].sort((a, b) => a - b);
  }
}
