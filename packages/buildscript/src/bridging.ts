import type { Budget } from './limits.js';
import { makePacked, repackRegion, type Candidate, type Packed } from './packing.js';
import { graph, type Graph } from './quality.js';
import { key } from './voxels.js';

/** Chunk index of part ownership, avoiding a Map entry for every occupied voxel. */
class PartIndex {
  private readonly layers = new Map<number, Map<number, number[]>>();
  private bytes = 0;
  constructor(
    readonly parts: Packed[],
    readonly budget: Budget,
  ) {
    parts.forEach((p, i) => {
      if (!Number.isInteger(p.x) || !Number.isInteger(p.z)) return;
      for (let y = p.y; y < p.y + p.h; y++) {
        budget.check();
        let layer = this.layers.get(y);
        if (!layer) {
          layer = new Map();
          this.layers.set(y, layer);
        }
        for (let z = Math.floor(p.z / 16); z <= Math.floor((p.z + p.d - 1) / 16); z++)
          for (let x = Math.floor(p.x / 16); x <= Math.floor((p.x + p.w - 1) / 16); x++) {
            const k = key(x, z);
            let ids = layer.get(k);
            if (!ids) {
              ids = [];
              layer.set(k, ids);
              budget.memory(128);
              this.bytes += 128;
            }
            ids.push(i);
            budget.memory(16);
            this.bytes += 16;
          }
      }
    });
  }
  at(x: number, y: number, z: number): number | undefined {
    return this.layers
      .get(y)
      ?.get(key(Math.floor(x / 16), Math.floor(z / 16)))
      ?.find((i) => {
        const p = this.parts[i]!;
        return x >= p.x && x < p.x + p.w && z >= p.z && z < p.z + p.d;
      });
  }
  dispose() {
    this.budget.memory(-this.bytes);
  }
}
function floatingVolume(parts: Packed[], g: Graph) {
  return g.floating.reduce(
    (sum, ids) =>
      sum +
      ids.reduce((n, i) => {
        const p = parts[i]!;
        return n + p.w * p.d * p.h;
      }, 0),
    0,
  );
}
export interface BridgeResult {
  parts: Packed[];
  graph: Graph;
  regions: number;
}
/** Join disconnected covers by inserting a catalog plate across a horizontal seam.
 * Intersected bricks may split into plate courses. Only their existing colored
 * volume is re-covered; explicit pieces and the silhouette remain untouched. */
export function bridgePacking(parts: Packed[], cs: Candidate[], budget: Budget): BridgeResult {
  let current = parts,
    g = graph(parts, budget),
    regions = 0,
    tests = 0,
    examined = 0;
  const maxTests = Math.max(8, Math.min(512, Math.floor(250_000 / Math.max(parts.length, 1))));
  const choices = cs
    .filter((c) => c.h === 1 && c.w * c.d > 1)
    .sort((a, b) => b.w * b.d - a.w * a.d || a.id.localeCompare(b.id) || a.rotY - b.rotY);
  while (g.floating.length && tests < maxTests && examined < 50_000) {
    budget.check();
    const index = new PartIndex(current, budget),
      component = new Int32Array(current.length);
    g.components.forEach((ids, c) => ids.forEach((i) => (component[i] = c)));
    const floating = new Set(g.floating.flat()),
      volume = floatingVolume(current, g),
      seen = new Set<string>();
    let accepted: { parts: Packed[]; graph: Graph } | undefined;
    const tryBridge = (a: number, b: number, x: number, y: number, z: number, bx: number, bz: number) => {
      const source = current[a]!,
        kind = source.kind === 'tile' ? 'tile' : 'plate';
      for (const c of choices)
        if (c.kind === kind && c.w > Math.abs(x - bx) && c.d > Math.abs(z - bz)) {
          for (let pz = Math.max(z, bz) - c.d + 1; pz <= Math.min(z, bz); pz++)
            for (let px = Math.max(x, bx) - c.w + 1; px <= Math.min(x, bx); px++) {
              budget.check();
              if (tests >= maxTests || ++examined > 50_000) return;
              const signature = `${c.id}:${c.rotY}:${px}:${y}:${pz}`;
              if (seen.has(signature)) continue;
              seen.add(signature);
              budget.memory(128);
              const affected = new Set<number>();
              let valid = true;
              for (let dz = 0; dz < c.d && valid; dz++)
                for (let dx = 0; dx < c.w; dx++) {
                  const id = index.at(px + dx, y, pz + dz),
                    p = id === undefined ? undefined : current[id];
                  if (
                    !p ||
                    !p.movable ||
                    p.instance.colorId !== source.instance.colorId ||
                    (p.kind === 'tile') !== (kind === 'tile')
                  ) {
                    valid = false;
                    break;
                  }
                  affected.add(id!);
                }
              if (!valid || !affected.has(a) || !affected.has(b)) continue;
              const bridge = makePacked(c, px, y, pz, source.instance.colorId, source.instance.submodel);
              const patch: Packed[] = [];
              for (const id of affected) {
                const p = current[id]!;
                for (let py = p.y; py < p.y + p.h; py++)
                  patch.push({ ...p, y: py, h: 1, kind: p.kind === 'tile' ? 'tile' : 'plate' });
              }
              for (const variant of [0, 1, 2]) {
                if (tests >= maxTests) return;
                const covered = repackRegion(patch, cs, variant, budget, bridge);
                if (!covered) continue;
                const delta = covered.length + 1 - affected.size;
                if (budget.parts + delta > budget.limits.maxParts) continue;
                const trial = [...current.filter((_, i) => !affected.has(i)), bridge, ...covered];
                const next = graph(trial, budget);
                tests++;
                const nextVolume = floatingVolume(trial, next);
                if (nextVolume > volume || (nextVolume === volume && next.floating.length >= g.floating.length))
                  continue;
                // No previously grounded cell may become floating during a local retile.
                let preserves = true;
                for (const ids of next.floating)
                  for (const id of ids) {
                    const p = trial[id]!;
                    for (let py = p.y; py < p.y + p.h && preserves; py++)
                      for (let pz = p.z; pz < p.z + p.d && preserves; pz++)
                        for (let px = p.x; px < p.x + p.w; px++) {
                          const old = index.at(px, py, pz);
                          if (old !== undefined && !floating.has(old)) {
                            preserves = false;
                            break;
                          }
                        }
                  }
                if (!preserves) continue;
                budget.parts += delta;
                budget.memory(delta * 512);
                accepted = { parts: trial, graph: next };
                return;
              }
            }
        }
    };
    try {
      // Grounded neighbors first; then merge floating components along a route to ground.
      search: for (const groundedOnly of [true, false])
        for (const a of floating) {
          const p = current[a]!;
          if (!p.movable || !Number.isInteger(p.x) || !Number.isInteger(p.z)) continue;
          for (let y = p.y; y < p.y + p.h; y++)
            for (const axis of [0, 1])
              for (const sign of [-1, 1]) {
                const length = axis === 0 ? p.d : p.w;
                for (let offset = 0; offset < length; offset++) {
                  const x = axis === 0 ? p.x + (sign < 0 ? 0 : p.w - 1) : p.x + offset;
                  const z = axis === 1 ? p.z + (sign < 0 ? 0 : p.d - 1) : p.z + offset;
                  const bx = x + (axis === 0 ? sign : 0),
                    bz = z + (axis === 1 ? sign : 0),
                    b = index.at(bx, y, bz);
                  if (b === undefined || component[a] === component[b] || groundedOnly === floating.has(b)) continue;
                  if (!current[b]!.movable || current[b]!.instance.colorId !== p.instance.colorId) continue;
                  tryBridge(a, b, x, y, z, bx, bz);
                  if (accepted || tests >= maxTests || examined >= 50_000) break search;
                }
              }
        }
    } finally {
      index.dispose();
      budget.memory(-seen.size * 128);
    }
    if (!accepted) break;
    current = accepted.parts;
    g = accepted.graph;
    regions++;
  }
  return { parts: current, graph: g, regions };
}
