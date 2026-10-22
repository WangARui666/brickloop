import { it, expect } from 'vitest';
import { build, cells, catalog } from './fixtures.js';

it('BS-01 box covers volume exactly, using bricks and no overlap', async () => {
  const result = await build(`box(0,0,0,10,6,9,'red')`);
  expect(cells(result).size).toBe(540);
  expect(Object.keys(result.stats.byKind)).toEqual(['brick']);
});
it('prism scanlines handle concave polygons', async () => {
  const r = await build(`prism([[0,0],[3,0],[3,1],[1,1],[1,3],[0,3]],0,1,'red')`);
  expect(cells(r).size).toBe(5);
  expect(cells(r).has('2,0,2')).toBe(false);
});
it('wall openings use path distance and absolute plate y', async () => {
  const r = await build(`wall([[0,0.5],[8,0.5]],0,6,'red',{openings:[{at:2,width:2,y:0,h:3}]})`),
    v = cells(r);
  expect(v.size).toBe(42);
  expect(v.has('2,0,0')).toBe(false);
  expect(v.has('2,3,0')).toBe(true);
});
it('cylinder hollow keeps a one-stud wall', async () => {
  const solid = await build(`cylinder(0,0,0,4,3,'red')`),
    hollow = await build(`cylinder(0,0,0,4,3,'red',{hollow:true})`);
  expect(cells(solid).has('0,0,0')).toBe(true);
  expect(cells(hollow).has('0,0,0')).toBe(false);
  expect(hollow.stats.voxels).toBeLessThan(solid.stats.voxels);
});
it('BS-02 interpolates twelve onion layers with <=0.5-stud row contour error and a closed tip', async () => {
  const profile = [
    [0, 2],
    [3, 4],
    [6, 3],
    [10, 1],
    [11, 0.5],
  ];
  const v = cells(await build(`revolve(0.5,0.5,0,${JSON.stringify(profile)},'red')`));
  for (let y = 0; y < 12; y++) {
    const s = profile.findIndex((p, i) => i < profile.length - 1 && y >= p[0]! && y <= profile[i + 1]![0]!);
    const [a, ra] = profile[s]!,
      [b, rb] = profile[s + 1]!,
      r = ra! + ((rb! - ra!) * (y - a!)) / (b! - a!);
    const xs = [...v.keys()]
      .map((k) => k.split(',').map(Number))
      .filter((p) => p[1] === y && p[2] === 0)
      .map((p) => p[0]!);
    expect(Math.abs(Math.max(...xs) + 0.5 - r)).toBeLessThanOrEqual(0.5 + 1e-9);
    for (let z = -Math.floor(r); z <= Math.floor(r); z++) {
      const row = [...v.keys()]
        .map((k) => k.split(',').map(Number))
        .filter((p) => p[1] === y && p[2] === z)
        .map((p) => p[0]!);
      const ideal = Math.sqrt(r * r - z * z);
      expect(Math.abs(Math.max(...row) + 0.5 - ideal)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(Math.abs(Math.min(...row) - 0.5 + ideal)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
    if (y === 11) expect(xs).toEqual([0]);
  }
});
it('sphere uses physical 8/20 plate-to-stud height and symmetry', async () => {
  const v = cells(await build(`sphere(0,0,0,2,'red')`));
  expect(v.has('0,4,0')).toBe(true);
  expect(v.has('0,5,0')).toBe(false);
  for (const k of v.keys()) {
    const [x, y, z] = k.split(',').map(Number);
    expect(v.has(`${-x! - 1},${-y! - 1},${-z! - 1}`)).toBe(true);
  }
});
it('heightmap accepts colors and callback colors with x,z,y arguments', async () => {
  expect(cells(await build(`heightmap(2,3,[[1,2],[0,3]],'red')`)).size).toBe(6);
  const v = cells(await build(`heightmap(2,3,[[1,2]],(x,z,y)=>y===1?'blue':'red')`));
  expect(v.get('3,1,3')).toBe('1');
  expect(v.get('2,0,3')).toBe('4');
});
it('cell overwrites, clear handles cells, boxes and named shapes', async () => {
  const r = await build(
    `box(0,0,0,4,4,1,'red');cell(0,0,0,'blue');clear(1,0,1);clear(2,2,0,2,2,1);clear('cylinder',0.5,0.5,0,0.5,1);`,
  );
  expect(cells(r).size).toBe(10);
  expect(cells(r).has('0,0,0')).toBe(false);
});
it('nested rotations, translation and mirrors preserve voxel geometry', async () => {
  const r = await build(
    `transform({dx:10,dz:2,dy:3,rotY:90},()=>transform({mirrorX:true},()=>box(0,0,0,2,1,1,'red')))`,
  );
  expect([...cells(r).keys()].sort()).toEqual(['9,3,0', '9,3,1']);
});
it('top tiles and regional top selection reserve visible top plates', async () => {
  const r = await build(`box(0,0,0,4,4,4,'red');pack({top:[{x:0,z:0,w:2,d:4,top:'tiles'}]})`);
  expect(cells(r).size).toBe(64);
  expect(
    r.instances
      .filter((i) => catalog.parts.find((p) => p.id === i.partId)!.kind === 'tile')
      .reduce((sum, i) => {
        const s = catalog.parts.find((p) => p.id === i.partId)!.size!;
        return sum + s.w * s.d;
      }, 0),
  ).toBe(8);
});
