import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Settings } from '../shared/api';
import { decodeSettings, serializeSettings } from './settings';

export function createSettingsFile(dataDirectory: string) {
  const file = path.join(dataDirectory, 'settings.json');
  // Serialize writes so rapid IPC requests cannot make the disk lag behind the UI.
  let pendingWrite = Promise.resolve();

  async function save(settings: Settings): Promise<void> {
    const content = serializeSettings(settings);
    const write = pendingWrite.then(async () => {
      await mkdir(dataDirectory, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    pendingWrite = write.catch(() => undefined);
    return write;
  }

  async function load(): Promise<Settings> {
    let content: string | undefined;
    try {
      content = await readFile(file, 'utf8');
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const result = decodeSettings(content);
    if (result.corrupt) {
      // Preserve the exact original bytes, including invalid UTF-8, before replacing defaults.
      await rename(file, path.join(dataDirectory, `settings.corrupt-${Date.now()}-${randomUUID()}.json`));
    }
    if (content === undefined || result.corrupt) await save(result.settings);
    return result.settings;
  }

  return { load, save };
}
