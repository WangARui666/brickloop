import { Vector3 } from 'three/webgpu';
import type { AnimationBounds, AnimationPart } from '@brickloop/animation';

interface FrameInput {
  bounds: AnimationBounds;
  parts: readonly Pick<AnimationPart, 'bounds' | 'offset'>[];
}

const up = new Vector3(0, 1, 0);
// A modest 19.5° elevation keeps architecture readable while leaving room for
// the drop starts; the old 27° view spent much of the height on the ground plane.
export const animationOrbitDirection = () => new Vector3(-1, 0.5, 1).normalize();
type Projection = { y: number; z: number };
// Perspective extrema occur on this convex hull. Keeping it small matters for
// fly-in starts, where every part can have a distinct height and radial offset.
function projectionHull(points: Projection[]): Projection[] {
  points.sort((a, b) => a.z - b.z || a.y - b.y);
  const turn = (a: Projection, b: Projection, c: Projection) => (b.z - a.z) * (c.y - a.y) - (b.y - a.y) * (c.z - a.z);
  const half = (items: Projection[]) => {
    const result: Projection[] = [];
    for (const p of items) {
      while (result.length > 1 && turn(result.at(-2)!, result.at(-1)!, p) <= 0) result.pop();
      result.push(p);
    }
    return result.slice(0, -1);
  };
  return [...half(points), ...half([...points].reverse())];
}

/** World-space corners of the finished box and actual motion-start envelope. No scene/DOM access. */
export function animationFramePoints(timeline: FrameInput): Vector3[] {
  const { min, max } = timeline.bounds;
  const corners = (lo: readonly number[], hi: readonly number[]) =>
    [lo[0]!, hi[0]!].flatMap((x) =>
      [lo[1]!, hi[1]!].flatMap((y) => [lo[2]!, hi[2]!].map((z) => new Vector3(x, -y, -z))),
    );
  const points = corners(min, max);
  // Retain each height's actual footprint: raising the entire final box by
  // 144 LDU would invent wide corners above a narrow roof ridge/tower spire.
  const starts = new Map<string, { min: number[]; max: number[] }>();
  for (const part of timeline.parts) {
    const lo = part.bounds.min.map((v, i) => v + part.offset[i]!),
      hi = part.bounds.max.map((v, i) => v + part.offset[i]!);
    if (lo.every((v, i) => v >= min[i]!) && hi.every((v, i) => v <= max[i]!)) continue;
    const key = `${lo[1]}/${hi[1]}`;
    const box = starts.get(key);
    if (box)
      for (let i = 0; i < 3; i++) {
        box.min[i] = Math.min(box.min[i]!, lo[i]!);
        box.max[i] = Math.max(box.max[i]!, hi[i]!);
      }
    else starts.set(key, { min: lo, max: hi });
  }
  for (const box of starts.values()) points.push(...corners(box.min, box.max));
  return points;
}

/** Minimum constant distance with a vertically centered projection envelope.
 * Sample the full 90° build + 360° finale at 5°. The returned target/distance are
 * invariant for the entire timeline. Only a setting/aspect change recalculates them. */
export function fitAnimationOrbit(timeline: FrameInput, overlay = true, aspect = 16 / 9) {
  const points = animationFramePoints(timeline),
    fov = 35;
  const { min, max } = timeline.bounds;
  const target = new Vector3((min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -(min[2] + max[2]) / 2);
  const direction = animationOrbitDirection(),
    sin = direction.y,
    cos = Math.hypot(direction.x, direction.z);
  const tanY = Math.tan((fov * Math.PI) / 360),
    tanX = tanY * aspect;
  const safe = { left: 0.08, right: 0.92, top: overlay ? 0.16 : 0.08, bottom: 0.92 };
  const lower = 1 - 2 * safe.bottom,
    upper = 1 - 2 * safe.top;
  const path = [];
  for (let degrees = 0; degrees <= 450; degrees += 5) {
    const back = direction.clone().applyAxisAngle(up, (degrees * Math.PI) / 180);
    const right = up.clone().cross(back).normalize(),
      vertical = back.clone().cross(right);
    path.push({ back, right, vertical });
  }
  let horizontal = -Infinity,
    depth = -Infinity;
  const extremes: Projection[] = [];
  for (const point of points) {
    const relative = point.clone().sub(target);
    let nearest = { y: 0, z: -Infinity },
      furthest = { y: 0, z: Infinity };
    for (const { back, right, vertical } of path) {
      const x = relative.dot(right),
        y = relative.dot(vertical),
        z = relative.dot(back);
      horizontal = Math.max(horizontal, z + Math.abs(x) / (0.84 * tanX));
      depth = Math.max(depth, z);
      if (z > nearest.z) nearest = { y, z };
      if (z < furthest.z) furthest = { y, z };
    }
    // With fixed elevation, all azimuths of one world point form a straight
    // segment in (depth, vertical) coordinates: its endpoints suffice.
    extremes.push(nearest, furthest);
  }
  const projections = projectionHull(extremes);
  let upperSupport = -Infinity,
    lowerSupport = Infinity;
  for (const p of projections) {
    upperSupport = Math.max(upperSupport, p.y + upper * tanY * p.z);
    lowerSupport = Math.min(lowerSupport, p.y + lower * tanY * p.z);
  }
  function atDistance(distance: number) {
    let low = Math.max(
        (upperSupport - upper * tanY * distance) / (cos + upper * tanY * sin),
        (depth - distance + 0.1) / sin,
      ),
      high = (lowerSupport - lower * tanY * distance) / (cos + lower * tanY * sin);
    if (low > high) return undefined;
    // The y translation is shared by all azimuths. Center the union of their
    // perspective projections, accounting for the depth change from translation.
    for (let iteration = 0; iteration < 40; iteration++) {
      const shift = (low + high) / 2;
      let bottom = Infinity,
        top = -Infinity;
      for (const p of projections) {
        const y = (p.y - shift * cos) / ((distance - p.z + shift * sin) * tanY);
        bottom = Math.min(bottom, y);
        top = Math.max(top, y);
      }
      if (bottom + top > lower + upper) low = shift;
      else high = shift;
    }
    const shift = (low + high) / 2;
    if (distance + shift * sin < horizontal) return undefined;
    return shift;
  }
  let low = 0,
    high = 1;
  while (atDistance(high) === undefined) high *= 2;
  for (let iteration = 0; iteration < 45; iteration++) {
    const middle = (low + high) / 2;
    if (atDistance(middle) === undefined) low = middle;
    else high = middle;
  }
  target.y += atDistance(high)!;
  return { target, distance: high, direction, fov, safe };
}
