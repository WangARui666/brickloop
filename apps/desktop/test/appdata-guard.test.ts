import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppDataGuard } from '../../../scripts/appdata-guard.mjs';

const base = fileURLToPath(new URL('../../../.devdata/', import.meta.url));
let directory: string;
let environment: { APPDATA: string; LOCALAPPDATA: string };

beforeEach(async () => {
  await mkdir(base, { recursive: true });
  directory = await mkdtemp(path.join(base, 'm11-3-appdata-'));
  environment = { APPDATA: path.join(directory, 'Roaming'), LOCALAPPDATA: path.join(directory, 'Local') };
  await Promise.all(Object.values(environment).map((root) => mkdir(root)));
});

afterEach(async () => {
  if (path.dirname(path.resolve(directory)) !== path.resolve(base)) throw new Error('Unsafe guard test cleanup');
  await rm(directory, { recursive: true, force: true });
});

describe('A-91 AppData guard', () => {
  it('passes when no Brickloop directory appears and does not create anything', async () => {
    const check = await createAppDataGuard(environment, 'win32');
    await expect(check()).resolves.toBeUndefined();
    for (const root of Object.values(environment)) expect(await readdir(root)).toEqual([]);
  });

  describe.each(['APPDATA', 'LOCALAPPDATA'] as const)('%s', (key) => {
    it.each(['@brickloop', 'Brickloop'])('rejects a newly created %s and lists its contents', async (name) => {
      const check = await createAppDataGuard(environment, 'win32');
      const target = path.join(environment[key], name);
      await mkdir(target);
      await writeFile(path.join(target, 'Local State'), 'chromium');
      const message = await check().catch((error: Error) => error.message);
      expect(message).toContain(target);
      expect(message).toContain('第一层内容：Local State');
      expect(message).toContain('主进程设置 userData 之前失败');
      expect(message).toContain('launchElectron');
      expect(message).toContain('手动删除');
      expect(await readFile(path.join(target, 'Local State'), 'utf8')).toBe('chromium');
    });

    it('rejects a pre-existing @brickloop without modifying it', async () => {
      const target = path.join(environment[key], '@brickloop');
      await mkdir(target);
      const before = await stat(target);
      const check = await createAppDataGuard(environment, 'win32');
      await expect(check()).rejects.toThrow('存在 @brickloop（无论运行前是否已存在）');
      expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);
      expect(await readdir(target)).toEqual([]);
    });

    it('allows an unchanged pre-existing Brickloop', async () => {
      const target = path.join(environment[key], 'Brickloop');
      await mkdir(path.join(target, 'config'), { recursive: true });
      await writeFile(path.join(target, 'config/settings.json'), '{}');
      const check = await createAppDataGuard(environment, 'win32');
      await expect(check()).resolves.toBeUndefined();
    });

    it('rejects a new file in pre-existing Brickloop and explains concurrent installed-app activity', async () => {
      const target = path.join(environment[key], 'Brickloop');
      await mkdir(target);
      const check = await createAppDataGuard(environment, 'win32');
      await writeFile(path.join(target, 'settings.json'), '{}');
      await expect(check()).rejects.toThrow('同时运行的已安装 Brickloop 也可能导致这一项');
    });

    it.each(['size', 'mtime'])('detects a second-level file %s change', async (change) => {
      const target = path.join(environment[key], 'Brickloop/config');
      await mkdir(target, { recursive: true });
      const file = path.join(target, 'settings.json');
      await writeFile(file, '{}');
      const before = await stat(file);
      const check = await createAppDataGuard(environment, 'win32');
      if (change === 'size') {
        await writeFile(file, '{"changed":true}');
        await utimes(file, before.atime, before.mtime);
      } else {
        await utimes(file, before.atime, new Date(before.mtimeMs + 2000));
      }
      await expect(check()).rejects.toThrow('已有 Brickloop 的指纹发生变化');
    });

    it('detects modification of the Brickloop directory itself', async () => {
      const target = path.join(environment[key], 'Brickloop');
      await mkdir(target);
      const before = await stat(target);
      const check = await createAppDataGuard(environment, 'win32');
      await utimes(target, before.atime, new Date(before.mtimeMs + 2000));
      await expect(check()).rejects.toThrow('已有 Brickloop 的指纹发生变化');
    });
  });

  it('reports all four paths when both roots have leaks', async () => {
    const check = await createAppDataGuard(environment, 'win32');
    for (const root of Object.values(environment)) {
      for (const name of ['@brickloop', 'Brickloop']) await mkdir(path.join(root, name));
    }
    const message = await check().catch((error: Error) => error.message);
    for (const root of Object.values(environment)) {
      for (const name of ['@brickloop', 'Brickloop']) expect(message).toContain(path.join(root, name));
    }
  });

  it.each([{}, { APPDATA: '', LOCALAPPDATA: 'relative' }])('skips missing or relative roots: %j', async (env) => {
    const check = await createAppDataGuard(env, 'win32');
    await expect(check()).resolves.toBeUndefined();
  });

  it('still checks the valid root when the other root is absent', async () => {
    const check = await createAppDataGuard({ LOCALAPPDATA: environment.LOCALAPPDATA }, 'win32');
    await mkdir(path.join(environment.LOCALAPPDATA, 'Brickloop'));
    await expect(check()).rejects.toThrow('运行后新出现 Brickloop');
  });

  it.each(['linux', 'darwin'] as const)('skips all checks on %s', async (platform) => {
    await mkdir(path.join(environment.APPDATA, '@brickloop'));
    const check = await createAppDataGuard(environment, platform);
    await expect(check()).resolves.toBeUndefined();
  });
});
