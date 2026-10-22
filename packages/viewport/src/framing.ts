import { Vector3 } from 'three/webgpu';
import { ldrawToWorld } from './coordinates';
import type { Point3 } from './coordinates';

export type ViewPreset = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';
export interface Bounds {
  min: Point3;
  max: Point3;
}
export interface Frame {
  position: Vector3;
  target: Vector3;
  up: Vector3;
  orthoHeight: number;
  near: number;
  far: number;
}
export interface FrameOptions {
  bounds: Bounds;
  fov: number;
  aspect: number;
  direction: Point3;
  up?: Point3;
  padding?: number;
}

export function boundsCorners(bounds: Bounds): Vector3[] {
  return [bounds.min.x, bounds.max.x].flatMap((x) =>
    [bounds.min.y, bounds.max.y].flatMap((y) => [bounds.min.z, bounds.max.z].map((z) => new Vector3(x, y, z))),
  );
}

/** World-space bounds -> camera frame. No scene state or mutation of inputs. */
export function fitBounds({
  bounds,
  fov,
  aspect,
  direction,
  up = { x: 0, y: 1, z: 0 },
  padding = 1 / 0.45,
}: FrameOptions): Frame {
  if (!(fov > 0 && fov < 180 && Number.isFinite(aspect) && aspect > 0 && padding >= 1)) {
    throw new RangeError('Invalid framing parameters');
  }
  const corners = boundsCorners(bounds);
  if (
    corners.some((p) => !p.toArray().every(Number.isFinite)) ||
    bounds.min.x > bounds.max.x ||
    bounds.min.y > bounds.max.y ||
    bounds.min.z > bounds.max.z
  ) {
    throw new RangeError('Bounds must be finite and ordered');
  }
  const target = new Vector3().addVectors(bounds.min, bounds.max).multiplyScalar(0.5);
  const backward = new Vector3().copy(direction).normalize();
  if (backward.lengthSq() === 0 || !backward.toArray().every(Number.isFinite))
    throw new RangeError('Camera direction must be finite and nonzero');
  const orbitUp = new Vector3().copy(up).normalize();
  const right = new Vector3().crossVectors(orbitUp, backward);
  if (right.lengthSq() < 1e-10) {
    orbitUp.set(0, 0, 1);
    if (Math.abs(backward.z) > 0.99) orbitUp.set(0, 1, 0);
    right.crossVectors(orbitUp, backward);
  }
  right.normalize();
  const cameraUp = new Vector3().crossVectors(backward, right).normalize();
  const tanY = Math.tan((fov * Math.PI) / 360);
  // Size the whole projection against the viewport's short side, leaving room for the grid.
  const shortSide = Math.min(1, aspect);
  const tanShort = tanY * shortSide;
  let distance = 1;
  let halfHeight = 0.5;
  let depth = 0;
  for (const corner of corners) {
    const relative = corner.sub(target);
    const x = Math.abs(relative.dot(right));
    const y = Math.abs(relative.dot(cameraUp));
    const z = relative.dot(backward);
    distance = Math.max(distance, z + (padding * Math.max(x, y)) / tanShort);
    halfHeight = Math.max(halfHeight, (padding * Math.max(x, y)) / shortSide);
    depth = Math.max(depth, Math.abs(z));
  }
  distance = Math.max(distance, depth + 1);
  return {
    position: target.clone().addScaledVector(backward, distance),
    target,
    up: orbitUp,
    orthoHeight: halfHeight * 2,
    near: Math.max(0.01, (distance - depth) / 10),
    far: Math.max(100, (distance + depth) * 10),
  };
}

const directions: Record<ViewPreset, Point3> = {
  front: { x: 0, y: 0, z: -1 },
  back: { x: 0, y: 0, z: 1 },
  left: { x: -1, y: 0, z: 0 },
  right: { x: 1, y: 0, z: 0 },
  top: { x: 0, y: -1, z: 0 },
  bottom: { x: 0, y: 1, z: 0 },
  iso: { x: 1, y: -1, z: -1 },
};

export function presetFrame(bounds: Bounds, fov: number, aspect: number, preset: ViewPreset): Frame {
  const up =
    preset === 'top' ? { x: 0, y: 0, z: 1 } : preset === 'bottom' ? { x: 0, y: 0, z: -1 } : { x: 0, y: -1, z: 0 };
  return fitBounds({ bounds, fov, aspect, direction: ldrawToWorld(directions[preset]), up: ldrawToWorld(up) });
}

/** Match the vertical span through the orbit target when changing projection. */
export function perspectiveSpan(distance: number, fov: number): number {
  return 2 * distance * Math.tan((fov * Math.PI) / 360);
}
export function perspectiveDistance(span: number, fov: number): number {
  return span / (2 * Math.tan((fov * Math.PI) / 360));
}
