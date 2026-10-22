import { determinant, identity } from '@brickloop/core';
import type { Matrix4 } from '@brickloop/core';
import { assertTransform } from './geometry';

/** A glTF matrix must be TRS. Two TRS nodes can represent a general nonsingular affine transform. */
export function gltfTransforms(matrix: Matrix4): Matrix4[] {
  assertTransform(matrix);
  const dot = (a: number, b: number) =>
    matrix[a]! * matrix[b]! + matrix[a + 1]! * matrix[b + 1]! + matrix[a + 2]! * matrix[b + 2]!;
  const pairs = [
    [0, 1],
    [0, 2],
    [1, 2],
  ] as const;
  if (pairs.every(([a, b]) => Math.abs(dot(a * 4, b * 4)) <= Math.sqrt(dot(a * 4, a * 4) * dot(b * 4, b * 4)) * 1e-8))
    return [matrix];

  // Jacobi eigendecomposition of AᵀA gives the right singular vectors V.
  // Then A = U Σ Vᵀ; UΣ and Vᵀ both have orthogonal columns and are valid glTF TRS matrices.
  const magnitude = Math.max(
    ...Array.from(matrix)
      .filter((_, i) => i % 4 < 3 && i < 12)
      .map(Math.abs),
  );
  const symmetric = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 3 }, (_, col) => dot(row * 4, col * 4) / magnitude ** 2),
  );
  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iteration = 0; iteration < 32; iteration++) {
    let p = 0,
      q = 1;
    for (const [a, b] of pairs)
      if (Math.abs(symmetric[a]![b]!) > Math.abs(symmetric[p]![q]!)) {
        p = a;
        q = b;
      }
    const off = symmetric[p]![q]!;
    if (Math.abs(off) < 1e-15) break;
    const angle = 0.5 * Math.atan2(2 * off, symmetric[q]![q]! - symmetric[p]![p]!);
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const pp = symmetric[p]![p]!,
      qq = symmetric[q]![q]!;
    symmetric[p]![p] = c * c * pp - 2 * c * s * off + s * s * qq;
    symmetric[q]![q] = s * s * pp + 2 * c * s * off + c * c * qq;
    symmetric[p]![q] = symmetric[q]![p] = 0;
    for (let k = 0; k < 3; k++) {
      if (k !== p && k !== q) {
        const kp = symmetric[k]![p]!,
          kq = symmetric[k]![q]!;
        symmetric[k]![p] = symmetric[p]![k] = c * kp - s * kq;
        symmetric[k]![q] = symmetric[q]![k] = s * kp + c * kq;
      }
      const vp = vectors[k]![p]!,
        vq = vectors[k]![q]!;
      vectors[k]![p] = c * vp - s * vq;
      vectors[k]![q] = s * vp + c * vq;
    }
  }
  const first = identity(),
    second = identity();
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) {
      first[col * 4 + row] = [0, 1, 2].reduce((sum, k) => sum + matrix[k * 4 + row]! * vectors[k]![col]!, 0);
      second[col * 4 + row] = vectors[col]![row]!;
    }
  first.set(matrix.subarray(12, 15), 12);
  // Keep the second node a proper rotation; put any reflection in the first node's scale.
  if (determinant(second) < 0) {
    for (let i = 0; i < 3; i++) {
      first[i] = -first[i]!;
      second[i * 4] = -second[i * 4]!;
    }
  }
  return [first, second];
}
