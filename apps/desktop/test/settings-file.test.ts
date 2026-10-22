import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type * as FileSystem from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsFile } from '../src/main/settings-file';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const temporaryRoot = fileURLToPath(new URL('../../../.devdata/desktop-unit/', import.meta.url));
let directory: string;

beforeEach(async () => {
  await mkdir(temporaryRoot, { recursive: true });
  directory = await mkdtemp(path.join(temporaryRoot, 'settings-'));
  vi.mocked(rename).mockClear();
});
afterEach(async () => {
  if (!directory.startsWith(temporaryRoot)) throw new Error('Unsafe test cleanup path');
  await rm(directory, { recursive: true, force: true });
});

describe('settings file adapter', () => {
  it('creates defaults in a missing directory and loads saved language after restart', async () => {
    const nested = path.join(directory, 'new');
    const file = createSettingsFile(nested);
    expect(await file.load()).toEqual({ language: 'zh-CN' });
    await file.save({ language: 'en' });
    expect(await createSettingsFile(nested).load()).toEqual({ language: 'en' });
    expect(await readdir(nested)).toEqual(['settings.json']);
  });
  it.each(['{broken', '{"language":"unsupported"}'])(
    'backs up corrupt settings and replaces them with Chinese defaults',
    async (content) => {
      await writeFile(path.join(directory, 'settings.json'), content);
      expect(await createSettingsFile(directory).load()).toEqual({ language: 'zh-CN' });
      const files = await readdir(directory);
      const backup = files.find((file) => file.startsWith('settings.corrupt-'));
      expect(backup).toBeDefined();
      expect(await readFile(path.join(directory, backup!), 'utf8')).toBe(content);
      expect(await createSettingsFile(directory).load()).toEqual({ language: 'zh-CN' });
      expect((await readdir(directory)).length).toBe(2);
    },
  );
  it('preserves original invalid bytes in the corrupt backup', async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00]);
    await writeFile(path.join(directory, 'settings.json'), bytes);
    await createSettingsFile(directory).load();
    const backup = (await readdir(directory)).find((file) => file.startsWith('settings.corrupt-'));
    expect(await readFile(path.join(directory, backup!))).toEqual(bytes);
  });
  it('writes a temporary file in the same directory before renaming', async () => {
    await createSettingsFile(directory).save({ language: 'en' });
    expect(rename).toHaveBeenCalledWith(
      expect.stringMatching(/settings\.json\..+\.tmp$/),
      path.join(directory, 'settings.json'),
    );
    const [source] = vi.mocked(rename).mock.calls[0]!;
    expect(path.dirname(String(source))).toBe(directory);
    expect(await readdir(directory)).toEqual(['settings.json']);
  });
  it('keeps the old settings on a failed rename, cleans the temporary file, and allows retry', async () => {
    const file = createSettingsFile(directory);
    await file.save({ language: 'zh-CN' });
    vi.mocked(rename).mockRejectedValueOnce(new Error('simulated rename failure'));
    await expect(file.save({ language: 'en' })).rejects.toThrow('simulated rename failure');
    expect(await file.load()).toEqual({ language: 'zh-CN' });
    expect(await readdir(directory)).toEqual(['settings.json']);
    await file.save({ language: 'en' });
    expect(await file.load()).toEqual({ language: 'en' });
  });
  it('serializes rapid saves in request order', async () => {
    const file = createSettingsFile(directory);
    await Promise.all([file.save({ language: 'en' }), file.save({ language: 'zh-CN' }), file.save({ language: 'en' })]);
    expect(await file.load()).toEqual({ language: 'en' });
    expect(await readdir(directory)).toEqual(['settings.json']);
  });
  it('does not overwrite a read error with defaults', async () => {
    await mkdir(path.join(directory, 'settings.json'));
    await expect(createSettingsFile(directory).load()).rejects.toThrow();
    expect(await readdir(directory)).toEqual(['settings.json']);
  });
});
