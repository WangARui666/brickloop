import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPartMesh, createMemorySource, LibraryResolver } from '../src/index.js';
import { createDirectorySource, createLibraryResolver, createMeshCache } from '../src/node.js';

const temporary: string[] = [];
async function temp(): Promise<string> {
  const parent = path.resolve('.devdata', 'ldraw-test');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, 'mesh-'));
  temporary.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});
const triangle = '0 BFC CERTIFY CCW\n3 16 0 0 0 1 0 0 0 1 0';

describe('disk cache and filesystem resolver', () => {
  it('round-trips typed arrays, isolates callers and discards corrupt/versioned files', async () => {
    const dir = await temp();
    const cache = createMeshCache(dir);
    const resolver = new LibraryResolver({ embedded: { 'x.dat': triangle } });
    const cold = await cache.build('X.DAT', resolver);
    expect(cold.cacheHit).toBe(false);
    const hot = await cache.build('x.dat', resolver);
    expect(hot.cacheHit).toBe(true);
    expect(hot.mesh).toEqual(cold.mesh);
    hot.mesh.batches[0]!.positions[0] = 100;
    expect((await cache.get(cold.key))!.batches[0]!.positions[0]).toBe(0);
    const file = path.join(dir, `${cold.key}.mesh`);
    const saved = await readFile(file);
    for (const corrupt of [Buffer.from('short'), Buffer.from(saved)]) {
      if (corrupt.length > 40) corrupt[7] = 0;
      await writeFile(file, corrupt);
      expect((await cache.build('x.dat', resolver)).cacheHit).toBe(false);
    }
    const checksumCorrupt = Buffer.from(saved);
    checksumCorrupt[checksumCorrupt.length - 1] = checksumCorrupt[checksumCorrupt.length - 1]! ^ 1;
    await writeFile(file, checksumCorrupt);
    expect((await cache.build('x.dat', resolver)).cacheHit).toBe(false);
    expect((await readdir(dir)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('invalidates on transitive source edits, added missing files, colour config, options and source priority', async () => {
    const dir = await temp();
    const cache = createMeshCache(dir);
    const files = new Map([
      ['parts/root.dat', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 leaf.dat'],
      ['p/leaf.dat', triangle],
    ]);
    const library = { id: 'library', readText: (name: string) => Promise.resolve(files.get(name)) };
    const resolver = new LibraryResolver({ library });
    const first = await cache.build('root.dat', resolver);
    files.set('p/leaf.dat', triangle.replace('1 0 0 0 1 0', '2 0 0 0 1 0'));
    const edited = await cache.build('root.dat', resolver);
    expect(edited.cacheHit).toBe(false);
    expect(edited.key).not.toBe(first.key);
    files.delete('p/leaf.dat');
    const missing = await cache.build('root.dat', resolver);
    expect(missing.mesh.diagnostics.missing).toHaveLength(1);
    files.set('p/leaf.dat', triangle);
    expect((await cache.build('root.dat', resolver)).mesh.diagnostics.missing).toEqual([]);
    files.set('ldconfig.ldr', '0 !COLOUR Red CODE 4 VALUE #FF0000 EDGE #123456');
    expect((await cache.build('root.dat', resolver)).key).not.toBe(first.key);
    const normal = await cache.build('root.dat', resolver);
    expect((await cache.build('root.dat', resolver, { highResPrimitives: true })).key).not.toBe(normal.key);
    expect((await cache.build('root.dat', resolver, { smoothingAngle: 45 })).key).not.toBe(normal.key);
    expect((await cache.build('root.dat', resolver, { maxDepth: 2 })).key).not.toBe(normal.key);
    files.set('parts/leaf.dat', triangle);
    expect((await cache.build('root.dat', resolver)).key).not.toBe(normal.key);
  });

  it('resolves mixed-case files, slash variants and observes edits/additions on disk', async () => {
    const dir = await temp();
    await mkdir(path.join(dir, 'Mixed'));
    await writeFile(path.join(dir, 'Mixed', 'Part.DAT'), triangle);
    const source = createDirectorySource(dir, 'custom');
    expect(await source.readText('MIXED\\PART.DAT')).toBe(triangle);
    expect(await source.readText('mixed/missing.dat')).toBeUndefined();
    await writeFile(path.join(dir, 'Mixed', 'missing.dat'), triangle);
    expect(await source.readText('mixed/missing.dat')).toBe(triangle);
    await expect(source.readText('../outside')).rejects.toThrow('relative filename');
  });

  it('allows separate cache entries for custom source precedence', async () => {
    const cache = createMeshCache(await temp());
    const a = createMemorySource('a', { 'part.dat': triangle });
    const b = createMemorySource('b', { 'part.dat': triangle });
    const first = await cache.build('part.dat', new LibraryResolver({ custom: [a, b] }));
    expect((await cache.build('part.dat', new LibraryResolver({ custom: [b, a] }))).key).not.toBe(first.key);
  });
});

const libraryDir = path.resolve('library', 'ldraw');
const hasLibrary = await access(path.join(libraryDir, 'parts', '3001.dat')).then(
  () => true,
  () => false,
);
if (!hasLibrary)
  process.stderr.write('[ldraw] Official library missing; G01 and performance cases skipped. Run pnpm ldraw:fetch.\n');
describe.skipIf(!hasLibrary)('official LDraw library', () => {
  it.each([
    ['3001.dat', [80, 28, 40]],
    ['3020.dat', [80, 12, 40]],
    ['stud.dat', [12, 4, 12]],
  ] as const)('G01 %s keeps LDraw coordinates and expected bbox', async (file, dimensions) => {
    const mesh = await buildPartMesh(file, createLibraryResolver({ libraryDir }));
    expect([
      mesh.bboxLdu[3] - mesh.bboxLdu[0],
      mesh.bboxLdu[4] - mesh.bboxLdu[1],
      mesh.bboxLdu[5] - mesh.bboxLdu[2],
    ]).toEqual(dimensions);
    expect(mesh.bboxLdu[1]).toBe(-4);
    expect(mesh.diagnostics.missing).toEqual([]);
    expect(mesh.diagnostics.cycles).toEqual([]);
    expect(mesh.diagnostics.warnings).toEqual([]);
    expect(mesh.doubleSided).toBe(false);
  });

  it('reads LDConfig and records cold builds/hot reads (no timing assertions)', async () => {
    const resolver = createLibraryResolver({ libraryDir });
    const colours = await resolver.loadColours();
    expect(colours.get(4)).toMatchObject({ code: 4, name: 'Red' });
    const cache = createMeshCache(await temp());
    for (const file of ['3001.dat', '3626.dat', '32523.dat']) {
      const start = performance.now();
      const cold = await cache.build(file, resolver);
      const built = performance.now();
      const hot = await cache.build(file, resolver);
      const checked = performance.now();
      const raw = await cache.get(cold.key);
      const read = performance.now();
      expect(cold.cacheHit).toBe(false);
      expect(hot.cacheHit).toBe(true);
      expect(raw).toEqual(cold.mesh);
      expect(hot.mesh.diagnostics.missing).toEqual([]);
      expect(hot.mesh.diagnostics.cycles).toEqual([]);
      expect(hot.mesh.diagnostics.warnings).toEqual([]);
      process.stdout.write(
        `[ldraw perf] ${file}: cold=${(built - start).toFixed(2)}ms hot-with-source-validation=${(checked - built).toFixed(2)}ms binary-read=${(read - checked).toFixed(2)}ms triangles=${cold.mesh.batches.reduce((sum, batch) => sum + batch.indices.length / 3, 0)}\n`,
      );
    }
  }, 30000);

  it('builds the real library with high-resolution primitives without changing its bounds', async () => {
    const mesh = await buildPartMesh('3001.dat', createLibraryResolver({ libraryDir }), { highResPrimitives: true });
    expect(mesh.bboxLdu).toEqual([-40, -4, -20, 40, 24, 20]);
    expect(mesh.diagnostics).toEqual({ missing: [], cycles: [], warnings: [] });
    expect(mesh.sources.some((source) => source.resolvedFrom.includes(':p/48/'))).toBe(true);
    expect(mesh.batches.reduce((sum, batch) => sum + batch.indices.length / 3, 0)).toBeGreaterThan(700);
  });
});
