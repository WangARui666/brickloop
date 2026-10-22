import { expect, it } from 'vitest';
import { multiply, rotationAxisAngle, translation } from '@brickloop/core';
import { transformConnector, solveRotation } from '@brickloop/connect';
import type { Connector } from '@brickloop/connect';
import { constrainConnectorRotation } from '../src/renderer/src/connector-rotation';
const joint: Connector = {
  id: 'joint',
  type: 'hinge.click',
  frame: { origin: [25, -16, 8], axis: [0, -1, 0], ref: [1, 0, 0] },
  rotation: 15,
  limits: [-30, 45],
  size: 's',
  role: 'a',
};
const mate: Connector = { ...joint, role: 'b', frame: { ...joint.frame, axis: [0, 1, 0] } };
const around = (axis: [number, number, number], degrees: number) =>
  multiply(translation(joint.frame.origin), multiply(rotationAxisAngle(axis, degrees), translation([-25, 16, -8])));
it('keeps the chosen world pivot and clamps a hinge to its absolute angle limits over repeated gestures', () => {
  const first = transformConnector(joint, constrainConnectorRotation(joint, mate, around([0, 1, 0], 37)));
  first.frame.origin.forEach((v, i) => expect(v).toBeCloseTo(joint.frame.origin[i]!, 10));
  const second = transformConnector(first, constrainConnectorRotation(first, mate, around([0, 1, 0], 37)));
  second.frame.origin.forEach((v, i) => expect(v).toBeCloseTo(joint.frame.origin[i]!, 10));
  expect(solveRotation(second, mate).change).toBeCloseTo(0);
  expect((Math.atan2(-second.frame.ref[2], second.frame.ref[0]) * 180) / Math.PI).toBeCloseTo(45);
});
it('clamps ball tilt without moving the joint origin', () => {
  const ball: Connector = { ...joint, type: 'ball', rotation: 'free', limits: [0, 30] };
  const socket: Connector = { ...mate, type: 'ball.socket', rotation: 'free', limits: [0, 30] };
  const rotated = transformConnector(ball, constrainConnectorRotation(ball, socket, around([1, 0, 0], 80)));
  rotated.frame.origin.forEach((v, i) => expect(v).toBeCloseTo(ball.frame.origin[i]!, 10));
  expect(solveRotation(rotated, socket).residual).toBeCloseTo(0);
  expect((Math.acos(-rotated.frame.axis[1]) * 180) / Math.PI).toBeCloseTo(30);
});
