import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchLibrary } from '../../../tools/ldraw-fetch/index.js';
import { readZip } from '../../../tools/ldraw-fetch/zip.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixtureRoot(): Promise<string> {
  const parent = path.resolve('.devdata', 'ldraw-test');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'fetch-'));
  roots.push(root);
  return root;
}
function zip(files: Record<string, string>, compressed = true): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const content = Buffer.from(text);
    const body = compressed ? deflateRawSync(content) : content;
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(compressed ? 8 : 0, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, filename, body);
    central.push(entry, filename);
    offset += local.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const files = {
  'ldraw/LDConfig.ldr': '0 !LDRAW_ORG Configuration UPDATE 2026-05-29\n',
  'ldraw/parts/test.dat': '0 !LDRAW_ORG Part UPDATE 2026-03\n3 16 0 0 0 1 0 0 0 1 0\n',
  'ldraw/p/stud.dat': '0 !LDRAW_ORG Primitive UPDATE 2026-04\n',
  // Data only, even if an archive contains a misleading executable filename.
  'ldraw/mklist.exe': 'not an executable; must never be invoked',
};
const pinFor = (archive: Buffer, sourceUrl = 'https://library.ldraw.org/fake.zip') => ({
  sourceUrl,
  sha256: createHash('sha256').update(archive).digest('hex'),
  bytes: archive.length,
});
const log = () => undefined;

describe('pinned LDraw fetch (small ZIP fixtures only)', () => {
  it('downloads, validates and extracts once, then skips without another network request', async () => {
    const archive = zip(files);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.end(archive);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local test server address');
    const root = await fixtureRoot();
    const pin = pinFor(archive, `http://127.0.0.1:${address.port}/complete.zip`);
    try {
      const version = await fetchLibrary({ root, pin, log });
      expect(version).toMatchObject({
        sha256: pin.sha256,
        libraryUpdate: '2026-04',
        ldconfigUpdate: '2026-05-29',
        fileCount: 4,
        downloadedAtSource: 'network',
      });
      expect(await readFile(path.join(root, 'library/ldraw/parts/test.dat'), 'utf8')).toBe(
        files['ldraw/parts/test.dat'],
      );
      expect(await fetchLibrary({ root, pin, log })).toEqual(version);
      expect(requests).toBe(1);
      expect(await readdir(path.join(root, '.devdata/ldraw-download'))).toEqual(['complete.zip']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('adopts an extracted library without VERSION and never rewrites its files', async () => {
    const root = await fixtureRoot();
    const archive = zip(files, false);
    const fromZip = path.join(root, 'small.zip');
    await writeFile(fromZip, archive);
    for (const [name, text] of Object.entries(files)) {
      const target = path.join(root, 'library', name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text);
    }
    const part = path.join(root, 'library/ldraw/parts/test.dat');
    const before = (await stat(part)).mtimeMs;
    const version = await fetchLibrary({ root, pin: pinFor(archive), fromZip, log });
    expect(version.downloadedAtSource).toBe('archive-mtime');
    expect((await stat(part)).mtimeMs).toBe(before);
    expect(JSON.parse(await readFile(path.join(root, 'library/ldraw/VERSION.json'), 'utf8'))).toEqual(version);
  });

  it('rejects mismatched extracted content or ZIP hash without touching it', async () => {
    const root = await fixtureRoot();
    const archive = zip(files);
    const fromZip = path.join(root, 'small.zip');
    await writeFile(fromZip, archive);
    const target = path.join(root, 'library/ldraw/LDConfig.ldr');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'user data');
    await expect(fetchLibrary({ root, pin: pinFor(archive), fromZip, log })).rejects.toThrow('differs from ZIP');
    expect(await readFile(target, 'utf8')).toBe('user data');
    await expect(
      fetchLibrary({ root, pin: { ...pinFor(archive), sha256: '0'.repeat(64) }, fromZip, log }),
    ).rejects.toThrow('SHA-256 mismatch');
    expect(await readdir(path.dirname(target))).toEqual(['LDConfig.ldr']);
  });

  it('rejects unsafe member paths, duplicate names, truncation and corrupt CRC', () => {
    for (const name of [
      'ldraw/../../evil.dat',
      'ldraw/C:/evil.dat',
      'ldraw/parts/CON.dat',
      '/ldraw/evil.dat',
      'other/file.dat',
    ]) {
      expect(() => readZip(zip({ [name]: 'bad' }))).toThrow();
    }
    expect(() => readZip(zip({ 'ldraw/a.dat': 'a', 'ldraw/A.dat': 'b' }))).toThrow('Duplicate');
    expect(() => readZip(zip(files).subarray(0, 30))).toThrow('end record');
    const corrupt = zip({ 'ldraw/a.dat': 'sample' }, false);
    corrupt[30 + 'ldraw/a.dat'.length] = 0;
    expect(() => readZip(corrupt)[0]!.read()).toThrow('CRC');
  });

  it('supports an empty precreated destination and leaves no extraction staging behind', async () => {
    const root = await fixtureRoot();
    const archive = zip(files);
    const fromZip = path.join(root, 'small.zip');
    await writeFile(fromZip, archive);
    await mkdir(path.join(root, 'library/ldraw'), { recursive: true });
    await fetchLibrary({ root, pin: pinFor(archive), fromZip, log });
    expect(await readdir(path.join(root, '.devdata/ldraw-download'))).toEqual([]);
  });
});
