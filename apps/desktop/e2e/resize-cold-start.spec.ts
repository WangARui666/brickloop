import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { createDocument, createWorkspace, ulid } from '@brickloop/core';
import type { Workspace } from '@brickloop/core';
import { packProject } from '../../../packages/io/src/project';
import { launchElectron } from './electron-launch';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';

declare global {
  interface Window {
    brickloopEditorTest: EditorTestApi;
  }
}
const root = fileURLToPath(new URL('../../..', import.meta.url));

test('UI-05 cold first launch: maximize, restore and resize before library-ready', async () => {
  test.setTimeout(90_000);
  const scratch = path.join(root, '.devdata/e2e');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, 'resize-cold-'));
  const user = path.join(directory, 'user');
  await mkdir(user);
  expect(await readdir(user)).toEqual([]);
  const doc = createDocument({ title: 'UI-05 cold resize' });
  const model = doc.models[doc.rootModelId]!;
  for (let i = 0; i < 400; i++) {
    const id = ulid();
    model.instances[id] = {
      id,
      ref: { kind: 'part', partId: 'ld:3001' },
      colorId: 'c:bright-red',
      transform: [((i % 20) - 10) * 100, 0, 6000 + Math.floor(i / 20) * 100, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      stepId: model.stepIds[0]!,
      groupId: null,
    };
    model.steps[model.stepIds[0]!]!.instanceIds.push(id);
  }
  const workspace = createWorkspace();
  const camera: Workspace['camera'] & { span: number } = {
    mode: 'ortho',
    position: [0, -2000, 0],
    target: [0, -12, 7450],
    up: [0, -1, 0],
    fov: 35,
    span: 3000,
  };
  workspace.camera = camera;
  const file = path.join(directory, 'scene.brkl');
  await writeFile(file, packProject(doc, workspace));
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron({
    args: [path.join(root, 'apps/desktop'), file],
    env: { ...env, BRICKLOOP_DATA_DIR: user },
  });
  const page = await app.firstWindow();

  try {
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'false');
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.webContents.setBackgroundThrottling(false);
      const invalidate = window.webContents.invalidate.bind(window.webContents);
      Object.assign(globalThis, { resizeInvalidations: 0 });
      window.webContents.invalidate = () => {
        (globalThis as unknown as { resizeInvalidations: number }).resizeInvalidations++;
        invalidate();
      };
    });
    const surface = page.locator('.brickloop-viewport');
    let before = 0;
    for (let i = 0; i < 8; i++) {
      expect(await page.locator('[data-library-ready]').getAttribute('data-library-ready')).toBe('false');
      before = Number((await surface.getAttribute('data-render-count')) ?? 0);
      await app.evaluate(async ({ BrowserWindow }, i) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.maximize();
        await new Promise((resolve) => setTimeout(resolve, 30));
        window.unmaximize();
        window.setSize(1100 + i * 20, 720 + i * 10);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }, i);
    }
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45_000,
    });
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
    await page.evaluate(() => window.brickloopEditorTest.meshesReady());
    await expect(surface).toHaveAttribute('data-loaded-part-count', '400');
    await expect.poll(async () => Number(await surface.getAttribute('data-render-count'))).toBeGreaterThan(before);
    const dimensions = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('.brickloop-viewport > canvas')!;
      const host = canvas.parentElement!.parentElement!;
      return {
        actual: [canvas.width, canvas.height],
        expected: [
          Math.floor(host.clientWidth * Math.min(devicePixelRatio, 2)),
          Math.floor(host.clientHeight * Math.min(devicePixelRatio, 2)),
        ],
      };
    });
    expect(dimensions.actual).toEqual(dimensions.expected);
    before = await page.evaluate(() => {
      const count = Number(document.querySelector<HTMLElement>('.brickloop-viewport')!.dataset.renderCount);
      window.brickloopEditorTest.requestRender();
      return count;
    });
    await expect.poll(async () => Number(await surface.getAttribute('data-render-count'))).toBeGreaterThan(before);
    const png = await page.evaluate(() => window.brickloopEditorTest.captureViewport());
    const red = await app.evaluate(({ nativeImage }, bytes) => {
      const bitmap = nativeImage.createFromBuffer(Buffer.from(bytes)).toBitmap();
      let red = 0;
      for (let i = 0; i < bitmap.length; i += 4)
        if (bitmap[i + 2]! > 80 && bitmap[i + 2]! > bitmap[i + 1]! * 4 && bitmap[i + 2]! > bitmap[i]! * 4) red++;
      return red;
    }, png);
    expect(red).toBeGreaterThan(500);
    expect(
      await app.evaluate(() => (globalThis as unknown as { resizeInvalidations: number }).resizeInvalidations),
    ).toBeGreaterThan(0);
    // Exercise every registered native event, including Windows' end-of-resize event.
    const invalidations = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const counts: number[] = [];
      for (const event of ['maximize', 'unmaximize', 'restore', 'resized']) {
        const before = (globalThis as unknown as { resizeInvalidations: number }).resizeInvalidations;
        window.emit(event);
        counts.push((globalThis as unknown as { resizeInvalidations: number }).resizeInvalidations - before);
      }
      return counts;
    });
    expect(invalidations).toEqual([1, 1, 1, 1]);
  } finally {
    await page.evaluate(() => window.brickloopEditorTest?.prepareClose()).catch(() => undefined);
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
