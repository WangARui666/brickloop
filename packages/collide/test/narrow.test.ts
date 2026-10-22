import { describe, expect, it } from 'vitest';
import { fromLDraw, multiply, rotationAxisAngle, translation } from '@brickloop/core';
import { intersectShapes } from '../src/index.js';
import { transformShape } from '../src/math.js';
import { box, cylinder } from './fixtures.js';

describe('finite-shape narrow phase', () => {
  it('OBB SAT tests face normals and cross-product axes; contact is not penetration', () => {
    expect(intersectShapes(box(), box([9, 0, 0]))).toBe('hit');
    expect(intersectShapes(box(), box([10, 0, 0]))).toBe('none');
    const rotated = transformShape(
      box([0, 0, 0], [10, 1, 1]),
      multiply(translation([0, 0, 8]), rotationAxisAngle([0, 1, 0], 45)),
    ).shape;
    expect(intersectShapes(box(), rotated)).toBe('hit');
  });
  it('box-cylinder respects flat caps and radial corners', () => {
    const c = cylinder([0, 0, 0], [0, 1, 0], 3, 5);
    expect(intersectShapes(box([0, 10.1, 0]), c)).toBe('none');
    expect(intersectShapes(box([7, 0, 7]), c)).toBe('hit');
    expect(intersectShapes(box([7.2, 0, 7.2]), c)).toBe('none');
    expect(intersectShapes(box([0, 0, 0], [1, 1, 1]), c)).toBe('hit');
  });
  it('parallel, antiparallel and crossing cylinders', () => {
    expect(intersectShapes(cylinder(), cylinder([0, 0, 0], [0, -1, 0]))).toBe('hit');
    expect(intersectShapes(cylinder(), cylinder([6, 0, 0]))).toBe('none');
    expect(intersectShapes(cylinder(), cylinder([0, 10, 0]))).toBe('none');
    expect(intersectShapes(cylinder(), cylinder([0, 0, 0], [1, 0, 0]))).toBe('hit');
    expect(intersectShapes(cylinder(), cylinder([0, 0, 7], [1, 0, 0]))).toBe('none');
  });
  it('is symmetric and invariant under a common rigid transform', () => {
    const transform = multiply(translation([37, -15, 83]), rotationAxisAngle([1, 2, 3], 41));
    for (let i = 0; i < 40; i++) {
      const a = i % 2 ? box([0, 0, 0], [3, 4, 2]) : cylinder();
      const b = cylinder(
        [Math.sin(i) * 10, Math.cos(i * 2) * 10, Math.sin(i * 3) * 10],
        [Math.SQRT1_2, Math.SQRT1_2, 0],
      );
      const status = intersectShapes(a, b);
      expect(status).not.toBe('unknown');
      expect(intersectShapes(b, a)).toBe(status);
      expect(intersectShapes(transformShape(a, transform).shape, transformShape(b, transform).shape)).toBe(status);
    }
  });
  it('preserves reflections and flags shear / elliptical cylinders as approximate', () => {
    const mirror = fromLDraw([0, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(transformShape(box(), mirror).approximate).toBe(false);
    const shear = fromLDraw([0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1]);
    expect(transformShape(box(), shear).approximate).toBe(true);
    const stretch = fromLDraw([0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(transformShape(cylinder(), stretch).approximate).toBe(true);
  });
});
