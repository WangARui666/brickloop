import type { Transform, Vec3 } from './types.js';

export const IDENTITY: Transform = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, n: number): Vec3 => [a[0] * n, a[1] * n, a[2] * n];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const unit = (v: Vec3): Vec3 => scale(v, 1 / (Math.hypot(...v) || 1));

export function transformPoint(m: Transform, v: Vec3): Vec3 {
  return [
    m[0] + m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[1] + m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    m[2] + m[9] * v[0] + m[10] * v[1] + m[11] * v[2],
  ];
}
export function multiply(a: Transform, b: Transform): Transform {
  const result = [...transformPoint(a, [b[0], b[1], b[2]]), ...Array<number>(9).fill(0)] as Transform;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      result[3 + row * 3 + col] =
        a[3 + row * 3]! * b[3 + col]! + a[4 + row * 3]! * b[6 + col]! + a[5 + row * 3]! * b[9 + col]!;
    }
  }
  return result;
}
export function determinant(m: Transform): number {
  return (
    m[3] * (m[7] * m[11] - m[8] * m[10]) - m[4] * (m[6] * m[11] - m[8] * m[9]) + m[5] * (m[6] * m[10] - m[7] * m[9])
  );
}

/** Normalize rotation drift only for near-orthonormal transforms; preserve scale, shear and reflection. */
export function normalizeTransform(input: Transform): Transform {
  const m = [...input] as Transform;
  const x: Vec3 = [m[3], m[6], m[9]];
  const y: Vec3 = [m[4], m[7], m[10]];
  const z: Vec3 = [m[5], m[8], m[11]];
  if (
    [
      Math.abs(dot(x, x) - 1),
      Math.abs(dot(y, y) - 1),
      Math.abs(dot(z, z) - 1),
      Math.abs(dot(x, y)),
      Math.abs(dot(y, z)),
      Math.abs(dot(x, z)),
    ].every((n) => n < 1e-9)
  ) {
    const nx = unit(x);
    const ny = unit(sub(y, scale(nx, dot(nx, y))));
    const nz = scale(cross(nx, ny), determinant(m) < 0 ? -1 : 1);
    for (let row = 0; row < 3; row++) {
      m[3 + row * 3] = nx[row]!;
      m[4 + row * 3] = ny[row]!;
      m[5 + row * 3] = nz[row]!;
    }
  }
  const common = [0, 1, -1, 0.5, -0.5, Math.SQRT1_2, -Math.SQRT1_2];
  return m.map((value, i) => {
    const snapped = i < 3 ? value : (common.find((n) => Math.abs(value - n) < 1e-9) ?? value);
    return Number(snapped.toFixed(i < 3 ? 4 : 6)) || 0;
  }) as Transform;
}
