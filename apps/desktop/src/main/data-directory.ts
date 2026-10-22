import path from 'node:path';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { access, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

export interface DataDirectoryEnvironment {
  BRICKLOOP_DATA_DIR?: string | undefined;
  APPDATA?: string | undefined;
  LOCALAPPDATA?: string | undefined;
}

export interface DataDirectories {
  config: string;
  recovery: string;
  cache: string;
  legacy: string;
  migrationFallback: boolean;
}
export function resolveSessionDirectories(directories: Pick<DataDirectories, 'cache'>) {
  return {
    current: path.win32.join(path.win32.dirname(directories.cache), 'session'),
    legacy: path.win32.join(directories.cache, 'session'),
  };
}
/** Run before Chromium opens any session files, and only migrate while holding the instance lock. */
export function migrateSessionDirectory(
  directories: Pick<DataDirectories, 'cache'>,
  primary: boolean,
  filesystem = { existsSync, mkdirSync, renameSync },
  warn: (message: string) => void = console.warn,
): string {
  const { current, legacy } = resolveSessionDirectories(directories);
  if (filesystem.existsSync(current)) return current;
  if (!primary) return legacy;
  if (filesystem.existsSync(legacy)) {
    try {
      filesystem.renameSync(legacy, current);
    } catch {
      warn('Session directory migration deferred; using the previous location for this launch.');
      return legacy;
    }
  } else filesystem.mkdirSync(current, { recursive: true });
  return current;
}
export function resolveDataDirectories(environment: DataDirectoryEnvironment): DataDirectories {
  const legacy = resolveDataDirectory(environment);
  const development = !!environment.BRICKLOOP_DATA_DIR?.trim();
  const local = development
    ? legacy
    : environment.LOCALAPPDATA && path.win32.join(environment.LOCALAPPDATA, 'Brickloop');
  if (!local || !path.win32.isAbsolute(local)) throw new Error('LOCALAPPDATA must provide an absolute data directory');
  return {
    config: development ? path.win32.join(legacy, 'config') : legacy,
    recovery: path.win32.join(local, 'recovery'),
    cache: path.win32.join(local, 'cache'),
    legacy,
    migrationFallback: false,
  };
}
const exists = async (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
/** Stage a full copy before publishing; keep the old data intact on any failure. */
export async function migrateDataDirectories(paths: DataDirectories, copy = cp): Promise<DataDirectories> {
  await mkdir(paths.config, { recursive: true });
  const marker = path.join(paths.config, 'data-migration-v1.json');
  let done: string[] = [];
  try {
    const saved: unknown = JSON.parse(await readFile(marker, 'utf8'));
    if (Array.isArray(saved) && saved.every((item): item is string => typeof item === 'string')) done = saved;
  } catch {
    /* First launch. */
  }
  const result = { ...paths };
  const entries = [
    ...['recovery', 'cache'].map((key) => ({
      key,
      source: path.join(paths.legacy, key),
      target: paths[key as 'recovery' | 'cache'],
    })),
    ...(paths.config !== paths.legacy ? [{ key: 'config', source: paths.legacy, target: paths.config }] : []),
  ];
  for (const { key, source, target } of entries) {
    if (source === target || done.includes(key)) continue;
    const staging = `${target}.migrating`;
    const backup = `${target}.migration-previous`;
    let published = false;
    try {
      // Recover a previous interruption between the two directory renames.
      if (!(await exists(target)) && (await exists(backup))) await rename(backup, target);
      const configNames = ['settings.json', 'ai', 'packs', 'macros'];
      const hasSource =
        key === 'config'
          ? (await Promise.all(configNames.map((name) => exists(path.join(source, name))))).some(Boolean)
          : await exists(source);
      if (hasSource) {
        await rm(staging, { recursive: true, force: true });
        if (key === 'config') {
          await mkdir(staging, { recursive: true });
          // The development config target is inside legacy. Never copy legacy recursively.
          for (const name of configNames) {
            if (await exists(path.join(source, name)))
              await copy(path.join(source, name), path.join(staging, name), { recursive: true });
          }
        } else await copy(source, staging, { recursive: true, force: false, errorOnExist: true });
        const hadTarget = await exists(target);
        if (hadTarget) {
          // Merge into staging, keeping newer destination files. A partial copy is never published.
          await copy(target, staging, { recursive: true, force: true });
          await rm(backup, { recursive: true, force: true });
          await rename(target, backup);
        }
        try {
          await rename(staging, target);
        } catch (error) {
          if (hadTarget) await rename(backup, target);
          throw error;
        }
        published = true;
        await rm(backup, { recursive: true, force: true });
      }
      done.push(key);
      await writeFile(`${marker}.tmp`, JSON.stringify(done));
      await rename(`${marker}.tmp`, marker);
    } catch {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (!published) {
        result.migrationFallback = true;
        if (key === 'recovery' || key === 'cache') result[key] = source;
        else result.config = paths.legacy;
      }
    }
  }
  for (const directory of [result.config, result.recovery, result.cache]) await mkdir(directory, { recursive: true });
  return result;
}

// No process/environment reads or filesystem side effects: also testable on non-Windows hosts.
export function resolveDataDirectory(environment: DataDirectoryEnvironment): string {
  const override = environment.BRICKLOOP_DATA_DIR?.trim();
  const directory = override || (environment.APPDATA && path.win32.join(environment.APPDATA, 'Brickloop'));
  if (!directory || !path.win32.isAbsolute(directory)) {
    throw new Error('BRICKLOOP_DATA_DIR or APPDATA must provide an absolute data directory');
  }
  return path.win32.normalize(directory);
}
