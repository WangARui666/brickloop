import { transformDirection, transformPoint } from '@brickloop/core';
import type { Matrix4 } from '@brickloop/core';
import { IDENTITY_ROTATION } from './types.js';
import type { Aabb, ColliderShape, Rotation, Vec3 } from './types.js';

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(...a);
export const unit = (a: Vec3): Vec3 => scale(a, 1 / (length(a) || 1));
export const axes = (r: Rotation): [Vec3, Vec3, Vec3] => [
  [r[0], r[1], r[2]],
  [r[3], r[4], r[5]],
  [r[6], r[7], r[8]],
];
export const perpendicular = (v: Vec3): Vec3 => unit(cross(v, Math.abs(v[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0]));
export const overlaps = (a: Aabb, b: Aabb): boolean =>
  a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2];
export const union = (a: Aabb, b: Aabb): Aabb => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.min(a[2], b[2]),
  Math.max(a[3], b[3]),
  Math.max(a[4], b[4]),
  Math.max(a[5], b[5]),
];
export function shapeBounds(shape: ColliderShape): Aabb {
  const extent: Vec3 = [0, 0, 0];
  if (shape.kind === 'box') {
    const basis = axes(shape.rotation);
    for (let i = 0; i < 3; i++)
      extent[i] = basis.reduce((sum, axis, j) => sum + Math.abs(axis[i]!) * shape.halfSize[j]!, 0);
  } else {
    for (let i = 0; i < 3; i++)
      extent[i] =
        Math.abs(shape.axis[i]!) * shape.halfLength + Math.sqrt(Math.max(0, 1 - shape.axis[i]! ** 2)) * shape.radius;
  }
  return [...sub(shape.center, extent), ...add(shape.center, extent)];
}
export function shapesBounds(shapes: readonly ColliderShape[]): Aabb | undefined {
  return shapes.map(shapeBounds).reduce<Aabb | undefined>((box, next) => (box ? union(box, next) : next), undefined);
}
export function boxFromBounds(b: Aabb, inset = 0): ColliderShape | undefined {
  const halfSize: Vec3 = [(b[3] - b[0]) / 2 - inset, (b[4] - b[1]) / 2 - inset, (b[5] - b[2]) / 2 - inset];
  if (halfSize.some((v) => v <= 0)) return undefined;
  return {
    kind: 'box',
    center: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2],
    halfSize,
    rotation: [...IDENTITY_ROTATION],
  };
}
export function transformBounds(b: Aabb, m: Matrix4): Aabb {
  // Same eight corners (including homogeneous division), without allocating
  // point/map arrays for every shape-tree query.
  const result: Aabb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let xi = 0; xi < 2; xi++)
    for (let yi = 0; yi < 2; yi++)
      for (let zi = 0; zi < 2; zi++) {
        const x = b[xi * 3]!,
          y = b[1 + yi * 3]!,
          z = b[2 + zi * 3]!;
        const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
        for (let axis = 0; axis < 3; axis++) {
          const value = (m[axis]! * x + m[4 + axis]! * y + m[8 + axis]! * z + m[12 + axis]!) / w;
          result[axis] = Math.min(result[axis]!, value);
          result[axis + 3] = Math.max(result[axis + 3]!, value);
        }
      }
  return result;
}
/** Affine transforms that cannot retain box/cylinder semantics get a conservative AABB. */
export function transformShape(shape: ColliderShape, m: Matrix4): { shape: ColliderShape; approximate: boolean } {
  const center = transformPoint(m, shape.center);
  const basis =
    shape.kind === 'box'
      ? axes(shape.rotation)
      : ([perpendicular(shape.axis), shape.axis, cross(perpendicular(shape.axis), shape.axis)] as [Vec3, Vec3, Vec3]);
  const transformed = basis.map((axis) => transformDirection(m, axis));
  const sizes = transformed.map(length);
  const normalized = transformed.map(unit);
  const orthogonal =
    sizes.every((s) => s > 1e-12) &&
    Math.abs(dot(normalized[0]!, normalized[1]!)) < 1e-8 &&
    Math.abs(dot(normalized[0]!, normalized[2]!)) < 1e-8 &&
    Math.abs(dot(normalized[1]!, normalized[2]!)) < 1e-8;
  if (orthogonal && shape.kind === 'box')
    return {
      shape: {
        ...shape,
        center,
        rotation: normalized.flat() as Rotation,
        halfSize: shape.halfSize.map((s, i) => s * sizes[i]!) as Vec3,
      },
      approximate: false,
    };
  if (orthogonal && shape.kind === 'cylinder' && Math.abs(sizes[0]! - sizes[2]!) < 1e-8)
    return {
      shape: {
        ...shape,
        center,
        axis: normalized[1]!,
        radius: shape.radius * sizes[0]!,
        halfLength: shape.halfLength * sizes[1]!,
      },
      approximate: false,
    };
  const bounds = transformBounds(shapeBounds(shape), m);
  // Degenerate affine geometry still has a finite conservative envelope.
  const fallback = boxFromBounds(bounds) ?? {
    kind: 'box' as const,
    center,
    halfSize: [1e-9, 1e-9, 1e-9] as Vec3,
    rotation: [...IDENTITY_ROTATION] as Rotation,
  };
  return { shape: fallback, approximate: true };
}
