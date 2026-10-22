import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { repositoryRoot } from './catalog-index';
import { importPack, validPackId } from './pack-import';
import type { ImportOptions, ImportResult } from './pack-import';
import { writePack } from './pack-workbooks';
import type { Pack, PackManifest } from './types';

/** Persistence only. The application owns the active pack ID and can roll back by selecting an old ID. */
export class PackStore {
  constructor(
    readonly dir: string,
    private readonly options: ImportOptions & { demoDir?: string } = {},
  ) {}

  private location(id: string): string {
    if (!validPackId(id)) throw new Error('非法包 ID');
    return path.join(this.dir, id);
  }

  async list(): Promise<PackManifest[]> {
    await mkdir(this.dir, { recursive: true });
    const result: PackManifest[] = [];
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validPackId(entry.name)) continue;
      try {
        result.push((await this.read(entry.name)).manifest);
      } catch {
        /* Incomplete/corrupt packs cannot be activated. */
      }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  }

  async read(id: string): Promise<Pack> {
    const result = await importPack(this.location(id), { ...this.options, skipInvalidRows: false });
    if (!result.pack)
      throw new Error(result.report.errors.map((error) => `${error.file}:${error.row} ${error.reason}`).join('\n'));
    if (result.pack.manifest.id !== id) throw new Error('目录名与包 ID 不一致');
    return result.pack;
  }

  async import(
    source: string | Uint8Array,
    options: Pick<ImportOptions, 'skipInvalidRows'> = {},
  ): Promise<ImportResult> {
    const result = await importPack(source, { ...this.options, ...options });
    if (!result.pack) return result;
    const destination = this.location(result.pack.manifest.id);
    await mkdir(this.dir, { recursive: true });
    let exists = false;
    try {
      await access(destination);
      exists = true;
    } catch {
      /* New pack ID. */
    }
    if (exists) {
      result.report.errors.push({
        file: 'pack.json',
        sheet: '',
        row: 0,
        column: 'id',
        reason: '包 ID 已存在；请为新版使用新 ID，以保留旧包供回滚',
      });
      return { report: result.report };
    }
    const staging = path.join(this.dir, `.import-${randomUUID()}`);
    try {
      await writePack(staging, result.pack);
      await rename(staging, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return { ...result, pack: await this.read(result.pack.manifest.id) };
  }

  async delete(id: string): Promise<void> {
    await rm(this.location(id), { recursive: true, force: true });
  }

  async resolveActive(packId?: string | null): Promise<Pack> {
    if (packId) {
      try {
        return await this.read(packId);
      } catch {
        /* Missing active pack falls back to demo. */
      }
    }
    try {
      return await this.read('demo');
    } catch {
      /* Use bundled demo if the store has no demo. */
    }
    const result = await importPack(this.options.demoDir ?? path.join(repositoryRoot, 'library/packs/demo'), {
      ...this.options,
      skipInvalidRows: false,
    });
    if (!result.pack) throw new Error(`示例包不可用：${result.report.errors.map((error) => error.reason).join('；')}`);
    return result.pack;
  }
}
