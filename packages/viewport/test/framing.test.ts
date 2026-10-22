import { describe, expect, it } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { boundsCorners, fitBounds, perspectiveDistance, perspectiveSpan, presetFrame } from '../src/framing';
import type { Bounds, ViewPreset } from '../src/framing';

const bounds: Bounds[] = [
  { min: { x: -40, y: 0, z: -20 }, max: { x: 40, y: 24, z: 20 } },
  { min: { x: 100, y: -15, z: -400 }, max: { x: 102, y: 350, z: 1100 } },
  { min: { x: 7, y: 8, z: 9 }, max: { x: 7, y: 8, z: 9 } },
  { min: { x: -20000, y: -10000, z: -10000 }, max: { x: 30000, y: 25000, z: 20000 } },
];
const presets: ViewPreset[] = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'];

describe('camera framing', () => {
  for (const preset of presets) {
    it(`${preset}: all eight corners fit both projections at wide and narrow aspects`, () => {
      for (const box of bounds)
        for (const aspect of [0.25, 0.65, 1, 2.5]) {
          const frame = presetFrame(box, 35, aspect, preset);
          const half = frame.orthoHeight / 2;
          const cameras = [
            new PerspectiveCamera(35, aspect, frame.near, frame.far),
            new OrthographicCamera(-half * aspect, half * aspect, half, -half, frame.near, frame.far),
          ];
          for (const camera of cameras) {
            camera.position.copy(frame.position);
            camera.up.copy(frame.up);
            camera.lookAt(frame.target);
            camera.updateMatrixWorld();
            for (const corner of boundsCorners(box)) {
              const projected = corner.project(camera);
              expect(Math.abs(projected.x)).toBeLessThanOrEqual(1);
              expect(Math.abs(projected.y)).toBeLessThanOrEqual(1);
              expect(Math.abs(projected.z)).toBeLessThanOrEqual(1);
            }
            const center = frame.target.clone().project(camera);
            expect(center.x).toBeCloseTo(0, 10);
            expect(center.y).toBeCloseTo(0, 10);
          }
        }
    });
  }
  it('keeps the existing viewing direction and does not mutate inputs', () => {
    const direction = new Vector3(-4, 2, -3);
    const box = structuredClone(bounds[0]!);
    const result = fitBounds({ bounds: box, fov: 60, aspect: 1.2, direction });
    expect(
      result.position.clone().sub(result.target).normalize().distanceTo(direction.clone().normalize()),
    ).toBeLessThan(1e-10);
    expect(direction.toArray()).toEqual([-4, 2, -3]);
    expect(box).toEqual(bounds[0]);
  });
  it('leaves the placeholder at about 45% of the short side in every preset and projection', () => {
    for (const preset of presets)
      for (const aspect of [0.65, 1, 2.5]) {
        const box = bounds[0]!;
        const frame = presetFrame(box, 35, aspect, preset);
        const half = frame.orthoHeight / 2;
        for (const camera of [
          new PerspectiveCamera(35, aspect, frame.near, frame.far),
          new OrthographicCamera(-half * aspect, half * aspect, half, -half, frame.near, frame.far),
        ]) {
          camera.position.copy(frame.position);
          camera.up.copy(frame.up);
          camera.lookAt(frame.target);
          camera.updateMatrixWorld();
          const projected = boundsCorners(box).map((corner) => corner.project(camera));
          const width =
            ((Math.max(...projected.map((p) => p.x)) - Math.min(...projected.map((p) => p.x))) * aspect) / 2;
          const height = (Math.max(...projected.map((p) => p.y)) - Math.min(...projected.map((p) => p.y))) / 2;
          const fraction = Math.max(width, height) / Math.min(1, aspect);
          expect(fraction).toBeGreaterThan(0.4);
          expect(fraction).toBeLessThanOrEqual(0.45 + 1e-10);
        }
      }
  });
  it('keeps target-plane framing through a projection round trip, including orthographic zoom', () => {
    for (const distance of [1, 100, 10000])
      for (const fov of [20, 35, 90]) {
        const span = perspectiveSpan(distance, fov);
        expect(perspectiveDistance(span, fov)).toBeCloseTo(distance, 10);
        expect(perspectiveDistance(span / 2, fov)).toBeCloseTo(distance / 2, 10);
      }
  });
  it('rejects unusable framing parameters', () => {
    for (const aspect of [0, -1, NaN, Infinity]) {
      expect(() => presetFrame(bounds[0]!, 35, aspect, 'iso')).toThrow(RangeError);
    }
    expect(() => presetFrame(bounds[0]!, 180, 1, 'iso')).toThrow(RangeError);
  });
});
