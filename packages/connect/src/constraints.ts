import { identity, multiply, rotationAxisAngle, transformDirection } from '@brickloop/core';
import type { Matrix4 } from '@brickloop/core';
import type { Connector } from './types';
import { linearPair, rotationStep } from './rules';
import { align, angle, clamp, dot, scale, signedAngle, sub } from './vector';

export interface LinearRange {
  min: number;
  max: number;
  offset: number;
  snaps: number[];
}
/** Offset is male base projected onto the hole's outward axis. A hole spans
 * [-depth,0]; the inserted male spans [offset-length,offset]. */
export function insertionRange(a: Connector, b: Connector, step = 10): LinearRange | null {
  const pair = linearPair(a, b);
  if (!pair) return null;
  const { male, hole, length, depth } = pair;
  let min = -depth + 1e-6,
    max = length - 1e-6;
  if (hole.ends?.start === 'closed') max = Math.min(max, 0);
  if (hole.ends?.end === 'closed') min = Math.max(min, length - depth);
  if (male.ends?.start === 'closed') min = Math.max(min, 0);
  if (male.ends?.end === 'closed') max = Math.min(max, length - depth);
  // Stops are shoulders: the hole lip cannot pass a male shoulder and the tip
  // cannot pass the first internal hole stop.
  if (male.stops?.length) min = Math.max(min, Math.min(...male.stops));
  if (hole.stops?.length) min = Math.max(min, length - Math.min(...hole.stops));
  const offset = dot(sub(male.frame.origin, hole.frame.origin), hole.frame.axis);
  const snaps = [min, max, 0, length - depth, ...(male.stops ?? []), ...(hole.stops ?? []).map((s) => length - s)];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) snaps.push(v);
  return { min, max, offset, snaps: [...new Set(snaps.filter((s) => s >= min && s <= max))] };
}
export function slideOffset(range: LinearRange, continuous: boolean): number {
  const v = clamp(range.offset, range.min, range.max);
  if (continuous) return v;
  return range.snaps.reduce(
    (best, n) =>
      Math.abs(n - v) < Math.abs(best - v) - 1e-9 || (Math.abs(Math.abs(n - v) - Math.abs(best - v)) < 1e-9 && n < best)
        ? n
        : best,
    range.snaps[0] ?? v,
  );
}
export function solveRotation(a: Connector, b: Connector): { matrix: Matrix4; change: number; residual: number } {
  const ball = a.type === 'ball' || b.type === 'ball';
  if (ball) {
    const tilt = angle(a.frame.axis, scale(b.frame.axis, -1));
    const max = Math.min(a.limits?.[1] ?? 180, b.limits?.[1] ?? 180),
      min = Math.max(a.limits?.[0] ?? 0, b.limits?.[0] ?? 0);
    return { matrix: identity(), change: 0, residual: Math.max(0, tilt - max, min - tilt) };
  }
  const aligned = align(a.frame.axis, scale(b.frame.axis, -1), a.frame.ref);
  const ref = transformDirection(aligned, a.frame.ref),
    turn = signedAngle(b.frame.ref, ref, b.frame.axis);
  const step = rotationStep(a, b);
  const min = Math.max(a.limits?.[0] ?? -180, b.limits?.[0] ?? -180),
    max = Math.min(a.limits?.[1] ?? 180, b.limits?.[1] ?? 180);
  const lo = step === 'free' ? min : Math.ceil(min / step) * step,
    hi = step === 'free' ? max : Math.floor(max / step) * step;
  if (lo > hi) return { matrix: aligned, change: 0, residual: lo - hi };
  const target = clamp(step === 'free' ? turn : Math.round(turn / step) * step, lo, hi);
  const matrix = multiply(rotationAxisAngle(b.frame.axis, target - turn), aligned);
  const trace = matrix[0]! + matrix[5]! + matrix[10]!;
  return { matrix, change: (Math.acos(clamp((trace - 1) / 2, -1, 1)) * 180) / Math.PI, residual: 0 };
}
