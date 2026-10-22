import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { gridToLdu } from '../../ai/src/coordinates.js';
import { multiply, translation, rotationAxisAngle, transformPoint } from '../../core/src/math/index.js';
import { build, catalog } from './fixtures.js';

// Lock the test to the actual host helper so a changed host convention cannot silently
// leave this independent geometry test green. No desktop implementation is modified.
it('host place_part uses direct origin translation and upward-axis rotation', () => {
  const source = readFileSync('apps/desktop/src/renderer/src/ai-editor-host.ts', 'utf8');
  expect(source).toContain('gridToLdu({ x: pose.x, z: pose.z, level: pose.level })');
  expect(source).toContain(
    'multiply(translation([p.x_ldu, p.y_ldu, p.z_ldu]), rotationAxisAngle([0, -1, 0], pose.rotY))',
  );
  expect(source).toContain('else transform = poseTransform(p.pose)');
});
for (const id of ['3001', '3020', '3068b'])
  for (const rotY of [0, 90] as const)
    it(`${id}, rotY ${rotY}: host transform puts the body on y0 and covers exactly the voxel cells`, async () => {
      const p = catalog.parts.find((p) => p.id === id)!,
        s = p.size!,
        w = rotY === 0 ? s.w : s.d,
        d = rotY === 0 ? s.d : s.w,
        x0 = -3,
        z0 = 7,
        y0 = 6;
      // For square tiles, rotate the voxel shape to exercise the explicit 90° origin pose too.
      const result = await build(
        `box(${x0},${z0},${y0},${w},${d},${s.h},'red');pack({top:'${p.kind === 'tile' ? 'tiles' : 'studs'}'});`,
        { catalog: { ...catalog, parts: [p] } },
      );
      expect(result.instances).toHaveLength(1);
      const pose =
        s.w === s.d && rotY === 90
          ? (await build(`part('${id}',{x:${x0 + w / 2},z:${z0 + d / 2},y:${y0 + s.h},rotY:90},'red')`)).instances[0]!
              .pose
          : result.instances[0]!.pose;
      if (s.w !== s.d) expect(result.instances[0]!.pose.rotY).toBe(rotY);
      expect(pose).toEqual({ x: x0 + w / 2, z: z0 + d / 2, level: y0 + s.h, rotY });
      const t = gridToLdu({ x: pose.x, z: pose.z, level: pose.level }),
        matrix = multiply(translation([t.x_ldu, t.y_ldu, t.z_ldu]), rotationAxisAngle([0, -1, 0], pose.rotY));
      // Public LDraw body bounds: origin at top, bottom +8h; studs are outside body volume.
      const corners = [];
      for (const x of [-s.w * 10, s.w * 10])
        for (const y of [0, s.h * 8])
          for (const z of [-s.d * 10, s.d * 10]) corners.push(transformPoint(matrix, [x, y, z]));
      expect(Math.min(...corners.map((p) => p[0])) / 20).toBeCloseTo(x0);
      expect(Math.max(...corners.map((p) => p[0])) / 20).toBeCloseTo(x0 + w);
      expect(Math.min(...corners.map((p) => p[2])) / 20).toBeCloseTo(z0);
      expect(Math.max(...corners.map((p) => p[2])) / 20).toBeCloseTo(z0 + d);
      expect(-Math.max(...corners.map((p) => p[1])) / 8).toBeCloseTo(y0);
      expect(-Math.min(...corners.map((p) => p[1])) / 8).toBeCloseTo(y0 + s.h);
    });
