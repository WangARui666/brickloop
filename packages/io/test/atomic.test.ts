import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveProjectAtomic } from '../src/node';
import { cleanup, fixture, packed, temporary } from './helpers';

describe('atomic project save', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await temporary();
  });
  afterEach(async () => {
    await cleanup(dir);
  });
  it('writes, validates and atomically replaces with a durable previous backup', async () => {
    const doc = await fixture(),
      file = path.join(dir, 'project.brkl'),
      before = packed(doc);
    expect((await saveProjectAtomic(file, before, { keepBackup: true })).ok).toBe(true);
    doc.revision++;
    doc.meta.title = 'new';
    const after = packed(doc);
    expect(await saveProjectAtomic(file, after, { keepBackup: true })).toEqual({
      ok: true,
      method: 'rename-overwrite',
      durability: 'synced',
      issues: [],
    });
    expect(new Uint8Array(await fs.readFile(file))).toEqual(after);
    expect(new Uint8Array(await fs.readFile(`${file}.bak`))).toEqual(before);
    expect(await fs.readdir(dir)).toEqual(['project.brkl', 'project.brkl.bak']);
  });
  it.each([
    ['EROFS', 'SAVE_PERMISSION'],
    ['EACCES', 'SAVE_PERMISSION'],
    ['ENOSPC', 'SAVE_NO_SPACE'],
    ['EBUSY', 'SAVE_BUSY'],
  ])('P02: injected %s keeps original bytes and cleans temporary files', async (errno, code) => {
    const doc = await fixture(),
      file = path.join(dir, 'original.brkl'),
      before = packed(doc);
    await fs.writeFile(file, before);
    doc.revision++;
    const after = packed(doc);
    const result = await saveProjectAtomic(file, after, {
      fs: {
        ...fs,
        rename: async () => {
          throw Object.assign(new Error(errno), { code: errno });
        },
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(new Uint8Array(await fs.readFile(file))).toEqual(before);
    expect(await fs.readdir(dir)).toEqual(['original.brkl']);
  });
  it('P02: read-only directory/open failure, partial write failure and corrupted reread preserve original', async () => {
    const doc = await fixture(),
      file = path.join(dir, 'original.brkl'),
      before = packed(doc);
    await fs.writeFile(file, before);
    const noWrite = await saveProjectAtomic(file, before, {
      fs: {
        ...fs,
        open: async () => {
          throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
        },
      },
    });
    expect(noWrite).toMatchObject({ ok: false, error: { code: 'SAVE_PERMISSION' } });
    const full = await saveProjectAtomic(file, before, {
      checkpoint: async (stage, temporaryPath) => {
        if (stage === 'written') {
          await fs.truncate(temporaryPath, 20);
          throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' });
        }
      },
    });
    expect(full).toMatchObject({ ok: false, error: { code: 'SAVE_NO_SPACE' } });
    const corrupt = await saveProjectAtomic(file, before, {
      checkpoint: async (stage, temporaryPath) => {
        if (stage === 'written') await fs.truncate(temporaryPath, 20);
      },
    });
    expect(corrupt).toMatchObject({ ok: false, error: { code: 'SAVE_VALIDATION' } });
    expect(new Uint8Array(await fs.readFile(file))).toEqual(before);
    expect(await fs.readdir(dir)).toEqual(['original.brkl']);
  });
  it('rejects intact ZIP with failed project manifest and reports post-commit flush separately', async () => {
    const file = path.join(dir, 'new.brkl'),
      bytes = packed(await fixture());
    expect(await saveProjectAtomic(file, new Uint8Array([1]))).toMatchObject({
      ok: false,
      error: { code: 'SAVE_VALIDATION' },
    });
    const result = await saveProjectAtomic(file, bytes, {
      fs: {
        ...fs,
        open: ((target, flags, mode) => {
          if (target === file) throw Object.assign(new Error('flush failed'), { code: 'EIO' });
          return fs.open(target, flags, mode);
        }) as typeof fs.open,
      },
    });
    expect(result).toMatchObject({ ok: true, durability: 'uncertain', issues: [{ code: 'SAVE_DURABILITY' }] });
    expect(new Uint8Array(await fs.readFile(file))).toEqual(bytes);
  });
});
