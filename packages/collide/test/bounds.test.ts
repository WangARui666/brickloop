import { expect, it } from 'vitest';
import { identity, multiply, rotationAxisAngle, transformPoint, translation } from '@brickloop/core';
import { transformBounds } from '../src/math.js';
import type { Aabb } from '../src/types.js';

it('bounds match explicit corner transforms for affine, reflected, degenerate and projective matrices', () => {
  const bounds: Aabb = [-17, -3, -29, 41, 13, 7];
  const matrices = [identity()];
  for (let angle = 0; angle < 360; angle += 13) {
    const matrix = multiply(translation([angle, -angle / 3, angle * 2]), rotationAxisAngle([1, 2, 3], angle));
    matrices.push(matrix);
    const affine = matrix.slice();
    affine[0] = affine[0]! * -2;
    affine[5] = 0;
    affine[8] = affine[8]! + 0.25;
    matrices.push(affine);
    const projective = affine.slice();
    projective[3] = 0.001;
    projective[7] = -0.002;
    matrices.push(projective);
  }
  for (const matrix of matrices) {
    const points: ReturnType<typeof transformPoint>[] = [];
    for (const x of [bounds[0], bounds[3]])
      for (const y of [bounds[1], bounds[4]])
        for (const z of [bounds[2], bounds[5]]) points.push(transformPoint(matrix, [x, y, z]));
    expect(transformBounds(bounds, matrix)).toEqual([
      ...[0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]!))),
      ...[0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]!))),
    ]);
  }
});
