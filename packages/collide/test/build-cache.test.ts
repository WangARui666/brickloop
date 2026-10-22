import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPartMesh, LibraryResolver } from '@brickloop/ldraw';
import { buildCollider, colliderFileName, parseColliderOverride } from '../src/index.js';
import { createColliderCache, createOverrideLoader } from '../src/node.js';
import { box, emptyMesh } from './fixtures.js';

const cube =
  '0 cube\n0 BFC CERTIFY CCW\n4 16 -10 -10 -10 -10 -10 10 -10 10 10 -10 10 -10\n4 16 10 -10 -10 10 10 -10 10 10 10 10 -10 10\n4 16 -10 -10 -10 10 -10 -10 10 -10 10 -10 -10 10\n4 16 -10 10 -10 -10 10 10 10 10 10 10 10 -10\n4 16 -10 -10 -10 -10 10 -10 10 10 -10 10 -10 -10\n4 16 -10 -10 10 10 -10 10 10 10 10 -10 10 10';
const resolver = new LibraryResolver({ embedded: { 'cube.dat': cube } });
const manual = { schema: 1, version: 1, partId: 'ld:cube', approximate: false, shapes: [box()] };
describe('generation and versioned overrides', () => {
  it('merges a closed solid into an inset box and keeps configurable resolution deterministic', async () => {
    const mesh = await buildPartMesh('cube.dat', resolver);
    const result = await buildCollider('cube.dat', resolver, mesh);
    expect(result).toMatchObject({
      source: 'generated',
      approximate: false,
      shapes: [{ kind: 'box', center: [0, 0, 0], halfSize: [9.5, 9.5, 9.5] }],
    });
    expect(await buildCollider('cube.dat', resolver, mesh)).toEqual(result);
    expect((await buildCollider('cube.dat', resolver, mesh, { resolution: 4 })).source).toBe('generated');
  });
  it('falls back honestly for missing faces, incomplete dependencies or voxel limits', async () => {
    expect(await buildCollider('cube.dat', resolver, emptyMesh())).toMatchObject({ source: 'bbox', approximate: true });
    const mesh = await buildPartMesh('cube.dat', resolver);
    expect((await buildCollider('cube.dat', resolver, mesh, { maxVoxels: 1 })).diagnostics).toEqual(['voxel-limit']);
    mesh.diagnostics.missing = [['cube.dat', 'missing.dat']];
    expect((await buildCollider('cube.dat', resolver, mesh)).diagnostics).toEqual(['incomplete-geometry']);
  });
  it('manual overrides win even with missing mesh, validate version/axes, and are not inset twice', async () => {
    expect(
      await buildCollider('cube.dat', resolver, emptyMesh(), { loadOverride: () => Promise.resolve(manual) }),
    ).toMatchObject({ source: 'manual', shapes: [box()] });
    expect(() => parseColliderOverride({ ...manual, schema: 2 })).toThrow();
    expect(() => parseColliderOverride({ ...manual, version: 0 })).toThrow();
    expect(() => parseColliderOverride(manual, 'ld:wrong')).toThrow();
    expect(() =>
      parseColliderOverride({
        ...manual,
        shapes: [{ kind: 'cylinder', center: [0, 0, 0], axis: [0, 2, 0], radius: 1, halfLength: 2 }],
      }),
    ).toThrow();
    expect(colliderFileName('ld:3001')).toBe('ld%3A3001.collider.json');
    expect(colliderFileName('cu:../part')).not.toContain('/');
  });
});

describe('disk cache follows mesh cache invalidation and corruption semantics', () => {
  let directory: string;
  beforeAll(async () => {
    const parent = path.resolve('.devdata/collide-tests');
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(path.join(parent, 'cache-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it('hits warm cache and invalidates for mesh, config, PartId, primitive source and override version', async () => {
    const cache = createColliderCache(directory),
      mesh = await buildPartMesh('cube.dat', resolver);
    const cold = await cache.build('cube.dat', resolver, mesh);
    expect(cold.cacheHit).toBe(false);
    expect((await cache.build('cube.dat', resolver, mesh)).cacheHit).toBe(true);
    expect((await cache.build('cube.dat', resolver, mesh, { partId: 'cu:other' })).key).not.toBe(cold.key);
    expect((await cache.build('cube.dat', resolver, mesh, { resolution: 4 })).key).not.toBe(cold.key);
    const changedSource = new LibraryResolver({
      embedded: { 'cube.dat': cube + '\n0 changed primitive name metadata' },
    });
    expect((await cache.build('cube.dat', changedSource, mesh)).key).not.toBe(cold.key);
    const changedMesh = { ...mesh, bboxLdu: [-11, -10, -10, 10, 10, 10] as typeof mesh.bboxLdu };
    expect((await cache.build('cube.dat', resolver, changedMesh)).key).not.toBe(cold.key);
    const one = await cache.build('cube.dat', resolver, mesh, { loadOverride: () => Promise.resolve(manual) });
    const two = await cache.build('cube.dat', resolver, mesh, {
      loadOverride: () => Promise.resolve({ ...manual, version: 2 }),
    });
    expect(two.key).not.toBe(one.key);
    const file = path.join(directory, `${cold.key}.collider`),
      bytes = await readFile(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(file, bytes);
    expect(await cache.get(cold.key)).toBeUndefined();
    expect((await cache.build('cube.dat', resolver, mesh)).cacheHit).toBe(false);
    await expect(cache.get('../invalid')).rejects.toThrow();
  });
  it('reads encoded Windows-compatible filenames, reports invalid manual files rather than hiding them', async () => {
    const load = createOverrideLoader(directory);
    expect(await load('ld:absent')).toBeUndefined();
    const file = path.join(directory, colliderFileName(manual.partId));
    await writeFile(file, JSON.stringify(manual));
    expect(await load(manual.partId)).toEqual(manual);
    await writeFile(file, '{broken');
    await expect(load(manual.partId)).rejects.toThrow();
  });
});
