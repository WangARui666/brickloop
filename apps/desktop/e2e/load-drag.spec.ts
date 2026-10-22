import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import { createDocument, createWorkspace, ulid } from '@brickloop/core';
import { packProject } from '../../../packages/io/src/project';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';

declare global {
  interface Window {
    brickloopEditorTest: EditorTestApi;
  }
}
const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
for (const fallback of [false, true])
  test(`M7-2f ${fallback ? 'WebGL2' : 'WebGPU'} progressive shapes and material batches`, async () => {
    test.setTimeout(180_000);
    await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
    const directory = await mkdtemp(path.join(root, '.devdata/e2e/load-drag-'));
    // Frozen first 64 definitions from the M7-2 performance baseline. The full
    // report list is a historical artifact; this fixture needs no synchronization.
    const definitions = JSON.parse(
      await readFile(new URL('./fixtures/load-drag-definitions.json', import.meta.url), 'utf8'),
    ) as string[];
    const doc = createDocument(),
      model = doc.models[doc.rootModelId]!,
      stepId = model.stepIds[0]!;
    for (let index = 0; index < 64; index++) {
      const id = ulid();
      model.instances[id] = {
        id,
        ref: { kind: 'part', partId: `ld:${definitions[index]!.slice(0, -4)}` },
        colorId: 'c:bright-red',
        transform: [(index % 8) * 100, -24, Math.floor(index / 8) * 100, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        stepId,
        groupId: null,
      };
      model.steps[stepId]!.instanceIds.push(id);
    }
    const file = path.join(directory, 'multi.brkl');
    await writeFile(file, packProject(doc, createWorkspace()));
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await launchElectron({
      args: [...(fallback ? ['--disable-gpu', '--enable-unsafe-swiftshader'] : []), path.join(root, 'apps/desktop')],
      env: { ...env, BRICKLOOP_DATA_DIR: directory },
      timeout: 60_000,
    });
    const page = await app.firstWindow();

    try {
      await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
      await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
      const surface = page.locator('.brickloop-viewport');
      await expect(surface).toHaveAttribute('data-part-count', '64');
      await page.evaluate(async () => {
        const api = window.brickloopEditorTest;
        api.preset('top');
        api.select([api.expanded()[0]!.path]);
        api.command({ type: 'transform.translate', delta: [20, 0, 0] });
        await api.meshesReady();
        api.action('view.fitAll');
      });
      await expect(surface).toHaveAttribute('data-loaded-part-count', '64');
      await expect
        .poll(() => page.evaluate(() => window.brickloopEditorTest.snapshot().metrics.drawCalls))
        .toBeLessThan(30);
      await page.evaluate(() => window.brickloopEditorTest.savePreferences({ edgeMode: 'always' }));
      expect(await page.evaluate(() => window.brickloopEditorTest.preferences().edgeMode)).toBe('always');
      const screenshot = path.join(
        root,
        `.devdata/e2e-results/screenshots/round2-${fallback ? 'webgl2' : 'webgpu'}.png`,
      );
      await mkdir(path.dirname(screenshot), { recursive: true });
      const picture = await surface.screenshot({ path: screenshot });
      const colored = await app.evaluate(({ nativeImage }, base64) => {
        const bytes = nativeImage.createFromBuffer(Buffer.from(base64, 'base64')).toBitmap();
        let count = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          const channels = [bytes[i]!, bytes[i + 1]!, bytes[i + 2]!];
          if (Math.max(...channels) > 80 && Math.max(...channels) - Math.min(...channels) > 55) count++;
        }
        return count;
      }, picture.toString('base64'));
      expect(colored).toBeGreaterThan(1500);
    } finally {
      await page.evaluate(() => window.brickloopEditorTest.prepareClose()).catch(() => undefined);
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
