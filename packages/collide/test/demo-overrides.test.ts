import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fromLDraw, identity, multiply, rotationAxisAngle, translation } from '@brickloop/core';
import type { Matrix4 } from '@brickloop/core';
import { buildPartMesh } from '@brickloop/ldraw';
import { createLibraryResolver } from '@brickloop/ldraw/node';
import { importPack } from '@brickloop/catalog';
import { buildCollider, CollisionWorld, intersectShapes } from '../src/index.js';
import { createOverrideLoader } from '../src/node.js';
import type { Collider } from '../src/index.js';
import { box } from './fixtures.js';

const ids = [
  '2357',
  '25269',
  '3045',
  '3046',
  '43093',
  '3749',
  '56145',
  '55982',
  '30027b',
  '60208',
  '6014a',
  '56898',
  '32607',
  '30176',
  '3818',
  '3819',
];
const resolver = createLibraryResolver({ libraryDir: path.resolve('library/ldraw') });
const loadOverride = createOverrideLoader(path.resolve('library/colliders'));
const proxies = new Map<string, Collider>();
async function load(id: string): Promise<Collider> {
  let proxy = proxies.get(id);
  if (!proxy) {
    proxy = await buildCollider(`${id}.dat`, resolver, await buildPartMesh(`${id}.dat`, resolver), { loadOverride });
    proxies.set(id, proxy);
  }
  return proxy;
}
interface Fit {
  id: string;
  mate: string;
  part?: Matrix4;
  mateAt: Matrix4;
  offset: [number, number, number];
}
// Coordinates come from DAT seats and primitive transforms, independently of
// the saved proxy shapes. Offsets deliberately put the mating stud/shaft in a wall.
const fits: Fit[] = [
  { id: '2357', mate: '3024', mateAt: translation([0, 24, 0]), offset: [10, 0, 0] },
  { id: '25269', mate: '3024', mateAt: translation([0, 8, 0]), offset: [0, 0, 8] },
  { id: '3045', mate: '3024', mateAt: translation([0, -8, 0]), offset: [8, 0, 0] },
  { id: '3046', mate: '3024', mateAt: translation([0, -8, 0]), offset: [8, 0, 0] },
  ...['43093', '3749'].map((id): Fit => ({
    id,
    mate: '32316',
    part: fromLDraw([0, -10, 0, 0, 1, 0, -1, 0, 0, 0, 0, 1]),
    mateAt: identity(),
    offset: [5, 0, 0],
  })),
  { id: '56145', mate: '44309', mateAt: identity(), offset: [12, 0, 0] },
  { id: '55982', mate: '30648', mateAt: identity(), offset: [8, 0, 0] },
  // 4600's right wheel pin starts at (22,5,0) and points along +X.
  {
    id: '30027b',
    mate: '4600',
    mateAt: multiply(translation([0, -5, 32]), rotationAxisAngle([0, 1, 0], 90)),
    offset: [5, 0, 0],
  },
  {
    id: '6014a',
    mate: '4600',
    mateAt: multiply(translation([0, -5, 30]), rotationAxisAngle([0, 1, 0], 90)),
    offset: [5, 0, 0],
  },
  { id: '60208', mate: '56898', mateAt: translation([0, 0, -7]), offset: [10, 0, 0] },
  { id: '56898', mate: '60208', mateAt: translation([0, 0, 7]), offset: [10, 0, 0] },
  { id: '32607', mate: '3024', mateAt: translation([0, 8, 0]), offset: [7, 0, 0] },
  { id: '30176', mate: '3024', mateAt: translation([0, 24, 0]), offset: [7, 0, 0] },
  ...(['3818', '3819'] as const).map((id): Fit => ({
    id,
    mate: '3820',
    mateAt: multiply(translation([id === '3818' ? -5 : 5, 18.9, -9.9]), rotationAxisAngle([1, 0, 0], 45)),
    offset: [4, 0, 0],
  })),
  ...(['3818', '3819'] as const).map((id): Fit => ({
    id,
    mate: '973',
    part: multiply(
      translation([id === '3818' ? -15.528 : 15.528, 8.881, 0]),
      rotationAxisAngle([0, 0, 1], id === '3818' ? 9.782 : -9.782),
    ),
    mateAt: identity(),
    offset: [id === '3818' ? -6 : 6, 0, 0],
  })),
  ...['3045', '3046'].map((id): Fit => ({ id, mate: '3022', mateAt: translation([10, 24, -10]), offset: [10, 0, 0] })),
];
describe('M3-1b authored demo proxies', () => {
  beforeAll(async () => {
    for (const id of new Set(fits.flatMap((f) => [f.id, f.mate]))) await load(id);
  }, 60_000);
  it.each(fits)('$id with $mate: connected clears and a displaced mate hits', ({ id, mate, part, mateAt, offset }) => {
    const proxy = proxies.get(id)!;
    expect(proxy.source).toBe('manual');
    expect(proxy.approximate).toBe(false);
    expect(proxy.shapes.length).toBeGreaterThan(1);
    expect(proxies.get(mate)!.approximate).toBe(false);
    const world = new CollisionWorld({
      instances: [
        { path: ['part'], collider: proxy, transform: part ?? identity() },
        { path: ['mate'], collider: proxies.get(mate)!, transform: mateAt },
      ],
    });
    expect(world.query(['part'], { budgetMs: 5000 }).status).toBe('none');
    world.set({ path: ['mate'], collider: proxies.get(mate)!, transform: multiply(translation(offset), mateAt) });
    expect(world.query(['part'], { budgetMs: 5000 }).status).toBe('hit');
  });
  it('automatic wheel-pin lobes survive voxel resolution while their axial slot stays open', () => {
    const pin = proxies.get('4600')!;
    expect(pin.source).toBe('generated');
    expect(pin.shapes.some((s) => s.kind === 'cylinder' && s.center[0] > 22)).toBe(true);
    const slot = box([28, 5, 0], [2, 0.25, 0.25]);
    expect(pin.shapes.every((s) => intersectShapes(s, slot) === 'none')).toBe(true);
    for (const z of [-2.5, 2.5]) {
      const lobe = box([28, 5, z], [2, 0.25, 0.25]);
      expect(pin.shapes.some((s) => intersectShapes(s, lobe) === 'hit')).toBe(true);
    }
  });
  it('every one of the 222 pack parts has a nonempty, non-approximate effective proxy', async () => {
    const result = await importPack(path.resolve('library/packs/demo'), { libraryDir: path.resolve('library/ldraw') });
    expect(result.pack!.parts).toHaveLength(222);
    const manual: string[] = [];
    for (const part of result.pack!.parts) {
      const id = part.partId.slice(3);
      const proxy = await load(id);
      expect(proxy.shapes.length, id).toBeGreaterThan(0);
      expect(proxy.approximate, `${id}: ${proxy.diagnostics.join(',')}`).toBe(false);
      if (proxy.source === 'manual') manual.push(id);
    }
    expect(manual.sort()).toEqual([...ids, '3001', '3020'].sort());
  }, 60_000);
  it('the original open-surface evidence is covered exactly by the sixteen new files', async () => {
    const evidence = JSON.parse(await fs.readFile('packages/collide/evidence/generation.json', 'utf8')) as {
      records: { partId: string; approximate: boolean }[];
    };
    expect(
      evidence.records
        .filter((r) => r.approximate)
        .map((r) => r.partId.slice(3))
        .sort(),
    ).toEqual([...ids].sort());
  });
});
