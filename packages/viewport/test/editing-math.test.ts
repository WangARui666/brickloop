import { expect, it } from 'vitest';
import {
  horizontalAxes,
  keyboardDelta,
  snap,
  fromPositionLdu,
  toPositionLdu,
  eulerDegrees,
  withEulerDegrees,
} from '../src/editing-math';
import { identity, toLDraw } from '@brickloop/core';
import { pickPath } from '../src/document-projection';

it('maps instance slots to full occurrence paths, including shared definitions', () => {
  const paths = [
    ['left', 'shared'],
    ['right', 'shared'],
  ];
  expect(pickPath(paths, 1)).toEqual(['right', 'shared']);
  expect(pickPath(paths, 0)).toEqual(['left', 'shared']);
  expect(pickPath(paths, 2)).toBeNull();
  expect(pickPath(paths, undefined)).toBeNull();
});
it('aligns movement to the closest horizontal camera axes in every quadrant', () => {
  expect(horizontalAxes([0.8, -0.5, 0.2])).toEqual({ forward: [1, 0, 0], right: [0, 0, -1] });
  expect(keyboardDelta('d', [0, 0, 1], 5, 8)).toEqual([5, 0, 0]);
  expect(keyboardDelta('w', [-0.8, 0, 0.2], 20, 8)).toEqual([-20, 0, 0]);
  expect(keyboardDelta('a', [0, 0, -1], 10, 8)).toEqual([10, 0, 0]);
  expect(keyboardDelta('q', [0, 0, 1], 5, 24)).toEqual([0, -24, 0]);
  expect(keyboardDelta('e', [0, 0, 1], 5, 1)).toEqual([0, 1, 0]);
  expect(horizontalAxes([0, 1, 0])).toEqual({ forward: [0, 0, 1], right: [1, 0, 0] });
});
it('snaps cumulative displacement using signed Math.round and supports free angles', () => {
  expect(snap(7.6, 5)).toBe(10);
  expect(snap(-7.5, 5)).toBe(-5);
  expect(snap(-1, 8)).toBe(0);
  expect(snap(34, 22.5)).toBe(45);
  expect(snap(2.34, 0)).toBe(2.34);
});
it('converts LDU, studs, plates and millimeters without losing values', () => {
  expect(fromPositionLdu(20, 'stud')).toBe(1);
  expect(fromPositionLdu(8, 'plate')).toBe(1);
  expect(fromPositionLdu(80, 'mm')).toBe(32);
  for (const unit of ['ldu', 'stud', 'plate', 'mm'] as const)
    expect(toPositionLdu(fromPositionLdu(-12.345, unit), unit)).toBeCloseTo(-12.345, 10);
  const transform = toLDraw(identity());
  transform[0] = 20;
  const rotated = withEulerDegrees(transform, [0, 90, 0]);
  expect(eulerDegrees(rotated)[1]).toBeCloseTo(90);
  expect(rotated[0]).toBe(20);
});
