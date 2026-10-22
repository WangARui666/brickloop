import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';

export type PackFiles = Record<string, Uint8Array>;
export const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z');

export function safeMember(name: string): boolean {
  return (
    !!name &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    !name.includes(':') &&
    !name.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

export function contentHash(files: PackFiles): string {
  const hash = createHash('sha256');
  for (const name of Object.keys(files)
    .filter((name) => name !== 'pack.json')
    .sort()) {
    hash.update(`${name}\0${files[name]!.length}\0`).update(files[name]!);
  }
  return hash.digest('hex');
}

export function deterministicZip(files: PackFiles): Uint8Array {
  // DOS ZIP timestamps have no timezone; use a fixed local date to get identical bytes in every timezone.
  const zipDate = new Date(2000, 0, 1, 0, 0, 0);
  return zipSync(
    Object.fromEntries(
      Object.keys(files)
        .sort()
        .map((name) => [name, [files[name]!, { mtime: zipDate }]]),
    ),
    { level: 6 },
  );
}

export async function readPackFiles(source: string | Uint8Array): Promise<PackFiles> {
  if (typeof source !== 'string' || !(await lstat(source)).isDirectory()) {
    const bytes = typeof source === 'string' ? await readFile(source) : source;
    const files = unzipSync(bytes);
    for (const name of Object.keys(files)) {
      if (name.endsWith('/')) {
        delete files[name];
        continue;
      }
      if (!safeMember(name)) throw new Error(`数据包含非法路径：${name}`);
    }
    return files;
  }
  const files: PackFiles = {};
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(path.join(source as string, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const member = relative ? `${relative}/${entry.name}` : entry.name;
      if (!safeMember(member) || entry.isSymbolicLink()) throw new Error(`数据包含非法路径或联接：${member}`);
      if (entry.isDirectory()) await visit(member);
      else if (entry.isFile()) files[member] = new Uint8Array(await readFile(path.join(source as string, member)));
    }
  }
  await visit('');
  return files;
}

export async function writePackFiles(destination: string, files: PackFiles): Promise<void> {
  for (const name of Object.keys(files)) if (!safeMember(name)) throw new Error(`数据包含非法路径：${name}`);
  if (/\.brklpack$/i.test(destination)) {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, deterministicZip(files));
  } else {
    await mkdir(destination, { recursive: true });
    for (const name of Object.keys(files).sort()) {
      const target = path.join(destination, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, files[name]!);
    }
  }
}
