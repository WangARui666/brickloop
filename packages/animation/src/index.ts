import { expandInstances, toLDraw, transformPoint } from '@brickloop/core';
import type { BrkDocument, Vec3 } from '@brickloop/core';
import { planInstructions } from '@brickloop/instructions';

export type AnimationOrder = 'layers' | 'steps';
export type AnimationMotion = 'drop' | 'fly' | 'appear';
/** All geometry uses document coordinates (LDraw, -Y up), in LDU. */
export interface AnimationBounds {
  min: Vec3;
  max: Vec3;
}
export interface AnimationOptions {
  order?: AnimationOrder;
  motion?: AnimationMotion;
  /** Total, including the three-second finale. Clamped to 5–120 seconds. */
  durationSeconds?: number;
  /** Overrides target duration; minimum 0.6 seconds to accommodate landing. */
  secondsPerGroup?: number;
  localBounds: Readonly<Record<string, AnimationBounds>>;
  /** Definitions whose geometry was unavailable; the host reports their occurrence count. */
  excludedPartIds?: readonly string[];
  connections?: readonly { a: readonly string[]; b: readonly string[] }[];
}
export interface AnimationPart {
  path: string[];
  partId: string;
  colorId: string;
  transform: number[];
  bounds: AnimationBounds;
  group: number;
  start: number;
  duration: number;
  highlightDuration: number;
  offset: Vec3;
  motion: AnimationMotion;
}
export interface AnimationTick {
  time: number;
  index: number;
  number: string;
  count: number;
}
export interface BuildTimeline {
  parts: AnimationPart[];
  ticks: AnimationTick[];
  bounds: AnimationBounds;
  order: AnimationOrder;
  buildDuration: number;
  totalDuration: number;
  finaleDuration: number;
  coarseSteps: boolean;
}
export interface AnimationSample {
  path: readonly string[];
  transform: readonly number[];
  offset: Vec3;
  opacity: number;
  highlight: number;
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const center = (b: AnimationBounds): Vec3 => b.min.map((v, i) => (v + b.max[i]!) / 2) as unknown as Vec3;
const bottom = (b: AnimationBounds) => -b.max[1];
const top = (b: AnimationBounds) => -b.min[1];
const sweep = (a: AnimationPart, b: AnimationPart) => {
  const x = center(a.bounds),
    y = center(b.bounds);
  // Document/world transforms use LDraw coordinates; only the viewport changes axes.
  return (
    x[0] + x[2] - (y[0] + y[2]) ||
    x[0] - y[0] ||
    x[2] - y[2] ||
    compare(a.partId, b.partId) ||
    compare(a.path.join('/'), b.path.join('/'))
  );
};
function union(boxes: readonly AnimationBounds[]): AnimationBounds {
  if (!boxes.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  return {
    min: [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]!))) as unknown as Vec3,
    max: [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]!))) as unknown as Vec3,
  };
}

/** Pure plan: caller supplies geometry and any existing assembly connections. */
export function planBuildAnimation(doc: BrkDocument, modelId: string, options: AnimationOptions): BuildTimeline {
  for (const value of [options.durationSeconds, options.secondsPerGroup])
    if (value !== undefined && !Number.isFinite(value)) throw new RangeError('Animation duration must be finite');
  const order = options.order ?? 'layers',
    motion = options.motion ?? 'drop';
  const excluded = new Set(options.excludedPartIds);
  const expanded = expandInstances(doc, modelId).filter((row) => !excluded.has(row.partId));
  const parts: AnimationPart[] = expanded.map((row) => {
    const local = options.localBounds[row.partId];
    if (!local) throw new RangeError(`Missing animation bounds: ${row.partId}`);
    if ([...local.min, ...local.max].some((v) => !Number.isFinite(v)) || local.min.some((v, i) => v > local.max[i]!))
      throw new RangeError(`Invalid animation bounds: ${row.partId}`);
    const corners: Vec3[] = [];
    for (const x of [local.min[0], local.max[0]])
      for (const y of [local.min[1], local.max[1]])
        for (const z of [local.min[2], local.max[2]]) corners.push(transformPoint(row.worldMatrix, [x, y, z]));
    return {
      path: [...row.path],
      partId: row.partId,
      colorId: row.colorId,
      transform: toLDraw(row.worldMatrix),
      bounds: union(corners.map((p) => ({ min: p, max: p }))),
      group: 0,
      start: 0,
      duration: 0.45,
      highlightDuration: 0.3,
      offset: [0, -144, 0],
      motion,
    };
  });
  const bounds = union(parts.map((p) => p.bounds));
  const supports = new Map<AnimationPart, AnimationPart[]>();
  let groups: AnimationPart[][], numbers: string[];
  if (order === 'steps') {
    // The instruction planner is the sole authority for recursive definition/step order.
    const steps = planInstructions(doc, { rootModelId: modelId, includeCover: false, includeBom: false }).steps;
    groups = steps.map(() => []);
    numbers = steps.map((s) => s.number);
    const indices = new Map(steps.map((s, i) => [`${s.modelId}/${doc.models[s.modelId]!.stepIds[s.stepIndex]}`, i]));
    const first = new Map<string, string>();
    expanded.forEach((row) => {
      let current = modelId;
      row.path.forEach((id, i) => {
        const instance = doc.models[current]!.instances[id]!;
        if (instance.ref.kind === 'model') {
          current = instance.ref.modelId;
          if (!first.has(current)) first.set(current, row.path.slice(0, i + 1).join('/'));
        }
      });
    });
    for (const part of parts) {
      let current = modelId,
        index = 0;
      for (const [i, id] of part.path.entries()) {
        const instance = doc.models[current]!.instances[id]!;
        index = indices.get(`${current}/${instance.stepId}`)!;
        if (instance.ref.kind === 'part') break;
        if (first.get(instance.ref.modelId) !== part.path.slice(0, i + 1).join('/')) break;
        current = instance.ref.modelId;
      }
      groups[index]!.push(part);
    }
    groups.forEach((g) => g.sort(sweep));
  } else {
    const sorted = [...parts].sort(
      (a, b) => Math.round(bottom(a.bounds) / 8) - Math.round(bottom(b.bounds) / 8) || sweep(a, b),
    );
    const byPath = new Map(sorted.map((p) => [p.path.join('/'), p]));
    for (const edge of options.connections ?? []) {
      const a = byPath.get(edge.a.join('/')),
        b = byPath.get(edge.b.join('/'));
      if (!a || !b) continue;
      const upper = bottom(a.bounds) >= top(b.bounds) - 1e-6 ? a : bottom(b.bounds) >= top(a.bounds) - 1e-6 ? b : null;
      if (!upper) continue;
      const lower = upper === a ? b : a;
      const list = supports.get(upper) ?? [];
      list.push(lower);
      supports.set(upper, list);
    }
    const emitted = new Set<AnimationPart>(),
      visiting = new Set<AnimationPart>(),
      corrected: AnimationPart[] = [];
    const emit = (p: AnimationPart) => {
      if (emitted.has(p) || visiting.has(p)) return;
      visiting.add(p);
      for (const support of (supports.get(p) ?? []).sort(sweep)) emit(support);
      visiting.delete(p);
      emitted.add(p);
      corrected.push(p);
    };
    sorted.forEach(emit);
    groups = [];
    numbers = [];
    let height: number | undefined;
    for (const p of corrected) {
      const h = Math.round(bottom(p.bounds) / 8);
      if (h !== height) {
        groups.push([]);
        numbers.push(String(groups.length));
        height = h;
      }
      groups.at(-1)!.push(p);
    }
  }
  const effective = groups.filter((g) => g.length).length;
  const coarseSteps = order === 'steps' && (effective < 3 || groups.some((g) => g.length > 80));
  const defaultBuild = order === 'layers' ? clamp(parts.length * 0.04, 8, 45) : Math.max(0.6, groups.length * 1.2);
  const requestedBuild =
    options.secondsPerGroup !== undefined
      ? Math.max(0.6, options.secondsPerGroup) * groups.length
      : options.durationSeconds === undefined
        ? defaultBuild
        : clamp(options.durationSeconds, 5, 120) - 3;
  // The per-step floor takes precedence over an unattainably short target duration.
  const buildDuration = order === 'steps' ? Math.max(groups.length * 0.6, requestedBuild) : requestedBuild;
  const ticks: AnimationTick[] = [];
  const available = Math.max(0, buildDuration - 0.9);
  let weight = 0;
  const totalWeight = order === 'steps' || options.secondsPerGroup !== undefined ? groups.length : parts.length;
  const modelCenter = center(bounds),
    modelRadius = Math.hypot(...bounds.max.map((v, i) => v - bounds.min[i]!)) / 2;
  for (const [i, group] of groups.entries()) {
    const w = order === 'steps' || options.secondsPerGroup !== undefined ? 1 : group.length;
    const fixedGroups = order === 'steps' || options.secondsPerGroup !== undefined;
    const interval = buildDuration / Math.max(1, totalWeight);
    const start = 0.12 + ((fixedGroups ? buildDuration : available) * weight) / Math.max(1, totalWeight);
    const span = fixedGroups ? Math.max(0, interval - 0.9) : (available * w) / Math.max(1, totalWeight);
    ticks.push({ time: start, index: i, number: numbers[i]!, count: group.length });
    const batches = Math.max(1, Math.floor(span / 0.055));
    const batchSize = Math.max(1, Math.ceil(group.length / batches));
    group.forEach((p, j) => {
      p.group = i;
      p.start =
        start +
        (order === 'steps'
          ? j * Math.min(0.035, span / Math.max(1, group.length))
          : (Math.floor(j / batchSize) * span) / batches);
      if (motion === 'appear') p.offset = [0, 0, 0];
      if (motion === 'fly') {
        const c = center(p.bounds),
          delta = c.map((v, k) => v - modelCenter[k]!) as unknown as Vec3;
        const length = Math.hypot(...delta);
        p.offset =
          length < 1e-6
            ? [0, -modelRadius - 144, 0]
            : (delta.map((v) => (v / length) * (modelRadius + 144)) as unknown as Vec3);
      }
    });
    weight += w;
  }
  // Connected support pairs must not be made simultaneous by batch coalescing.
  for (const part of groups.flat())
    for (const support of supports.get(part) ?? []) part.start = Math.max(part.start, support.start + 0.005);
  return {
    parts: groups.flat().sort((a, b) => a.start - b.start),
    ticks,
    bounds,
    order,
    buildDuration,
    totalDuration: buildDuration + 3,
    finaleDuration: 3,
    coarseSteps,
  };
}

/** O(1) sampler used by the renderer for just its active interval. */
export function sampleAnimationPart(part: AnimationPart, time: number): AnimationSample | undefined {
  if (time <= part.start) return undefined;
  const u = clamp((time - part.start) / part.duration, 0, 1);
  const travel = u < 0.8 ? (1 - u / 0.8) ** 3 : 0;
  // One tiny upward rebound: 2 LDU, below the 2.4 LDU (0.3 plate) limit.
  const rebound = part.motion === 'drop' && u >= 0.8 && u < 1 ? -2 * Math.sin(((u - 0.8) / 0.2) * Math.PI) : 0;
  const offset = part.offset.map((v, i) => v * travel + (i === 1 ? rebound : 0)) as unknown as Vec3;
  const age = time - part.start - part.duration;
  return {
    path: part.path,
    transform: part.transform,
    offset,
    opacity: clamp(u / 0.3, 0, 1),
    highlight: age >= 0 && age < part.highlightDuration ? (1 - age / part.highlightDuration) ** 2 : 0,
  };
}
/** Pure random-access sample; no mutable playback state or accumulated transforms. */
export function sampleBuildAnimation(timeline: BuildTimeline, time: number): AnimationSample[] {
  if (!Number.isFinite(time)) throw new RangeError('Animation time must be finite');
  return timeline.parts.flatMap((p) => {
    const sample = sampleAnimationPart(p, time);
    return sample ? [sample] : [];
  });
}
export function animationGroupAt(timeline: BuildTimeline, time: number): number {
  let lo = 0,
    hi = timeline.ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline.ticks[mid]!.time <= time) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}
export function animationOrbit(timeline: BuildTimeline, time: number): number {
  const t = clamp(time, 0, timeline.totalDuration);
  return (
    (Math.PI / 2) * Math.min(1, t / timeline.buildDuration) +
    Math.PI * 2 * clamp((t - timeline.buildDuration) / timeline.finaleDuration, 0, 1)
  );
}
