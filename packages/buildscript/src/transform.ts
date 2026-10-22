import { BuildFailure, number, record } from './limits.js';
import type { BuildPose } from './types.js';

export interface Transform {
  a: number;
  b: number;
  c: number;
  d: number;
  x: number;
  z: number;
  y: number;
}
export const identity: Transform = { a: 1, b: 0, c: 0, d: 1, x: 0, z: 0, y: 0 };
export function rotation(value: unknown): BuildPose['rotY'] {
  const n = value === undefined ? 0 : number(value, 'rotY');
  if (![0, 90, 180, 270].includes(n)) throw new BuildFailure('RUNTIME', 'rotY must be 0, 90, 180 or 270');
  return n as BuildPose['rotY'];
}
export function transform(value: unknown): Transform {
  const o = record(value),
    r = rotation(o.rotY) / 90,
    s = [0, 1, 0, -1][r]!,
    c = [1, 0, -1, 0][r]!;
  const mx = o.mirrorX ? -1 : 1,
    mz = o.mirrorZ ? -1 : 1;
  // Positive rotation follows the host's [0,-1,0] LDraw axis: x'=-z, z'=x at 90°.
  return {
    a: c * mx,
    b: -s * mz,
    c: s * mx,
    d: c * mz,
    x: number(o.dx ?? 0, 'dx'),
    z: number(o.dz ?? 0, 'dz'),
    y: number(o.dy ?? 0, 'dy'),
  };
}
export function compose(p: Transform, q: Transform): Transform {
  return {
    a: p.a * q.a + p.b * q.c,
    b: p.a * q.b + p.b * q.d,
    c: p.c * q.a + p.d * q.c,
    d: p.c * q.b + p.d * q.d,
    x: p.a * q.x + p.b * q.z + p.x,
    z: p.c * q.x + p.d * q.z + p.z,
    y: p.y + q.y,
  };
}
export function point(t: Transform, x: number, z: number): [number, number] {
  return [t.a * x + t.b * z + t.x, t.c * x + t.d * z + t.z];
}
export function pose(value: unknown, t: Transform, rectangular = false): BuildPose {
  const o = record(value),
    x = number(o.x ?? 0, 'x'),
    z = number(o.z ?? 0, 'z'),
    y = number(o.y ?? 0, 'y');
  if (![x, z].every((v) => Number.isInteger(v * 2)) || !Number.isInteger(y))
    throw new BuildFailure('RUNTIME', 'Part poses require half-stud x/z and integer y');
  const reflected = t.a * t.d - t.b * t.c < 0;
  const [px, pz] = point(t, x, z),
    angle = (Math.round((Math.atan2(t.c, t.a) * 180) / Math.PI) + (reflected ? -1 : 1) * rotation(o.rotY) + 720) % 360;
  if (![px, pz].every((v) => Number.isInteger(v * 2)) || !Number.isInteger(y + t.y))
    throw new BuildFailure('RUNTIME', 'Transformed pose is off grid');
  const result: BuildPose = { x: px, z: pz, level: y + t.y, rotY: angle as BuildPose['rotY'] };
  if (reflected && !rectangular) {
    const m = compose(t, transform({ dx: x, dz: z, dy: y, rotY: o.rotY ?? 0 }));
    result.matrixLdu = [px * 20, -result.level * 8, pz * 20, m.a, 0, m.b, 0, 1, 0, m.c, 0, m.d];
    result.matrixLdu = result.matrixLdu.map((n) => (n === 0 ? 0 : n)) as NonNullable<BuildPose['matrixLdu']>;
  }
  return result;
}
export function placementTransform(p: BuildPose): Transform {
  const m = p.matrixLdu;
  return m
    ? { x: p.x, z: p.z, y: p.level, a: m[3], b: m[5], c: m[9], d: m[11] }
    : transform({ dx: p.x, dz: p.z, dy: p.level, rotY: p.rotY });
}
