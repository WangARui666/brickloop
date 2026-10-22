import { Euler, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { fromLDraw, toLDraw } from '@brickloop/core';
import type { Vec3 } from '@brickloop/core';

export type PositionUnit = 'ldu' | 'stud' | 'plate' | 'mm';
const units = { ldu: 1, stud: 20, plate: 8, mm: 2.5 };
export const fromPositionLdu = (value: number, unit: PositionUnit): number => value / units[unit];
export const toPositionLdu = (value: number, unit: PositionUnit): number => value * units[unit];
const scale3 = (v: Vec3, scale: number): Vec3 => [v[0] * scale || 0, v[1] * scale || 0, v[2] * scale || 0];
export function snap(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step || 0 : value;
}
/** Camera forward in document coordinates; ties consistently choose X. */
export function horizontalAxes(forward: Vec3): { forward: Vec3; right: Vec3 } {
  if (Math.hypot(forward[0], forward[2]) < 1e-8) forward = [0, 0, 1];
  const direction: Vec3 =
    Math.abs(forward[0]) >= Math.abs(forward[2])
      ? [Math.sign(forward[0]) || 1, 0, 0]
      : [0, 0, Math.sign(forward[2]) || 1];
  return { forward: direction, right: [direction[2], 0, -direction[0] || 0] };
}
export function keyboardDelta(key: string, forward: Vec3, horizontal: number, vertical: number): Vec3 | null {
  const axes = horizontalAxes(forward);
  const directions: Record<string, Vec3> = {
    w: axes.forward,
    s: scale3(axes.forward, -1),
    d: axes.right,
    a: scale3(axes.right, -1),
    q: [0, -1, 0],
    e: [0, 1, 0],
  };
  return directions[key] ? scale3(directions[key], key === 'q' || key === 'e' ? vertical : horizontal) : null;
}
export function eulerDegrees(transform: number[]): Vec3 {
  const rotation = new Euler().setFromRotationMatrix(new Matrix4().fromArray(fromLDraw(transform)), 'XYZ');
  return scale3([rotation.x, rotation.y, rotation.z], 180 / Math.PI);
}
export function withEulerDegrees(transform: number[], angles: Vec3): number[] {
  const source = new Matrix4().fromArray(fromLDraw(transform));
  const position = new Vector3(),
    scale = new Vector3(),
    quaternion = new Quaternion();
  source.decompose(position, quaternion, scale);
  const radians = scale3(angles, Math.PI / 180);
  quaternion.setFromEuler(new Euler(radians[0], radians[1], radians[2], 'XYZ'));
  return toLDraw(new Float64Array(source.compose(position, quaternion, scale).elements));
}
