import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shell } from 'electron';
import { hashBytes, macroAvailability, readMacro, writeMacro } from '@brickloop/io';
import type { Pack } from '@brickloop/catalog';
import type { MacroApi, MacroEntry } from '../shared/macro-api';
import { createThumbCache } from './thumb-cache';

export function createMacroService(options: {
  builtin: string;
  directory: string;
  cache: string;
  pack(): Promise<Pick<Pack, 'parts' | 'colors'>>;
  t(key: string): string;
}): MacroApi {
  const thumbs = createThumbCache(options.cache);
  const files = new Map<string, string>();
  async function decode(
    file: string,
    id: string,
  ): Promise<{ entry: MacroEntry; pkg: ReturnType<typeof readMacro> & { ok: true } }> {
    const bytes = await readFile(file);
    const pkg = readMacro(bytes);
    if (!pkg.ok) throw new Error(options.t('macroUi.invalid'));
    return { entry: { id, builtin: id.startsWith('builtin.'), hash: hashBytes(bytes), meta: pkg.value.meta }, pkg };
  }
  async function locate(id: string, writable = false) {
    if (writable && !id.startsWith('user.')) throw new Error(options.t('macroUi.protected'));
    if (!files.has(id)) await api.macrosList();
    const file = files.get(id);
    if (!file) throw new Error(options.t('macroUi.missing'));
    return file;
  }
  async function atomic(file: string, bytes: Uint8Array) {
    await mkdir(options.directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const api: MacroApi = {
    async macrosList() {
      const index = JSON.parse(await readFile(path.join(options.builtin, 'index.json'), 'utf8')) as {
        macros: { id: string; file: string }[];
      };
      const entries: MacroEntry[] = [];
      files.clear();
      for (const item of index.macros) {
        const file = path.join(options.builtin, path.basename(item.file));
        entries.push((await decode(file, item.id)).entry);
        files.set(item.id, file);
      }
      await mkdir(options.directory, { recursive: true });
      for (const name of (await readdir(options.directory)).sort()) {
        if (!/^user\.[a-f0-9-]{36}\.brklmacro$/.test(name)) continue;
        const id = name.slice(0, -10),
          file = path.join(options.directory, name);
        try {
          entries.push((await decode(file, id)).entry);
          files.set(id, file);
        } catch {
          // A damaged user file must not hide healthy library entries.
          console.warn('[macro-unreadable]', name);
        }
      }
      return entries;
    },
    async macroRead(id) {
      const { pkg } = await decode(await locate(id), id);
      return { pkg: pkg.value, availability: macroAvailability(pkg.value, await options.pack()) };
    },
    async macroSave(bytes) {
      const pkg = readMacro(bytes);
      if (!pkg.ok || !pkg.value.thumbnail) throw new Error(options.t('macroUi.invalid'));
      const id = `user.${randomUUID()}`,
        file = path.join(options.directory, `${id}.brklmacro`);
      await atomic(file, bytes);
      files.set(id, file);
      return (await decode(file, id)).entry;
    },
    async macroRename(id, name) {
      const file = await locate(id, true),
        { pkg } = await decode(file, id);
      pkg.value.meta.name = name.trim();
      await atomic(file, writeMacro(pkg.value));
    },
    async macroRemove(id) {
      await rm(await locate(id, true));
      files.delete(id);
    },
    async macroReveal(id) {
      shell.showItemInFolder(await locate(id, true));
    },
    async macroThumbGet(id) {
      const { entry } = await decode(await locate(id), id);
      return { key: entry.hash, png: await thumbs.get(entry.hash) };
    },
    macroThumbPut: (key, png) => thumbs.put(key, png),
  };
  return api;
}
