import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { readZip } from './zip.js';

export interface LibraryPin {
  sourceUrl: string;
  sha256: string;
  bytes: number;
}
export interface LibraryVersion extends LibraryPin {
  schemaVersion: 1;
  downloadedAt: string;
  downloadedAtSource: 'network' | 'archive-mtime';
  registeredAt: string;
  libraryUpdate: string | null;
  ldconfigUpdate: string | null;
  fileCount: number;
}
const exists = async (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );
async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function fetchLibrary(options: {
  root: string;
  pin: LibraryPin;
  fromZip?: string;
  log?: (message: string) => void;
}): Promise<LibraryVersion> {
  const { root, pin } = options;
  const log = options.log ?? console.log;
  const destination = path.join(root, 'library', 'ldraw');
  const versionFile = path.join(destination, 'VERSION.json');
  const cacheDir = path.join(root, '.devdata', 'ldraw-download');
  const archive = options.fromZip ? path.resolve(options.fromZip) : path.join(cacheDir, 'complete.zip');
  if (await exists(versionFile)) {
    const previous = JSON.parse(await readFile(versionFile, 'utf8')) as LibraryVersion;
    if (
      previous.schemaVersion !== 1 ||
      previous.sha256 !== pin.sha256 ||
      previous.sourceUrl !== pin.sourceUrl ||
      previous.bytes !== pin.bytes
    ) {
      throw new Error(
        'Existing library VERSION differs from the pinned archive; use a separate library directory for an upgrade.',
      );
    }
    if ((await exists(archive)) && (await hashFile(archive)) !== pin.sha256)
      throw new Error('Cached ZIP SHA-256 mismatch');
    for (const required of ['parts', 'p', 'LDConfig.ldr'])
      if (!(await exists(path.join(destination, required))))
        throw new Error(`Existing library is incomplete: ${required}`);
    log(`LDraw already pinned: ${previous.sha256}; skipped download/extraction.`);
    return previous;
  }
  let downloadedAtSource: LibraryVersion['downloadedAtSource'] = 'archive-mtime';
  if (!(await exists(archive))) {
    if (options.fromZip) throw new Error(`Source ZIP not found: ${archive}`);
    await mkdir(cacheDir, { recursive: true });
    const temporary = `${archive}.${randomUUID()}.tmp`;
    try {
      log(`Downloading pinned LDraw archive: ${pin.sourceUrl}`);
      const response = await fetch(pin.sourceUrl);
      if (!response.ok || !response.body) throw new Error(`LDraw download failed: HTTP ${response.status}`);
      // Another dependency's DOM typings can widen fetch()'s body type; it is a Node web stream at runtime.
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), createWriteStream(temporary));
      if ((await stat(temporary)).size !== pin.bytes || (await hashFile(temporary)) !== pin.sha256)
        throw new Error('Downloaded ZIP size/SHA-256 differs from the pin; no library files changed.');
      await rename(temporary, archive);
      downloadedAtSource = 'network';
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const archiveStat = await stat(archive);
  if (archiveStat.size !== pin.bytes || (await hashFile(archive)) !== pin.sha256)
    throw new Error('Source ZIP size/SHA-256 mismatch');
  const entries = readZip(await readFile(archive));
  if (
    !entries.some((entry) => entry.name.toLowerCase() === 'ldconfig.ldr') ||
    !entries.some((entry) => entry.name.toLowerCase().startsWith('parts/')) ||
    !entries.some((entry) => entry.name.toLowerCase().startsWith('p/'))
  )
    throw new Error('ZIP is missing required LDraw library data');
  const existing = (await exists(destination)) && (await readdir(destination)).length > 0;
  await mkdir(cacheDir, { recursive: true });
  const staging = existing ? undefined : await mkdtemp(path.join(cacheDir, 'extract-'));
  let libraryUpdate: string | null = null;
  let ldconfigUpdate: string | null = null;
  log(
    existing
      ? 'Checking already extracted files against ZIP; only VERSION.json will be created.'
      : 'Extracting verified archive into staging directory.',
  );
  try {
    let checked = 0;
    for (const entry of entries) {
      const data = entry.read();
      if (/\.(dat|ldr)$/i.test(entry.name)) {
        const header = data.subarray(0, 8192).toString('utf8');
        for (const match of header.matchAll(/(?:!LDRAW_ORG[^\r\n]*?UPDATE|Official Update)\s+(\d{4}-\d{2})(?!-)/g)) {
          if (!libraryUpdate || match[1]! > libraryUpdate) libraryUpdate = match[1]!;
        }
        if (entry.name.toLowerCase() === 'ldconfig.ldr')
          ldconfigUpdate = /!LDRAW_ORG[^\r\n]*?UPDATE\s+(\d{4}-\d{2}-\d{2})/.exec(header)?.[1] ?? null;
      }
      const target = path.join(staging ?? destination, ...entry.name.split('/'));
      if (existing) {
        const actual = await readFile(target);
        if (actual.length !== entry.size || crc32(actual) !== entry.crc)
          throw new Error(`Existing library differs from ZIP: ${entry.name}; no files overwritten.`);
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, data);
      }
      if (++checked % 10000 === 0) log(`Verified ${checked}/${entries.length} library files.`);
    }
    const version: LibraryVersion = {
      schemaVersion: 1,
      ...pin,
      downloadedAt: archiveStat.mtime.toISOString(),
      downloadedAtSource,
      registeredAt: new Date().toISOString(),
      libraryUpdate,
      ldconfigUpdate,
      fileCount: entries.length,
    };
    if (staging) {
      await writeFile(path.join(staging, 'VERSION.json'), `${JSON.stringify(version, null, 2)}\n`);
      await mkdir(path.dirname(destination), { recursive: true });
      // Only a verified empty target may be removed; never recursively replace an existing library.
      if (await exists(destination)) await rmdir(destination);
      await rename(staging, destination);
    } else await writeFile(versionFile, `${JSON.stringify(version, null, 2)}\n`, { flag: 'wx' });
    log(
      `LDraw pinned: update ${libraryUpdate ?? 'unknown'}, LDConfig ${ldconfigUpdate ?? 'unknown'}, SHA-256 ${pin.sha256}`,
    );
    return version;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--from-zip'))
    throw new Error('Usage: pnpm ldraw:fetch [--from-zip <archive.zip>]');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const pin = JSON.parse(await readFile(new URL('./pin.json', import.meta.url), 'utf8')) as LibraryPin;
  await fetchLibrary({ root, pin, ...(args[1] ? { fromZip: args[1] } : {}) });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
