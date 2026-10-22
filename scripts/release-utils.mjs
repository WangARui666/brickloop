import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, lstat, rm } from 'node:fs/promises';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const desktop = path.join(root, 'apps/desktop');
export const resources = path.join(root, 'dist/packaging/resources');
export const desktopRequire = createRequire(path.join(desktop, 'package.json'));

export function run(args, capture = false, cwd = root) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/devenv.mjs'), ...args], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed (${result.status})\n${result.stderr ?? ''}`);
  return result.stdout;
}

// Only disposable release staging directories may be recursively removed.
export async function resetStaging(directory) {
  const resolved = path.resolve(directory);
  const allowed = ['dist/packaging/resources', 'dist/desktop'].map((p) => path.join(root, p));
  if (!allowed.includes(resolved)) throw new Error(`Not a release staging directory: ${resolved}`);
  try {
    if ((await lstat(resolved)).isSymbolicLink()) throw new Error(`Refusing staging symlink: ${resolved}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(resolved, { recursive: true, force: true });
  await mkdir(resolved, { recursive: true });
}

export async function filesIn(directory) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected resource symlink: ${file}`);
    if (entry.isDirectory()) files.push(...(await filesIn(file)));
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Unexpected resource entry: ${file}`);
  }
  return files;
}
