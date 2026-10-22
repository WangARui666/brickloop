import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, cp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  assignShortcut,
  effectiveShortcuts,
  exportShortcuts,
  importShortcuts,
  parseShortcuts,
  shortcutConflicts,
  shortcutFromEvent,
} from '../src/shared/shortcuts';
import { defaultPreferences } from '../src/shared/preferences';
import { createSettingsFile } from '../src/main/settings-file';
import { resolveDataDirectories, migrateDataDirectories } from '../src/main/data-directory';
import { associatedFiles, createOpenFileQueue } from '../src/main/open-files';
import { writeExportAtomic } from '../src/main/export-file';
import { DailyCostLedger } from '@brickloop/ai';

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brickloop-release-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
describe('release preferences and shortcuts', () => {
  it('persists all settings atomically across sessions and rapid writes', async () =>
    temporary(async (dir) => {
      const file = createSettingsFile(dir);
      const shortcuts = assignShortcut(effectiveShortcuts(), 'edit.copy', 'Ctrl+S');
      const preferences = {
        ...defaultPreferences,
        shortcuts,
        reopenLast: true,
        unit: 'cm' as const,
        snapshotMinutes: 2,
        grid: 5 as const,
        angle: 15 as const,
        snap: false,
        mergeKeyboard: false,
        logging: true,
      };
      await Promise.all([file.save({ language: 'en' }), file.save({ language: 'zh-CN', preferences })]);
      expect((await createSettingsFile(dir).load()).preferences).toEqual(preferences);
      expect((await readdir(dir)).filter((file) => file.endsWith('.tmp'))).toEqual([]);
    }));
  it('detects conflicts, transfers ownership, roundtrips JSON, and rejects malformed imports', () => {
    const bindings = effectiveShortcuts();
    bindings['edit.copy'] = ['Ctrl+S'];
    expect(shortcutConflicts(bindings)).toContainEqual({ key: 'Ctrl+S', commands: ['file.save', 'edit.copy'] });
    expect(() => parseShortcuts(bindings)).toThrow('Conflicting');
    const resolved = assignShortcut(bindings, 'edit.copy', 'Ctrl+S');
    expect(resolved['file.save']).toEqual([]);
    expect(importShortcuts(exportShortcuts(resolved))).toEqual(resolved);
    expect(() => importShortcuts('{"version":2,"bindings":{}}')).toThrow();
    expect(() => parseShortcuts({ 'unknown.command': ['Ctrl+J'] })).toThrow();
    expect(() => parseShortcuts({ 'edit.copy': ['Ctrl+Ctrl+P'] })).toThrow();
    expect(
      shortcutFromEvent({ key: 'End', code: 'Numpad1', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }),
    ).toBe('Ctrl+Numpad1');
    expect(shortcutConflicts(effectiveShortcuts())).toEqual([]);
  });
});
describe('data directory migration', () => {
  it('splits roaming settings and local recovery/cache; development keeps three subdirectories', () => {
    expect(resolveDataDirectories({ APPDATA: 'E:\\roaming', LOCALAPPDATA: 'E:\\local' })).toMatchObject({
      config: 'E:\\roaming\\Brickloop',
      recovery: 'E:\\local\\Brickloop\\recovery',
      cache: 'E:\\local\\Brickloop\\cache',
    });
    expect(resolveDataDirectories({ BRICKLOOP_DATA_DIR: 'E:\\dev' })).toMatchObject({
      config: 'E:\\dev\\config',
      recovery: 'E:\\dev\\recovery',
      cache: 'E:\\dev\\cache',
    });
  });
  it('migrates old data once, preserves newer files, and falls back after a failed copy', async () =>
    temporary(async (dir) => {
      const legacy = path.join(dir, 'old'),
        config = path.join(dir, 'new/config'),
        recovery = path.join(dir, 'new/recovery'),
        cache = path.join(dir, 'new/cache');
      await mkdir(path.join(legacy, 'recovery'), { recursive: true });
      await mkdir(path.join(legacy, 'cache'), { recursive: true });
      await mkdir(cache, { recursive: true });
      await writeFile(path.join(legacy, 'settings.json'), '{"language":"en"}');
      await writeFile(path.join(legacy, 'recovery/document'), 'recovery');
      await writeFile(path.join(legacy, 'cache/mesh'), 'old-cache');
      await writeFile(path.join(cache, 'mesh'), 'new-cache');
      const paths = { legacy, config, recovery, cache, migrationFallback: false };
      const failed = await migrateDataDirectories(paths, async (source, target, options) => {
        if (String(source).endsWith('recovery')) throw new Error('disk full');
        return cp(source, target, options);
      });
      expect(failed).toMatchObject({ migrationFallback: true, recovery: path.join(legacy, 'recovery') });
      expect(await readFile(path.join(legacy, 'recovery/document'), 'utf8')).toBe('recovery');
      expect((await migrateDataDirectories(paths)).migrationFallback).toBe(false);
      expect(await readFile(path.join(recovery, 'document'), 'utf8')).toBe('recovery');
      expect(await readFile(path.join(cache, 'mesh'), 'utf8')).toBe('new-cache');
      await writeFile(path.join(legacy, 'recovery/document'), 'stale');
      await migrateDataDirectories(paths);
      expect(await readFile(path.join(recovery, 'document'), 'utf8')).toBe('recovery');
      expect(JSON.parse(await readFile(path.join(config, 'settings.json'), 'utf8'))).toEqual({ language: 'en' });
    }));
});
describe('file association and atomic output', () => {
  it('queues startup arguments until renderer readiness and immediately delivers second-instance files', () => {
    const send = vi.fn(),
      queue = createOpenFileQueue(send);
    const files = associatedFiles(
      ['electron', '--inspect', 'has space.brkl', 'PACK.BRKLPACK', 'skip.txt', '--bad.brkl'],
      'E:\\projects',
    );
    expect(files).toEqual(['E:\\projects\\has space.brkl', 'E:\\projects\\PACK.BRKLPACK']);
    queue.enqueue(files);
    expect(send).not.toHaveBeenCalled();
    expect(queue.ready()).toEqual(files);
    queue.enqueue(files.slice(0, 1));
    expect(send).toHaveBeenCalledWith(files.slice(0, 1));
  });
  it('cancellation preserves an existing target and success leaves no partial output', async () =>
    temporary(async (dir) => {
      const file = path.join(dir, 'instructions.pdf');
      await writeFile(file, 'previous');
      const abort = new AbortController();
      abort.abort();
      await expect(writeExportAtomic(file, new TextEncoder().encode('%PDF-new'), abort.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(await readFile(file, 'utf8')).toBe('previous');
      await writeExportAtomic(file, new TextEncoder().encode('%PDF-complete'));
      expect(await readFile(file, 'utf8')).toBe('%PDF-complete');
      expect(await readdir(dir)).toEqual(['instructions.pdf']);
    }));
});
it('rolls the cost ledger at local midnight, including a day that differs from UTC', () => {
  vi.stubEnv('TZ', 'Asia/Singapore');
  try {
    let now = new Date(2026, 9, 16, 23, 59).getTime();
    const ledger = new DailyCostLedger({}, () => now);
    ledger.add(2);
    expect(ledger.day()).toBe('2026-10-16');
    expect(ledger.canStart(2)).toBe(false);
    now = new Date(2026, 9, 17, 0, 1).getTime();
    expect(new Date(now).toISOString().slice(0, 10)).toBe('2026-10-16');
    expect(ledger.day()).toBe('2026-10-17');
    expect(ledger.spent()).toBe(0);
    expect(ledger.spent('2026-10-16')).toBe(2);
  } finally {
    vi.unstubAllEnvs();
  }
});
