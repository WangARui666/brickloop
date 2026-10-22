import { add, axes, cross, dot, length, perpendicular, scale, sub, unit } from './math.js';
import type { ColliderShape, CollisionStatus, Vec3 } from './types.js';

const EPSILON = 1e-8;
type Box = Extract<ColliderShape, { kind: 'box' }>;
type Cylinder = Extract<ColliderShape, { kind: 'cylinder' }>;

function boxBox(a: Box, b: Box): CollisionStatus {
  const aa = axes(a.rotation),
    bb = axes(b.rotation),
    delta = sub(b.center, a.center);
  const candidates = [...aa, ...bb, ...aa.flatMap((x) => bb.map((y) => cross(x, y)))];
  for (const axis of candidates) {
    const size = length(axis);
    if (size < EPSILON) continue;
    const reach =
      aa.reduce((sum, v, i) => sum + Math.abs(dot(v, axis)) * a.halfSize[i]!, 0) +
      bb.reduce((sum, v, i) => sum + Math.abs(dot(v, axis)) * b.halfSize[i]!, 0);
    if (Math.abs(dot(delta, axis)) >= reach - EPSILON * size) return 'none';
  }
  return 'hit';
}
function support(shape: ColliderShape, direction: Vec3): Vec3 {
  if (shape.kind === 'box')
    return axes(shape.rotation).reduce(
      (point, axis, i) => add(point, scale(axis, (dot(axis, direction) >= 0 ? 1 : -1) * shape.halfSize[i]!)),
      shape.center,
    );
  const along = dot(direction, shape.axis);
  const radial = sub(direction, scale(shape.axis, along));
  return add(
    add(shape.center, scale(shape.axis, along >= 0 ? shape.halfLength : -shape.halfLength)),
    scale(unit(radial), shape.radius),
  );
}
const triple = (a: Vec3, b: Vec3, c: Vec3): Vec3 => cross(cross(a, b), c);
function line(simplex: Vec3[]): Vec3 {
  const a = simplex[simplex.length - 1]!,
    b = simplex[simplex.length - 2]!;
  const ao = scale(a, -1),
    ab = sub(b, a);
  if (dot(ab, ao) <= 0) {
    simplex.splice(0, simplex.length, a);
    return ao;
  }
  const d = triple(ab, ao, ab);
  return length(d) < EPSILON ? perpendicular(ab) : d;
}
function triangle(simplex: Vec3[]): Vec3 {
  const [c, b, a] = simplex as [Vec3, Vec3, Vec3];
  const ab = sub(b, a),
    ac = sub(c, a),
    ao = scale(a, -1),
    normal = cross(ab, ac);
  if (dot(cross(normal, ac), ao) > 0) {
    if (dot(ac, ao) > 0) {
      simplex.splice(0, 3, c, a);
      return triple(ac, ao, ac);
    }
    simplex.splice(0, 3, b, a);
    return line(simplex);
  }
  if (dot(cross(ab, normal), ao) > 0) {
    simplex.splice(0, 3, b, a);
    return line(simplex);
  }
  if (dot(normal, ao) >= 0) return normal;
  simplex.splice(0, 3, b, c, a);
  return scale(normal, -1);
}
/** Support-mapped GJK for finite cylinders (flat caps), never capsules. */
function gjk(a: ColliderShape, b: ColliderShape): CollisionStatus {
  const minkowski = (d: Vec3): Vec3 => sub(support(a, d), support(b, scale(d, -1)));
  let direction = sub(b.center, a.center);
  if (length(direction) < EPSILON) direction = [1, 0, 0];
  const simplex: Vec3[] = [minkowski(direction)];
  direction = scale(simplex[0]!, -1);
  for (let iteration = 0; iteration < 64; iteration++) {
    if (length(direction) < EPSILON) return 'hit';
    direction = unit(direction);
    const next = minkowski(direction);
    if (dot(next, direction) <= EPSILON) return 'none';
    if (simplex.some((p) => length(sub(p, next)) < EPSILON)) return 'unknown';
    simplex.push(next);
    if (simplex.length === 2) direction = line(simplex);
    else if (simplex.length === 3) direction = triangle(simplex);
    else {
      const [d, c, b, a] = simplex as [Vec3, Vec3, Vec3, Vec3];
      const ao = scale(a, -1);
      let outside = false;
      for (const [p, q, opposite] of [
        [b, c, d],
        [c, d, b],
        [d, b, c],
      ] as [Vec3, Vec3, Vec3][]) {
        let normal = cross(sub(p, a), sub(q, a));
        if (dot(normal, sub(opposite, a)) > 0) normal = scale(normal, -1);
        if (dot(normal, ao) > EPSILON) {
          simplex.splice(0, 4, q, p, a);
          direction = triangle(simplex);
          outside = true;
          break;
        }
      }
      if (!outside) return 'hit';
    }
  }
  return 'unknown';
}
function parallelCylinders(a: Cylinder, b: Cylinder): CollisionStatus {
  const delta = sub(b.center, a.center),
    axial = dot(delta, a.axis);
  if (Math.abs(axial) >= a.halfLength + b.halfLength - EPSILON) return 'none';
  return length(sub(delta, scale(a.axis, axial))) < a.radius + b.radius - EPSILON ? 'hit' : 'none';
}
export function intersectShapes(a: ColliderShape, b: ColliderShape): CollisionStatus {
  if (a.kind === 'box' && b.kind === 'box') return boxBox(a, b);
  if (a.kind === 'cylinder' && b.kind === 'cylinder' && Math.abs(dot(a.axis, b.axis)) > 1 - 1e-12)
    return parallelCylinders(a, b);
  return gjk(a, b);
}
