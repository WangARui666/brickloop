import type { Budget } from './limits.js';
import { repackRegion, type Candidate, type Packed } from './packing.js';
import type { Bounds, BuildWarning, QualityCounts } from './types.js';
import { key } from './voxels.js';

export interface Graph {
  adjacent: Map<number, number>[];
  components: number[][];
  floating: number[][];
  cuts: Set<number>;
  weak: QualityCounts;
  connections: number;
}
export function graph(parts: Packed[], budget: Budget): Graph {
  const tops = new Map<string, number[]>(),
    adjacent = parts.map(() => new Map<number, number>());
  let memory = parts.length * 256;
  budget.memory(memory);
  for (let i = 0; i < parts.length; i++) {
    budget.check();
    const p = parts[i]!;
    if (p.kind === 'tile') continue;
    for (let dz = 0; dz < p.d; dz++)
      for (let dx = 0; dx < p.w; dx++) {
        if ((dx & 255) === 0) budget.check();
        const k = `${p.y + p.h}:${p.x + dx}:${p.z + dz}`,
          list = tops.get(k);
        if (list) list.push(i);
        else tops.set(k, [i]);
        budget.memory(160);
        memory += 160;
      }
  }
  for (let i = 0; i < parts.length; i++) {
    budget.check();
    const p = parts[i]!;
    for (let dz = 0; dz < p.d; dz++)
      for (let dx = 0; dx < p.w; dx++)
        for (const j of tops.get(`${p.y}:${p.x + dx}:${p.z + dz}`) ?? []) {
          if ((j & 255) === 0) budget.check();
          const overlap = (adjacent[i]!.get(j) ?? 0) + 1;
          if (overlap === 1) {
            budget.memory(192);
            memory += 192;
          }
          adjacent[i]!.set(j, overlap);
          adjacent[j]!.set(i, overlap);
        }
  }
  // Iterative Tarjan DFS avoids overflowing the host stack on a 50,000-part tower.
  const discovery = new Int32Array(parts.length).fill(-1),
    low = new Int32Array(parts.length),
    parent = new Int32Array(parts.length).fill(-1);
  const cuts = new Set<number>(),
    components: number[][] = [];
  let clock = 0;
  for (let root = 0; root < parts.length; root++) {
    if (discovery[root] !== -1) continue;
    const component = [root];
    components.push(component);
    discovery[root] = low[root] = clock++;
    const stack: { id: number; neighbors: number[]; next: number; children: number }[] = [
      { id: root, neighbors: [...adjacent[root]!.keys()], next: 0, children: 0 },
    ];
    while (stack.length) {
      budget.check();
      const frame = stack.at(-1)!,
        u = frame.id;
      if (frame.next < frame.neighbors.length) {
        const v = frame.neighbors[frame.next++]!;
        if (discovery[v] === -1) {
          frame.children++;
          parent[v] = u;
          discovery[v] = low[v] = clock++;
          component.push(v);
          stack.push({ id: v, neighbors: [...adjacent[v]!.keys()], next: 0, children: 0 });
        } else if (v !== parent[u]) low[u] = Math.min(low[u]!, discovery[v]!);
      } else {
        stack.pop();
        const p = parent[u]!;
        if (p !== -1) {
          low[p] = Math.min(low[p]!, low[u]!);
          if (parent[p] !== -1 && low[u]! >= discovery[p]!) cuts.add(p);
        } else if (frame.children > 1) cuts.add(u);
      }
    }
  }
  let singleStud = 0,
    connections = 0;
  adjacent.forEach((neighbors, i) =>
    neighbors.forEach((area, j) => {
      if (i < j) {
        connections++;
        if (area === 1) singleStud++;
      }
    }),
  );
  budget.memory(-memory);
  return {
    adjacent,
    components,
    floating: components.filter((ids) => !ids.some((i) => parts[i]!.y === 0)),
    cuts,
    weak: { singleStud, articulationPoints: cuts.size, total: singleStud + cuts.size },
    connections,
  };
}
export function bounds(parts: Packed[]): Bounds {
  let x = Infinity,
    y = Infinity,
    z = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    z1 = -Infinity;
  for (const p of parts) {
    x = Math.min(x, p.x);
    y = Math.min(y, p.y);
    z = Math.min(z, p.z);
    x1 = Math.max(x1, p.x + p.w);
    y1 = Math.max(y1, p.y + p.h);
    z1 = Math.max(z1, p.z + p.d);
  }
  return { x, y, z, w: x1 - x, h: y1 - y, d: z1 - z };
}
export function floatingWarnings(parts: Packed[], g: Graph): BuildWarning[] {
  return g.floating.map((ids) => {
    const b = bounds(ids.map((i) => parts[i]!));
    return {
      code: 'FLOATING_COMPONENT',
      bounds: b,
      message: `${ids.length} parts are disconnected from ground; add support below (${b.x},${b.z})–(${b.x + b.w},${b.z + b.d}), levels ${b.y}–${b.y + b.h - 1}`,
    };
  });
}
export function seams(parts: Packed[], budget: Budget): { seamsThroughThreeCourses: number; maxSeamCourses: number } {
  // Sweep only part boundaries: an unchanged three-plate brick course is processed once.
  const events = new Map<number, { add: number[]; remove: number[] }>();
  parts.forEach((p, i) => {
    if (!Number.isInteger(p.x) || !Number.isInteger(p.z)) return;
    for (const [y, kind] of [
      [p.y, 'add'],
      [p.y + p.h, 'remove'],
    ] as const) {
      let e = events.get(y);
      if (!e) {
        e = { add: [], remove: [] };
        events.set(y, e);
      }
      e[kind].push(i);
    }
  });
  const active = new Set<number>(),
    levels = [...events.keys()].sort((a, b) => a - b);
  const runs = new Map<number, { end: number; a: number; b: number; count: number; max: number }>();
  for (let level = 0; level < levels.length - 1; level++) {
    const y = levels[level]!,
      event = events.get(y)!,
      end = levels[level + 1]! - 1;
    for (const id of event.remove) active.delete(id);
    for (const id of event.add) active.add(id);
    const layer = new Map<number, number>();
    let bytes = 0;
    for (const id of active) {
      const p = parts[id]!;
      for (let z = p.z; z < p.z + p.d; z++)
        for (let x = p.x; x < p.x + p.w; x++) {
          if ((x & 255) === 0) budget.check();
          const k = key(x, z);
          if (!layer.has(k)) {
            budget.memory(48);
            bytes += 48;
          }
          layer.set(k, id);
        }
    }
    budget.check();
    for (const [cell, i] of layer)
      for (const [delta, axis] of [
        [2_097_152, 0],
        [1, 1],
      ] as const) {
        const j = layer.get(cell + delta);
        if (j === undefined || i === j) continue;
        const k = cell * 2 + axis,
          prev = runs.get(k);
        const count = prev && prev.end === y - 1 ? prev.count + Number(prev.a !== i || prev.b !== j) : 1;
        if (!prev) budget.memory(128);
        runs.set(k, { end, a: i, b: j, count, max: Math.max(count, prev?.max ?? 0) });
      }
    budget.memory(-bytes);
  }
  let through = 0,
    max = 0;
  for (const r of runs.values()) {
    if (r.max >= 3) through++;
    max = Math.max(max, r.max);
  }
  budget.memory(-runs.size * 128);
  return { seamsThroughThreeCourses: through, maxSeamCourses: max };
}
/** One bounded pass, at most 24 disjoint two-course regions, two alternative covers each.
 * Accept only strict weakness reduction with no connectivity or seam regression. */
export function repair(
  parts: Packed[],
  cs: Candidate[],
  budget: Budget,
): { parts: Packed[]; before: Graph; after: Graph; repairedRegions: number } {
  const before = graph(parts, budget);
  let current = parts,
    after = before,
    repairedRegions = 0;
  const targets = new Set<number>(before.cuts);
  before.adjacent.forEach((ns, i) => {
    if ([...ns.values()].includes(1)) targets.add(i);
  });
  const touched = new Set<Packed>();
  let attempts = 0;
  let currentSeams: ReturnType<typeof seams> | undefined;
  for (const index of targets) {
    const target = parts[index]!;
    if (!target.movable || touched.has(target) || attempts++ >= 24) continue;
    const neighbors = [...before.adjacent[index]!.keys()]
      .map((i) => parts[i]!)
      .filter((p) => p.movable && p.instance.submodel === target.instance.submodel);
    const neighbor = neighbors.find((p) => p.y !== target.y);
    if (!neighbor) continue;
    const region = current.filter(
      (p) =>
        p.movable &&
        p.instance.submodel === target.instance.submodel &&
        (p.y === target.y || p.y === neighbor.y) &&
        p.x >= target.x - 8 &&
        p.x + p.w <= target.x + target.w + 8 &&
        p.z >= target.z - 8 &&
        p.z + p.d <= target.z + target.d + 8,
    );
    if (region.length < 2 || region.length > 96) continue;
    region.forEach((p) => touched.add(p));
    const outside = current.filter((p) => !region.includes(p));
    const oldSeams = seams(region, budget).seamsThroughThreeCourses;
    for (const variant of [1, 2]) {
      const replacement = repackRegion(region, cs, variant, budget);
      if (
        !replacement ||
        replacement.length > region.length ||
        seams(replacement, budget).seamsThroughThreeCourses > oldSeams
      )
        continue;
      const trial = [...outside, ...replacement],
        g = graph(trial, budget);
      if (
        g.weak.total < after.weak.total &&
        g.floating.length <= after.floating.length &&
        g.components.length <= after.components.length
      ) {
        currentSeams ??= seams(current, budget);
        const trialSeams = seams(trial, budget);
        if (
          trialSeams.seamsThroughThreeCourses > currentSeams.seamsThroughThreeCourses ||
          trialSeams.maxSeamCourses > currentSeams.maxSeamCourses
        )
          continue;
        current = trial;
        after = g;
        currentSeams = trialSeams;
        repairedRegions++;
        break;
      }
    }
  }
  return { parts: current, before, after, repairedRegions };
}
