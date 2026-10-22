// Authored dimensions, not a copy of automatic voxel output. Regenerates the three reviewable JSON assets.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { colliderFileName, IDENTITY_ROTATION, parseColliderOverride } from '../src/index.js';
import type { ColliderOverride, ColliderShape } from '../src/index.js';

const directory = fileURLToPath(new URL('../../../library/colliders/', import.meta.url));
const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number): ColliderShape => ({
  kind: 'box',
  center: [x, y, z],
  halfSize: [hx, hy, hz],
  rotation: [...IDENTITY_ROTATION],
});
function ring(
  x: number,
  y: number,
  z: number,
  radius: number,
  radialHalf: number,
  tangentHalf: number,
  heightHalf: number,
): ColliderShape[] {
  return Array.from({ length: 32 }, (_, i) => {
    const angle = (i * Math.PI) / 16,
      c = Math.cos(angle),
      s = Math.sin(angle);
    return {
      kind: 'box',
      center: [x + radius * c, y, z + radius * s],
      halfSize: [radialHalf, heightHalf, tangentHalf],
      rotation: [c, 0, s, 0, 1, 0, -s, 0, c],
    };
  });
}
function rectangular(height: number): ColliderShape[] {
  const y = (height + 4) / 2,
    h = (height - 4) / 2 - 0.5;
  const shapes = [
    box(0, 2, 0, 39.5, 1.5, 19.5),
    box(-38, y, 0, 1.5, h, 19.5),
    box(38, y, 0, 1.5, h, 19.5),
    box(0, y, -18, 35.5, h, 1.5),
    box(0, y, 18, 35.5, h, 1.5),
  ];
  for (const x of [-30, -10, 10, 30])
    for (const z of [-10, 10])
      shapes.push({ kind: 'cylinder', center: [x, -2, z], axis: [0, 1, 0], radius: 5.5, halfLength: 1.5 });
  for (const x of [-20, 0, 20]) shapes.push(...ring(x, y, 0, 7, 0.35, 0.9, h));
  return shapes;
}
const overrides: ColliderOverride[] = [
  {
    schema: 1,
    version: 1,
    partId: 'ld:3001',
    approximate: false,
    notes:
      '人工尺寸：2×4砖的4 LDU顶板、4 LDU侧壁、三条外径16/内径12底管；32段内接盒保留底管孔，凸点与各实体表面至少内缩0.5 LDU。省去体素阶梯，明确底腔。尺寸依据LDraw 3001.dat及s/3001s01.dat。',
    shapes: rectangular(24),
  },
  {
    schema: 1,
    version: 1,
    partId: 'ld:3020',
    approximate: false,
    notes:
      '人工尺寸：2×4板的4 LDU顶板、4 LDU侧壁和三条短底管；保留浅底腔，防止粗体素吞掉管壁。表面至少内缩0.5 LDU。尺寸依据LDraw 3020.dat及其子文件。',
    shapes: rectangular(8),
  },
  {
    schema: 1,
    version: 1,
    partId: 'ld:85861',
    approximate: false,
    notes:
      '人工尺寸：1×1开孔圆板，顶凸点半径4至6，盘体半径4至10，底管半径6至8；分段内接盒保留贯通杆孔及底腔，表面至少内缩0.5 LDU。尺寸依据LDraw 85861.dat、stud2a.dat和stud4.dat。',
    shapes: [
      ...ring(0, -2, 0, 5, 0.35, 0.5, 1.5),
      ...ring(0, 1.5, 0, 7, 2.35, 0.9, 1),
      ...ring(0, 5.5, 0, 7, 0.35, 0.9, 2),
    ],
  },
];
await mkdir(directory, { recursive: true });
for (const override of overrides) {
  parseColliderOverride(override);
  await writeFile(path.join(directory, colliderFileName(override.partId)), JSON.stringify(override, null, 2) + '\n');
  console.log(`${override.partId}: ${override.shapes.length} authored shapes`);
}
