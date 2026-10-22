import { identity, rotationAxisAngle } from '@brickloop/core';
import type { Matrix4, Vec3 } from '@brickloop/core';
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, n: number): Vec3 => [a[0] * n, a[1] * n, a[2] * n];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (v: Vec3): number => Math.hypot(...v);
export const distance = (a: Vec3, b: Vec3): number => norm(sub(a, b));
export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
export function unit(v: Vec3): Vec3 {
  const n = norm(v);
  if (!Number.isFinite(n) || n < 1e-12) throw new RangeError('Degenerate connector direction');
  return scale(v, 1 / n);
}
export const angle = (a: Vec3, b: Vec3): number => (Math.acos(clamp(dot(a, b), -1, 1)) * 180) / Math.PI;
export const signedAngle = (a: Vec3, b: Vec3, axis: Vec3): number =>
  (Math.atan2(dot(axis, cross(a, b)), dot(a, b)) * 180) / Math.PI;
export function align(a: Vec3, b: Vec3, ref: Vec3): Matrix4 {
  const c = cross(a, b);
  if (norm(c) < 1e-10) return dot(a, b) > 0 ? identity() : rotationAxisAngle(ref, 180);
  return rotationAxisAngle(unit(c), angle(a, b));
}
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
