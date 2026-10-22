import { multiply, rotationAxisAngle, translation } from '@brickloop/core';
import type { Matrix4, Vec3 } from '@brickloop/core';
import { solveRotation, transformConnector } from '@brickloop/connect';
import type { Connector } from '@brickloop/connect';

/** Constrain about the joint's world origin, preserving the paired connector's absolute limits. */
export function constrainConnectorRotation(source: Connector, mate: Connector, delta: Matrix4): Matrix4 {
  const moved = transformConnector(source, delta);
  const solved = solveRotation(moved, mate);
  let correction = solved.matrix;
  if ((source.type === 'ball' || source.type === 'ball.socket') && solved.residual > 0) {
    const a = moved.frame.axis,
      b = mate.frame.axis.map((v) => -v) as [number, number, number];
    const angle =
      (Math.acos(
        Math.max(
          -1,
          Math.min(
            1,
            a.reduce((sum, v, i) => sum + v * b[i]!, 0),
          ),
        ),
      ) *
        180) /
      Math.PI;
    const min = Math.max(0, source.limits?.[0] ?? 0, mate.limits?.[0] ?? 0);
    const max = Math.min(source.limits?.[1] ?? 180, mate.limits?.[1] ?? 180);
    const target = Math.max(min, Math.min(max, angle));
    let axis: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const length = Math.hypot(...axis);
    axis = length > 1e-9 ? (axis.map((v) => v / length) as [number, number, number]) : source.frame.ref;
    correction = rotationAxisAngle(axis, angle - target);
  }
  return multiply(
    multiply(
      translation(source.frame.origin),
      multiply(correction, translation(source.frame.origin.map((v) => -v) as [number, number, number])),
    ),
    delta,
  );
}
