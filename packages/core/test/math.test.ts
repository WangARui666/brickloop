import { describe, expect, it } from 'vitest';
import {
  determinant,
  fromLDraw,
  identity,
  invert,
  multiply,
  normalizeForSave,
  rotateAboutPivot,
  rotationAxisAngle,
  snapToGrid,
  toLDraw,
  transformPoint,
  translation,
} from '../src';

describe('column-major LDraw math', () => {
  it('round-trips the LDraw row ordering and composes parent before child', () => {
    const values = [2, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 10];
    expect(toLDraw(fromLDraw(values))).toEqual(values);
    expect(
      transformPoint(multiply(rotationAxisAngle([0, 0, 1], 90), translation([20, 0, 0])), [0, 0, 0])[1],
    ).toBeCloseTo(20, 12);
  });
  it('inverts affine and general nonsingular 4×4 matrices', () => {
    const general = new Float64Array([2, 1, 0, 0.01, 0, 3, 1, 0, 1, 0, -2, 0, 10, 20, 30, 1]);
    for (const matrix of [general, multiply(translation([14, -22, 33]), rotationAxisAngle([1, 2, 3], 31))]) {
      multiply(matrix, invert(matrix)).forEach((v, i) => expect(v).toBeCloseTo(identity()[i]!, 11));
    }
    expect(() => invert(new Float64Array(16))).toThrow('Singular');
    expect(determinant(new Float64Array(16))).toBe(0);
  });
  it('rotates around a normalized arbitrary axis and a fixed pivot', () => {
    const m = rotateAboutPivot(translation([30, 0, 0]), [0, 0, 5], 90, [10, 0, 0]);
    const point = transformPoint(m, [0, 0, 0]);
    expect(point[0]).toBeCloseTo(10, 12);
    expect(point[1]).toBeCloseTo(20, 12);
    expect(transformPoint(rotateAboutPivot(identity(), [1, 2, 3], 77, [10, 20, 30]), [10, 20, 30])).toEqual([
      10, 20, 30,
    ]);
    expect(() => rotationAxisAngle([0, 0, 0], 90)).toThrow();
  });
  it('rounds translation, snaps special values and keeps mirrors after orthogonalization', () => {
    const mirrored = fromLDraw([1.234567, -1.234567, -0.000001, -1, 1e-8, 0, 0, 1, 0, 0, 0, 1]);
    const normalized = normalizeForSave(toLDraw(mirrored));
    expect(normalized.slice(0, 3)).toEqual([1.2346, -1.2346, 0]);
    expect(determinant(fromLDraw(normalized))).toBeCloseTo(-1, 12);
    expect(normalizeForSave(normalized)).toEqual(normalized);
    for (const degrees of [0, 30, 45, 60, 90, 180, 270]) {
      const n = normalizeForSave(toLDraw(rotationAxisAngle([0, 0, 1], degrees)));
      expect(normalizeForSave(n)).toEqual(n);
      expect(n.some((v) => Object.is(v, -0))).toBe(false);
    }
    expect(normalizeForSave(toLDraw(rotationAxisAngle([0, 0, 1], 45)))[3]).toBe(Math.SQRT1_2);
    expect(normalizeForSave(toLDraw(rotationAxisAngle([0, 0, 1], 60)))[6]).toBe(Math.sqrt(3) / 2);
    const scaled = [0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 1];
    expect(normalizeForSave(scaled)).toEqual(scaled);
  });
  it('normalizes thousands of arbitrary repeated rotations to a serialization fixed point', () => {
    let matrix = identity();
    for (let i = 0; i < 3000; i++) matrix = multiply(rotationAxisAngle([1, 2, 3], 0.3), matrix);
    const values = normalizeForSave(toLDraw(matrix));
    expect(normalizeForSave(values)).toEqual(values);
    expect(determinant(fromLDraw(values))).toBeCloseTo(1, 10);
  });
  it('snaps positive and negative LDU values and rejects invalid grids', () => {
    expect(snapToGrid(29, 20)).toBe(20);
    expect(snapToGrid(-31, 20)).toBe(-40);
    expect(() => snapToGrid(2, 0)).toThrow();
    expect(() => fromLDraw([1])).toThrow();
  });
});
