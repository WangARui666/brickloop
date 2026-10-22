import { describe, it, expect } from 'vitest';
import { runBuildScript } from '../src/index.js';
import { build, options, catalog } from './fixtures.js';

describe('QuickJS isolation and limits', () => {
  it('BS-03 exposes no network, filesystem, worker, timer or host global (including Function escape)', async () => {
    const result = await build(`
      for (const key of ['fetch','require','process','Worker','XMLHttpRequest','WebSocket','setTimeout','document','Buffer','__buildBridge'])
        if (typeof globalThis[key] !== 'undefined') throw Error(key);
      if (Function('return typeof process')() !== 'undefined') throw Error('escape');
      box(0,0,0,2,2,3,'red');
    `);
    expect(result.stats.parts).toBe(1);
  });
  it('interrupts infinite loops and remains usable', async () => {
    await build('');
    const start = performance.now();
    const result = await runBuildScript('while(true){}', { ...options, limits: { cpuMs: 40 } });
    expect(result).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(performance.now() - start).toBeLessThan(1000);
    expect((await build('cell(0,0,0,"red")')).stats.parts).toBe(1);
  });
  it('enforces QuickJS allocation limits', async () => {
    const result = await runBuildScript('new ArrayBuffer(8*1024*1024);', {
      ...options,
      limits: { memoryBytes: 4 * 1024 * 1024 },
    });
    expect(result).toMatchObject({ ok: false, code: 'MEMORY' });
  });
  it('includes host color caches and warnings in the memory budget', async () => {
    const result = await runBuildScript(`for(let i=0;i<20000;i++)color('#'+i.toString(16).padStart(6,'0'));`, {
      ...options,
      limits: { memoryBytes: 2 * 1024 * 1024 },
    });
    expect(result).toMatchObject({ ok: false, code: 'MEMORY' });
  });
  it('bounds host shape loops and voxel/part output even when errors are caught', async () => {
    expect(
      await runBuildScript(`try { box(0,0,0,100,100,100,'red') } catch(e) {}`, {
        ...options,
        limits: { maxVoxels: 32 },
      }),
    ).toMatchObject({ ok: false, code: 'LIMIT' });
    expect(
      await runBuildScript(`for(let i=0;i<3;i++)part('3001',{x:i*4,y:3},'red')`, {
        ...options,
        limits: { maxParts: 2 },
      }),
    ).toMatchObject({ ok: false, code: 'LIMIT' });
    expect(
      await runBuildScript(`box(0,0,0,1000000,1000000,1000000,'red')`, { ...options, limits: { cpuMs: 5 } }),
    ).toMatchObject({ ok: false, code: 'TIMEOUT' });
  });
  it('reports syntax/runtime source locations', async () => {
    expect(await runBuildScript('\n\nconst x = ;', options)).toMatchObject({ ok: false, code: 'SYNTAX', line: 3 });
    const result = await runBuildScript('\n\n  missing();', options);
    expect(result).toMatchObject({ ok: false, code: 'RUNTIME', line: 3 });
    expect(!result.ok && result.column).toBeGreaterThan(0);
    expect(await runBuildScript(`\n\nbox(0,0,0,-1,1,1,'red');`, options)).toMatchObject({
      ok: false,
      code: 'RUNTIME',
      line: 3,
    });
  });
  it('BS-04 deterministic RNG, Date, hash; different seed and color change output', async () => {
    const code = `if(Date.now()!==0||+new Date()!==0||+new (new Date().constructor)()!==0)throw Error('clock');
      for(let i=0;i<40;i++)cell(i,0,0,Math.random()<0.5?'red':'blue');`;
    const a = await build(code),
      b = await build(code),
      c = await build(code, { seed: 43 });
    expect(a.hash).toBe(b.hash);
    expect(a.instances).toEqual(b.instances);
    expect(a.hash).not.toBe(c.hash);
    expect((await build(`cell(0,0,0,'red')`)).hash).not.toBe((await build(`cell(0,0,0,'blue')`)).hash);
  });
  it('BS-05 fails atomically with <=3 closest allowed alternatives', async () => {
    const scoped = { ...catalog, parts: catalog.parts.map((p) => ({ ...p, factory: p.id !== '3001' })) };
    const r = await runBuildScript(`box(0,0,0,4,4,3,'red');part('3001',{y:3},'red')`, { ...options, catalog: scoped });
    expect(r).toMatchObject({ ok: false, code: 'PART_NOT_ALLOWED' });
    expect(r).not.toHaveProperty('instances');
    expect(!r.ok && r.suggestions).toHaveLength(3);
    expect(!r.ok && r.suggestions).not.toContain('3001');
  });
});
