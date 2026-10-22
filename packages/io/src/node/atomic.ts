import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { hashBytes } from '../binary';
import { issue } from '../issues';
import type { IoCode, IoIssue } from '../issues';
import { unpackProject } from '../project';

export interface AtomicFileSystem {
  open: typeof fs.open;
  readFile: typeof fs.readFile;
  rename: typeof fs.rename;
  copyFile: typeof fs.copyFile;
  unlink: typeof fs.unlink;
}
export type SaveResult =
  | { ok: true; method: 'rename-overwrite'; durability: 'synced' | 'uncertain'; issues: IoIssue[] }
  | { ok: false; error: IoIssue; cleanupIssues: string[] };
export interface SaveOptions {
  keepBackup?: boolean;
  /** Fault injection / platform adapter. Must preserve rename's replace-or-fail contract. */
  fs?: AtomicFileSystem;
  checkpoint?: (stage: 'written' | 'validated' | 'beforeReplace', temporaryPath: string) => void | Promise<void>;
}
function classify(error: unknown): IoCode {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'SAVE_NO_SPACE';
  if (code === 'EBUSY' || code === 'ETXTBSY' || code === 'EEXIST') return 'SAVE_BUSY';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'SAVE_PERMISSION';
  if (code === 'SAVE_VALIDATION') return 'SAVE_VALIDATION';
  return 'SAVE_IO';
}
export async function syncFile(file: string, io: AtomicFileSystem = fs): Promise<void> {
  const handle = await io.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Node/libuv uses MoveFileExW(REPLACE_EXISTING) on Windows. Payload fsync occurs
 * before replacement and a second fsync follows it; no delete/rename-away of target. */
export async function saveBytesAtomic(
  file: string,
  bytes: Uint8Array,
  validate: (bytes: Uint8Array) => boolean,
  options: SaveOptions = {},
): Promise<SaveResult> {
  const io = options.fs ?? fs,
    temporary = `${file}.tmp-${randomUUID()}`,
    backupTemp = `${file}.bak.tmp-${randomUUID()}`;
  const cleanupIssues: string[] = [];
  let replaced = false;
  try {
    const handle = await io.open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.checkpoint?.('written', temporary);
    const written = await io.readFile(temporary);
    if (hashBytes(written) !== hashBytes(bytes) || !validate(written))
      throw Object.assign(new Error('Temporary file verification failed'), { code: 'SAVE_VALIDATION' });
    await options.checkpoint?.('validated', temporary);
    if (options.keepBackup) {
      try {
        await io.copyFile(file, backupTemp);
        await syncFile(backupTemp, io);
        await io.rename(backupTemp, `${file}.bak`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await options.checkpoint?.('beforeReplace', temporary);
    await io.rename(temporary, file);
    replaced = true;
    await syncFile(file, io);
    // POSIX supports directory fsync. Windows does not expose an equivalent through fs.open.
    if (process.platform !== 'win32') {
      const directory = await io.open(path.dirname(file), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return { ok: true, method: 'rename-overwrite', durability: 'synced', issues: [] };
  } catch (error) {
    if (replaced)
      return {
        ok: true,
        method: 'rename-overwrite',
        durability: 'uncertain',
        issues: [issue('SAVE_DURABILITY', file, String(error), 'warning')],
      };
    return { ok: false, error: issue(classify(error), file, String(error)), cleanupIssues };
  } finally {
    for (const temp of [temporary, backupTemp]) {
      try {
        await io.unlink(temp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupIssues.push(`${temp}: ${String(error)}`);
      }
    }
  }
}
export async function saveProjectAtomic(
  file: string,
  bytes: Uint8Array,
  options: SaveOptions = {},
): Promise<SaveResult> {
  return saveBytesAtomic(
    file,
    bytes,
    (written) => {
      const project = unpackProject(written);
      return !!project.doc && !project.issues.some((i) => i.severity === 'error');
    },
    options,
  );
}
