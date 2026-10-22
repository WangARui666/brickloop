import { it, expect } from 'vitest';
import { runBuildScript } from '../src/index.js';
import { build, cells, catalog, options } from './fixtures.js';
import { Budget } from '../src/limits.js';
import { Voxels } from '../src/voxels.js';
import { graph } from '../src/quality.js';
import { makePacked } from '../src/packing.js';

it('quantifies seams across actual courses: 20×10×9 has no seam through three courses', async () => {
  const result = await build(`box(0,0,0,20,10,9,'red')`);
  expect(cells(result).size).toBe(1800);
  expect(result.stats.quality).toMatchObject({
    seamsThroughThreeCourses: 0,
    maxSeamCourses: 2,
    floatingComponents: 0,
    components: 1,
  });
  expect((await build(`box(0,0,0,10,6,9,'red')`)).stats.quality.seamsThroughThreeCourses).toBe(0);
});
it('reports unavoidable seams when the available catalog has only one footprint', async () => {
  const restricted = { ...catalog, parts: catalog.parts.filter((p) => p.id === '3003') };
  const result = await build(`box(0,0,0,4,4,9,'red')`, { catalog: restricted });
  expect(result.stats.quality.seamsThroughThreeCourses).toBeGreaterThan(0);
});
it('floating components report bounds and a concrete support suggestion', async () => {
  const result = await build(`box(0,0,0,4,2,3,'red');box(10,4,9,4,2,3,'blue')`);
  expect(result.stats.quality.floatingComponents).toBe(1);
  expect(result.warnings).toContainEqual(
    expect.objectContaining({
      code: 'FLOATING_COMPONENT',
      bounds: { x: 10, z: 4, y: 9, w: 4, d: 2, h: 3 },
      message: expect.stringContaining('support'),
    }),
  );
});
it('graph counts a single stud overlap and an articulation point independently', () => {
  const c = { id: 'x', w: 2, d: 1, h: 1, rotY: 0 as const, kind: 'plate' as const };
  const ps = [makePacked(c, 0, 0, 0, '4', null), makePacked(c, 1, 1, 0, '4', null), makePacked(c, 2, 2, 0, '4', null)];
  expect(graph(ps, new Budget(undefined)).weak).toEqual({ singleStud: 2, articulationPoints: 1, total: 3 });
});
it('strengthens a deliberately narrow two-stud strip by re-covering adjacent courses', async () => {
  const r = await build(`box(0,0,0,2,5,4,'red');pack({prefer:'plates'})`);
  expect(cells(r).size).toBe(40);
  expect(r.stats.quality.weakBefore.total).toBeGreaterThan(0);
  expect(r.stats.quality.weakAfter.total).toBeLessThan(r.stats.quality.weakBefore.total);
  expect(r.stats.quality.repairedRegions).toBeGreaterThan(0);
  expect(r.stats.quality.floatingComponents).toBe(0);
});
it('reduces single-stud connections while preserving the exact narrow-strip volume', async () => {
  const r = await build(`box(0,0,0,5,1,3,'red');pack({prefer:'plates'})`);
  expect(cells(r).size).toBe(15);
  expect(r.stats.quality.weakBefore.singleStud).toBe(3);
  expect(r.stats.quality.weakAfter.singleStud).toBe(2);
  expect(r.stats.quality.repairedRegions).toBe(1);
});
it('hollow retains shell and default 6×6 columns; support can be disabled', async () => {
  const supported = await build(`box(0,0,0,14,14,9,'red');pack({hollow:true})`),
    v = cells(supported);
  expect(v.has('6,4,6')).toBe(true);
  expect(v.has('5,4,5')).toBe(false);
  expect(v.has('5,0,5')).toBe(true);
  const empty = cells(await build(`box(0,0,0,14,14,9,'red');pack({hollow:true,support:false})`));
  expect(empty.has('6,4,6')).toBe(false);
  expect(v.size).toBeGreaterThan(empty.size);
  const custom = cells(await build(`box(0,0,0,14,14,9,'red');pack({hollow:true,shell:2,support:{spacing:4,width:2}})`));
  expect(custom.has('5,4,5')).toBe(true);
  expect(custom.has('1,4,5')).toBe(true);
  expect(custom.has('6,4,6')).toBe(false);
});
it('sparse chunks store 2,000,000 voxels within the host memory budget', () => {
  const budget = new Budget({ cpuMs: 10_000 }),
    v = new Voxels(budget);
  for (let y = 0; y < 200; y++) for (let z = 0; z < 100; z++) for (let x = 0; x < 100; x++) v.set(x, y, z, '4');
  expect(v.size).toBe(2_000_000);
  expect(budget.bytes).toBeLessThan(24 * 1024 * 1024);
  expect(() => v.set(101, 0, 0, '4')).toThrow('Voxel limit');
});
it('tiles do not connect pieces above them', async () => {
  const r = await build(`part('3068b',{x:1,z:1,y:1},'red');part('3003',{x:1,z:1,y:4},'red')`);
  expect(r.stats.quality.floatingComponents).toBe(1);
});
it('catalog intersection never manufactures missing pieces', async () => {
  const r = await runBuildScript(`cell(0,0,0,'red')`, {
    ...options,
    catalog: { ...catalog, parts: catalog.parts.filter((p) => p.id === '3001') },
  });
  expect(r).toMatchObject({ ok: false, code: 'PART_NOT_ALLOWED' });
});
