import { it, expect } from 'vitest';
import { runBuildScript } from '../src/index.js';
import { build, catalog, options } from './fixtures.js';

it('submodels preserve local geometry and nested placements are checked in world coordinates', async () => {
  const r = await build(`
    submodel('piece',()=>box(0,0,0,4,2,3,'red'));
    submodel('pair',()=>{instance('piece',{x:0,z:0,y:0});instance('piece',{x:0,z:0,y:3});});
    instance('pair',{x:10,z:4,y:0,rotY:90});
    instance('piece',{x:20,z:0,y:9});
  `);
  expect(r.instances).toHaveLength(1);
  expect(r.instances[0]!.submodel).toBe('piece');
  expect(r.submodels.find((m) => m.name === null)!.instances).toHaveLength(2);
  expect(r.stats.quality).toMatchObject({ components: 2, floatingComponents: 1, connections: 1 });
  expect(r.warnings.find((w) => w.code === 'FLOATING_COMPONENT')!.bounds).toEqual({
    x: 20,
    z: 0,
    y: 9,
    w: 4,
    d: 2,
    h: 3,
  });
});
it('invalid references, cycles and expanded output bombs fail atomically', async () => {
  expect(await runBuildScript(`instance('missing',{})`, options)).toMatchObject({ ok: false, code: 'RUNTIME' });
  expect(await runBuildScript(`submodel('a',()=>instance('a',{}));`, options)).toMatchObject({
    ok: false,
    code: 'RUNTIME',
  });
  expect(
    await runBuildScript(`submodel('a',()=>box(0,0,0,4,4,3,'red'));for(let i=0;i<3;i++)instance('a',{})`, {
      ...options,
      limits: { maxParts: 5 },
    }),
  ).toMatchObject({ ok: false, code: 'LIMIT' });
});
it('explicit parts use origin coordinates and nested rotations', async () => {
  const r = await build(`transform({dx:2,dz:4,dy:3,rotY:90},()=>part('3001',{x:1,z:2,y:3,rotY:90},'red'))`);
  expect(r.instances[0]!.pose).toEqual({ x: 0, z: 5, level: 6, rotY: 180 });
});
it('mirrors rectangular standard parts exactly through their equivalent rotation', async () => {
  const r = await build(`transform({mirrorX:true},()=>part('3001',{x:2,z:1,y:3,rotY:90},'red'))`);
  expect(r.instances[0]!.pose).toEqual({ x: -2, z: 1, level: 3, rotY: 90 });
});
it('preserves reflections of asymmetric parts and submodel placements as host LDraw matrices', async () => {
  const data = {
    ...catalog,
    parts: [
      ...catalog.parts,
      {
        id: 'custom',
        name: 'Asymmetric fixture',
        category: 'other',
        kind: 'other' as const,
        size: { w: 2, d: 1, h: 1 },
        factory: true,
      },
    ],
  };
  const r = await build(
    `
    submodel('leaf',()=>box(0,0,0,2,1,1,'red'));
    transform({mirrorX:true,dx:10},()=>{
      part('custom',{x:2,z:1,y:1,rotY:90},'red');
      instance('leaf',{x:2,z:1,y:9,rotY:90});
    });`,
    { catalog: data },
  );
  expect(r.instances.find((i) => i.partId === 'custom')!.pose.matrixLdu).toEqual([
    160, -8, 20, 0, 0, 1, 0, 1, 0, 1, 0, 0,
  ]);
  expect(r.submodels.find((m) => m.name === null)!.instances[0]!.pose.matrixLdu).toEqual([
    160, -72, 20, 0, 0, 1, 0, 1, 0, 1, 0, 0,
  ]);
  expect(r.warnings.find((w) => w.code === 'FLOATING_COMPONENT')!.bounds).toEqual({
    x: 8,
    z: 1,
    y: 9,
    w: 1,
    d: 2,
    h: 1,
  });
});
it('also interrupts exponential hierarchies of empty models', async () => {
  const code = `submodel('a0',()=>{});for(let i=1;i<35;i++)submodel('a'+i,()=>{instance('a'+(i-1),{});instance('a'+(i-1),{});});instance('a34',{});`;
  expect(await runBuildScript(code, { ...options, limits: { cpuMs: 40 } })).toMatchObject({
    ok: false,
    code: 'TIMEOUT',
  });
});
it('parts.find filters available category, dimensions and tags and caps at 50', async () => {
  const data = {
    ...catalog,
    parts: Array.from({ length: 70 }, (_, i) => ({
      id: String(i),
      name: `Brick ${i}`,
      category: 'brick',
      kind: 'brick' as const,
      size: { w: 2, d: 1, h: 3 },
      tags: ['small'],
      factory: i < 60,
    })),
  };
  await build(
    `const found=parts.find({category:'brick',size:{w:2},tags:['small']});
    if(found.length!==50||found[0].id!=='0'||found[0].size.h!==3)throw Error('query');
    if(parts.find({size:{w:4}}).length)throw Error('size');`,
    { catalog: data },
  );
});
it('color mapping honors factory scope, exact names, Lab distance and warnings', async () => {
  const data = {
    ...catalog,
    colors: [...catalog.colors, { id: 'purple', name: 'Purple', rgb: '#800080', factory: false }],
  };
  const r = await build(`cell(0,0,0,color('#800080'));cell(1,0,0,'purple')`, { catalog: data });
  expect(r.instances.every((i) => i.colorId !== 'purple')).toBe(true);
  expect(r.warnings.some((w) => w.code === 'COLOR_DISTANCE')).toBe(true);
  const all = await build(`cell(0,0,0,'Purple')`, { catalog: data, scope: 'all' });
  expect(all.instances[0]!.colorId).toBe('purple');
});
