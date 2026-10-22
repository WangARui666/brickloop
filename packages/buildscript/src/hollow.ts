import type { PackOptions } from './types.js';
import { key, unkey, type Voxels } from './voxels.js';

interface Outline {
  x: Map<number, number[]>;
  z: Map<number, number[]>;
  bytes: number;
}
/** Deleted cells retain their original colors. Neither thickening nor the core can
 * fill source air, openings, or any cell on the original exterior surface. */
export interface HollowPlan {
  thicken(): number;
  restoreCore(levels?: ReadonlySet<number>): number;
  acceptCore(): void;
  removeCore(): void;
  release(): void;
}
export function hollow(v: Voxels, opts: PackOptions): HollowPlan | undefined {
  if (!opts.hollow) return undefined;
  const shell = opts.shell ?? 1,
    support = opts.support ?? 6;
  const spacing = typeof support === 'number' ? support : support === false ? 0 : support.spacing;
  const width = typeof support === 'object' ? (support.width ?? 1) : 1;
  const bytes = v.size * 25;
  v.budget.memory(bytes);
  const removed = new Float64Array(v.size * 3),
    adaptive = new Uint8Array(v.size);
  let count = 0;
  const cache = new Map<number, Outline>();
  const outline = (y: number): Outline => {
    const cached = cache.get(y);
    if (cached) return cached;
    const out: Outline = { x: new Map(), z: new Map(), bytes: 0 };
    for (const [x, z] of v.cells(y)) {
      v.budget.check();
      for (const [rows, row, value] of [
        [out.x, z, x],
        [out.z, x, z],
      ] as const) {
        let values = rows.get(row);
        if (!values) {
          values = [];
          rows.set(row, values);
          v.budget.memory(128);
          out.bytes += 128;
        }
        values.push(value);
        v.budget.memory(16);
        out.bytes += 16;
      }
    }
    for (const rows of [out.x, out.z])
      for (const [row, values] of rows) {
        values.sort((a, b) => a - b);
        const runs: number[] = [];
        for (const value of values) {
          if (runs.length && runs.at(-1) === value) runs[runs.length - 1] = value + 1;
          else runs.push(value, value + 1);
        }
        rows.set(row, runs);
      }
    cache.set(y, out);
    return out;
  };
  const band = (coordinate: number, current: number[], neighbor: number[] | undefined): boolean => {
    if (!neighbor) return false;
    let i = 0;
    while (i < current.length && coordinate >= current[i + 1]!) i += 2;
    const left = current[i]!,
      right = current[i + 1]!;
    let overlap = 0,
      otherLeft = left,
      otherRight = right;
    for (let j = 0; j < neighbor.length; j += 2) {
      const shared = Math.min(right, neighbor[j + 1]!) - Math.max(left, neighbor[j]!);
      if (shared > overlap) {
        overlap = shared;
        otherLeft = neighbor[j]!;
        otherRight = neighbor[j + 1]!;
      }
    }
    return (
      overlap > 0 &&
      (coordinate < left + shell + Math.abs(left - otherLeft) ||
        coordinate >= right - shell - Math.abs(right - otherRight))
    );
  };
  // Compare scanline boundaries in both horizontal axes. A boundary that moves by
  // delta between layers retains shell + |delta| cells on its inside.
  for (const y of v.sortedLevels()) {
    for (const [old, entry] of cache)
      if (old < y - 1) {
        v.budget.memory(-entry.bytes);
        cache.delete(old);
      }
    const here = outline(y),
      below = outline(y - 1),
      above = outline(y + 1);
    for (const [x, z, color] of v.cells(y)) {
      v.budget.check();
      if (spacing && ((x % spacing) + spacing) % spacing < width && ((z % spacing) + spacing) % spacing < width)
        continue;
      let interior = true;
      for (let d = 1; d <= shell && interior; d++)
        interior = !!(
          v.get(x - d, y, z) &&
          v.get(x + d, y, z) &&
          v.get(x, y, z - d) &&
          v.get(x, y, z + d) &&
          v.get(x, y - d, z) &&
          v.get(x, y + d, z)
        );
      if (!interior) continue;
      removed[count * 3] = y;
      removed[count * 3 + 1] = key(x, z);
      removed[count * 3 + 2] = color;
      adaptive[count] = Number(
        [below, above].some(
          (other) => band(x, here.x.get(z)!, other.x.get(z)) || band(z, here.z.get(x)!, other.z.get(x)),
        ),
      );
      count++;
    }
  }
  for (const entry of cache.values()) v.budget.memory(-entry.bytes);
  cache.clear();
  const visit = (fn: (x: number, y: number, z: number, color: number, i: number) => void) => {
    for (let i = 0; i < count; i++) {
      v.budget.check();
      const [x, z] = unkey(removed[i * 3 + 1]!);
      fn(x, removed[i * 3]!, z, removed[i * 3 + 2]!, i);
    }
  };
  visit((x, y, z) => v.set(x, y, z, null));
  const restore = (core: boolean, levels?: ReadonlySet<number>) => {
    let added = 0;
    visit((x, y, z, color, i) => {
      if ((core ? !levels || levels.has(y) : !!(adaptive[i]! & 1)) && !v.get(x, y, z)) {
        v.set(x, y, z, v.colors[color]!);
        if (core) adaptive[i] = adaptive[i]! | 2;
        added++;
      }
    });
    return added;
  };
  return {
    thicken: () => restore(false),
    restoreCore: (levels) => restore(true, levels),
    acceptCore: () =>
      visit((_x, _y, _z, _color, i) => {
        adaptive[i] = adaptive[i]! & ~2;
      }),
    removeCore: () =>
      visit((x, y, z, _color, i) => {
        if (adaptive[i]! & 2) {
          v.set(x, y, z, null);
          adaptive[i] = adaptive[i]! & ~2;
        }
      }),
    release: () => v.budget.memory(-bytes),
  };
}
