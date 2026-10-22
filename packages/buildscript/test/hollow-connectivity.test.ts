import { it, expect } from 'vitest';
import { getExample } from '../src/index.js';
import type { BuildResult } from '../src/index.js';
import { build, cells, catalog } from './fixtures.js';
import { Budget } from '../src/limits.js';
import { Voxels } from '../src/voxels.js';
import { hollow as hollowVolume } from '../src/hollow.js';

function preservesExterior(solid: BuildResult, hollow: BuildResult) {
  const source = cells(solid),
    result = cells(hollow);
  // Every retained/restored cell has its original color; no exterior air is filled.
  for (const [k, color] of result) expect(source.get(k), k).toBe(color);
  for (const [k, color] of source) {
    const [x, y, z] = k.split(',').map(Number) as [number, number, number];
    const neighbors = [
      [x - 1, y, z],
      [x + 1, y, z],
      [x, y - 1, z],
      [x, y + 1, z],
      [x, y, z - 1],
      [x, y, z + 1],
    ];
    if (neighbors.some((p) => !source.has(p.join(',')))) expect(result.get(k), `exterior ${k}`).toBe(color);
  }
  expect(result.size).toBeLessThan(source.size);
  expect(hollow.stats.quality.hollow.addedVoxels).toBeGreaterThan(0);
  expect(hollow.stats.quality.hollow.partsAfter).toBe(hollow.stats.parts);
  expect(hollow.stats.quality.hollow.partsDelta).toBe(hollow.stats.parts - hollow.stats.quality.hollow.partsBefore);
}

it('hollow onion tower has zero floating components, with the same exterior and original colors', async () => {
  const code = getExample('onion-tower')!.code;
  const hollow = await build(code),
    solid = await build(code.replace('hollow:true', 'hollow:false'));
  expect(hollow.stats.quality.floatingComponents).toBe(0);
  expect(hollow.stats.quality.hollow.coreVoxels).toBeGreaterThan(0);
  expect(hollow.stats.quality.hollow.coreVoxels).toBeLessThan(hollow.stats.quality.hollow.addedVoxels);
  expect(hollow.stats.quality.hollow.partsDelta).toBeGreaterThan(0);
  preservesExterior(solid, hollow);
  // The local core repair must not silently fill the entire tower.
  expect(cells(hollow).has('1,10,1')).toBe(false);
});

it('hollow sphere has zero floating components while retaining its air cavity', async () => {
  const code = `sphere(0,10,0,4,'red');`;
  const hollow = await build(`${code}pack({hollow:true})`),
    solid = await build(code);
  expect(hollow.stats.quality.floatingComponents).toBe(0);
  expect(hollow.stats.quality.bridgedRegions).toBeGreaterThan(0);
  preservesExterior(solid, hollow);
  expect((await build(`${code}pack({hollow:true})`)).hash).toBe(hollow.hash);
});
it.each([2, 3, 6, 8])('keeps hollow spheres of radius %s connected', async (radius) => {
  const r = await build(`sphere(0,${radius / 0.4},0,${radius},'red');pack({hollow:true})`);
  expect(r.stats.quality.floatingComponents).toBe(0);
  expect(r.stats.quality.hollow.addedVoxels).toBeGreaterThan(0);
  expect(cells(r).size).toBe(r.stats.voxels);
});

it('rejecting a core trial restores exact colors without removing an earlier accepted core', () => {
  const v = new Voxels(new Budget(undefined));
  for (let y = 0; y < 9; y++)
    for (let z = 0; z < 5; z++) for (let x = 0; x < 5; x++) v.set(x, y, z, y % 2 ? 'red' : 'blue');
  const plan = hollowVolume(v, { hollow: true })!;
  plan.thicken();
  expect(plan.restoreCore(new Set([4]))).toBe(9);
  plan.acceptCore();
  const snapshot = () =>
    v
      .sortedLevels()
      .flatMap((y) => [...v.cells(y)].map(([x, z, c]) => `${x},${y},${z}:${v.colors[c]}`))
      .sort();
  const accepted = snapshot();
  expect(plan.restoreCore(new Set([5]))).toBe(9);
  plan.removeCore();
  expect(snapshot()).toEqual(accepted);
  expect(v.colors[v.get(2, 4, 2)]).toBe('blue');
  expect(v.get(2, 5, 2)).toBe(0);
  plan.release();
});

it('the hollow repair also applies to a standalone expanding and contracting profile', async () => {
  const code = `revolve(0.5,0.5,0,[[0,2],[3,4],[6,3],[10,1],[11,0.5]],'blue');`;
  const hollow = await build(`${code}pack({hollow:true})`);
  expect(hollow.stats.quality.floatingComponents).toBe(0);
  preservesExterior(await build(code), hollow);
});

it('non-hollow overhangs are re-covered across courses without adding or recoloring voxels', async () => {
  const r = await build(`revolve(0.5,0.5,0,[[0,2],[3,4],[6,3],[10,1],[11,0.5]],'blue')`);
  expect(r.stats.quality.floatingComponents).toBe(0);
  expect(r.stats.quality.bridgedRegions).toBeGreaterThan(0);
  expect(cells(r).size).toBe(280);
  expect(new Set(cells(r).values())).toEqual(new Set(['1']));
  expect(r.stats.quality.hollow).toEqual({
    addedVoxels: 0,
    coreVoxels: 0,
    partsBefore: 0,
    partsAfter: 0,
    partsDelta: 0,
  });
});

it('support:false disables extra core filling and preserves impossible-connection warnings', async () => {
  const code = getExample('onion-tower')!.code.replace('support:6', 'support:false');
  const r = await build(code);
  expect(r.stats.quality.hollow.coreVoxels).toBe(0);
  expect(r.stats.quality.hollow.addedVoxels).toBeGreaterThan(0);
  expect(cells(r).has('0,10,0')).toBe(false);
});

it('when available pieces cannot bridge an overhang, warnings identify its exact location', async () => {
  const r = await build(`cell(0,0,0,'red');box(0,0,1,2,1,1,'red');pack({prefer:'plates'})`, {
    catalog: { ...catalog, parts: catalog.parts.filter((p) => p.id === '3024') },
  });
  expect(r.stats.quality.floatingComponents).toBe(1);
  expect(r.warnings.find((w) => w.code === 'FLOATING_COMPONENT')!.bounds).toEqual({
    x: 1,
    y: 1,
    z: 0,
    w: 1,
    d: 1,
    h: 1,
  });
});
