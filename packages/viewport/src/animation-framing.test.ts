import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import type { AnimationBounds } from '@brickloop/animation';
import { fitAnimationOrbit } from './animation-framing';

describe('constant animation framing', () => {
  for (const [name, bounds] of [
    ['wide flat building', { min: [-900, -40, -450], max: [900, 0, 450] }],
    ['tall tower', { min: [-60, -1600, -60], max: [60, 0, 60] }],
  ] as const)
    for (const overlay of [true, false])
      for (const motion of ['drop', 'appear', 'fly'] as const) {
        it(`${name}, ${motion}, captions=${overlay}: all path samples inside safe area and tight`, () => {
          const timeline = {
            bounds: bounds as AnimationBounds,
            parts: [
              {
                bounds,
                offset:
                  motion === 'drop'
                    ? ([0, -144, 0] as const)
                    : motion === 'appear'
                      ? ([0, 0, 0] as const)
                      : ([300, -200, 300] as const),
              },
            ],
          };
          const original = JSON.stringify(timeline);
          const frame = fitAnimationOrbit(timeline, overlay);
          const camera = new PerspectiveCamera(frame.fov, 16 / 9, 0.1, 100000);
          let left = 1,
            right = 0,
            top = 1,
            bottom = 0;
          for (let degrees = 0; degrees <= 450; degrees += 5) {
            camera.position
              .copy(frame.direction)
              .multiplyScalar(frame.distance)
              .applyAxisAngle(new Vector3(0, 1, 0), (degrees * Math.PI) / 180)
              .add(frame.target);
            camera.lookAt(frame.target);
            camera.updateMatrixWorld(true);
            // Construct expected corners independently of the production envelope.
            const points = [0, 1].flatMap((start) =>
              [bounds.min[0], bounds.max[0]].flatMap((x) =>
                [bounds.min[1], bounds.max[1]].flatMap((y) =>
                  [bounds.min[2], bounds.max[2]].map((z) => {
                    const offset = timeline.parts[0]!.offset;
                    return new Vector3(x + start * offset[0], -y - start * offset[1], -z - start * offset[2]);
                  }),
                ),
              ),
            );
            for (const point of points) {
              const ndc = point.project(camera),
                x = (ndc.x + 1) / 2,
                y = (1 - ndc.y) / 2;
              expect(x).toBeGreaterThanOrEqual(frame.safe.left - 1e-8);
              expect(x).toBeLessThanOrEqual(frame.safe.right + 1e-8);
              expect(y).toBeGreaterThanOrEqual(frame.safe.top - 1e-8);
              expect(y).toBeLessThanOrEqual(frame.safe.bottom + 1e-8);
              left = Math.min(left, x);
              right = Math.max(right, x);
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
            }
          }
          expect(
            Math.min(
              left - frame.safe.left,
              frame.safe.right - right,
              top - frame.safe.top,
              frame.safe.bottom - bottom,
            ),
          ).toBeLessThan(0.02);
          expect((top + bottom) / 2).toBeCloseTo((frame.safe.top + frame.safe.bottom) / 2, 6);
          expect(JSON.stringify(timeline)).toBe(original);
          expect(fitAnimationOrbit(timeline, overlay)).toEqual(frame);
        });
      }
});
