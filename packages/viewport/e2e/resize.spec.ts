import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { buildPartMesh, LibraryResolver } from '@brickloop/ldraw';
import { expect } from '@playwright/test';
import { test } from '../../../apps/desktop/e2e/electron-test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchElectron } from '../../../apps/desktop/e2e/electron-launch';
import type { ResizeTestApi } from './resize-fixture';

declare global {
  interface Window {
    resizeTest: ResizeTestApi;
  }
}
const root = fileURLToPath(new URL('../../..', import.meta.url));
const fixtures = path.join(root, '.devdata/m11-7/viewport');
const files: Record<string, string> = {};
let app: ElectronApplication;
let page: Page;
let directory: string;
let logs: string[];

test.beforeAll(async () => {
  await mkdir(fixtures, { recursive: true });
  await build({
    configFile: false,
    root: path.join(root, 'packages/viewport/e2e'),
    base: './',
    logLevel: 'error',
    cacheDir: path.join(fixtures, 'vite-cache'),
    build: {
      outDir: path.join(fixtures, 'renderer'),
      emptyOutDir: true,
      rollupOptions: { input: path.join(root, 'packages/viewport/e2e/resize-fixture.html') },
    },
  });
  // Real 3001 geometry and its dependencies, read only from the LDraw junction.
  await buildPartMesh(
    '3001.dat',
    new LibraryResolver({
      library: {
        id: 'ldraw',
        async readText(relative) {
          try {
            const text = await readFile(path.join(root, 'library/ldraw', relative), 'utf8');
            files[relative] = text;
            return text;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
          }
        },
      },
    }),
  );
});

test.afterEach(async () => {
  try {
    if (page && !page.isClosed()) await page.evaluate(() => window.resizeTest.dispose());
  } finally {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function launch(webgl: boolean, resizeAtCreation = false) {
  directory = await mkdtemp(path.join(fixtures, 'user-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  app = await launchElectron({
    args: ['--force-device-scale-factor=3', path.join(root, 'packages/viewport/e2e/resize-main.cjs')],
    env: {
      ...env,
      BRICKLOOP_DATA_DIR: directory,
      BRICKLOOP_VIEWPORT_FIXTURE: path.join(fixtures, 'renderer/resize-fixture.html'),
    },
  });
  logs = [];
  page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error') logs.push(message.text());
  });
  await page.waitForFunction(() => !!window.resizeTest);
  const before = await page.evaluate((input) => window.resizeTest.create(input), { webgl, files, resizeAtCreation });
  await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-backend', webgl ? 'webgl2' : 'webgpu');
  if (!resizeAtCreation) await idle();
  return before;
}

async function idle() {
  await expect.poll(() => page.evaluate(() => window.resizeTest.frames())).toBeGreaterThan(0);
  // Deliberately measure a quiescent interval before arming a one-shot fault.
  await page.waitForTimeout(180);
  const frames = await page.evaluate(() => window.resizeTest.frames());
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => window.resizeTest.frames())).toBe(frames);
}

async function healthy(before: number) {
  await expect.poll(() => page.evaluate(() => window.resizeTest.frames()), { timeout: 5000 }).toBeGreaterThan(before);
  const dimensions = () =>
    page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('#host')!;
      const canvas = host.querySelector('canvas')!;
      const ratio = Math.min(devicePixelRatio, 2);
      return {
        actual: [canvas.width, canvas.height],
        expected: [Math.floor(host.clientWidth * ratio), Math.floor(host.clientHeight * ratio)],
      };
    });
  await expect
    .poll(async () => {
      const d = await dimensions();
      return d.actual;
    })
    .toEqual((await dimensions()).expected);
  // A subsequent explicit request must also work, not just the first recovery frame.
  const next = await page.evaluate(() => {
    const n = window.resizeTest.frames();
    window.resizeTest.request();
    return n;
  });
  await expect.poll(() => page.evaluate(() => window.resizeTest.frames())).toBeGreaterThan(next);
  const png = await page.evaluate(() => window.resizeTest.capture());
  const red = await app.evaluate(({ nativeImage }, bytes) => {
    const pixels = nativeImage.createFromBuffer(Buffer.from(bytes)).toBitmap();
    let red = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i + 2]! > 80 && pixels[i + 2]! > 4 * pixels[i + 1]! && pixels[i + 2]! > 4 * pixels[i]!) red++;
    return red;
  }, png);
  await test.info().attach('viewport-health', {
    body: JSON.stringify({
      before,
      after: await page.evaluate(() => window.resizeTest.frames()),
      dimensions: await dimensions(),
      redPixels: red,
    }),
    contentType: 'application/json',
  });
  await test.info().attach('viewport-capture', { body: Buffer.from(png), contentType: 'image/png' });
  expect(red).toBeGreaterThan(500);
  await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', '400');
  const restored = await dimensions();
  expect(restored.actual).toEqual(restored.expected);
}

for (const webgl of [false, true]) {
  test.describe(webgl ? 'WebGL2' : 'WebGPU', () => {
    test('UI-05.1 resize in createViewport resolution', async () => {
      await healthy(await launch(webgl, true));
    });
    test('UI-05.2 zero-sized container, requests while hidden, then restore', async () => {
      await launch(webgl);
      const hiddenFrames = await page.evaluate(() => {
        const before = window.resizeTest.resize(0, 0);
        for (let i = 0; i < 5; i++) window.resizeTest.request();
        return before;
      });
      await expect(page.locator('#host')).toHaveCSS('height', '0px');
      await page.waitForTimeout(150);
      expect(await page.evaluate(() => window.resizeTest.frames())).toBe(hiddenFrames);
      await page.evaluate(() => {
        for (let i = 0; i < 5; i++) window.resizeTest.request();
      });
      await healthy(
        await page.evaluate(() => {
          const n = window.resizeTest.resize();
          for (let i = 0; i < 5; i++) window.resizeTest.request();
          return n;
        }),
      );
    });
    test('UI-05.3 forty resizes overlap setParts and gated mesh loading', async () => {
      await launch(webgl);
      await page.evaluate(() => window.resizeTest.holdLoad());
      expect(await page.evaluate(() => window.resizeTest.waiting())).toBe(true);
      const before = await page.evaluate(async () => {
        let before = 0;
        for (let i = 0; i < 40; i++) {
          before = window.resizeTest.resize(600 + i * 2, 400 + i);
          if (i < 20) window.resizeTest.setPartCount(200 + i * 10);
          if (i === 20) window.resizeTest.releaseLoad();
          await new Promise<void>((resolve) => setTimeout(resolve, 8));
        }
        await window.resizeTest.loaded();
        return before;
      });
      expect(await page.evaluate(() => window.resizeTest.waiting())).toBe(false);
      await healthy(before);
    });
    test('UI-05.4 hidden then visible, and focus each redraw an idle viewport', async () => {
      await launch(webgl);
      await page.evaluate(() => {
        window.resizeTest.hidden(true);
        window.resizeTest.resize(720, 410);
      });
      await idle();
      await healthy(await page.evaluate(() => window.resizeTest.hidden(false)));
      await idle();
      await healthy(
        await page.evaluate(() => {
          const n = window.resizeTest.frames();
          window.dispatchEvent(new Event('focus'));
          return n;
        }),
      );
    });
    test('UI-05.5 dropped requestAnimationFrame followed by resize', async () => {
      await launch(webgl);
      const before = await page.evaluate(() => {
        window.resizeTest.dropFrame();
        return window.resizeTest.resize();
      });
      expect(await page.evaluate(() => window.resizeTest.injected())).toBe(1);
      await healthy(before);
    });
    for (const method of ['render', 'setSize'] as const) {
      test(`UI-05.6 one thrown ${method} error, then another request`, async () => {
        await launch(webgl);
        const before = await page.evaluate((method) => {
          window.resizeTest.failNext(method);
          const n = window.resizeTest.resize();
          window.resizeTest.request();
          return n;
        }, method);
        await expect.poll(() => page.evaluate(() => window.resizeTest.injected())).toBe(1);
        await page.evaluate(() => window.resizeTest.request());
        await healthy(before);
        expect(logs.some((log) => log.includes(`UI-05 injected ${method} failure`))).toBe(true);
      });
    }
    for (const mode of ['perspective', 'ortho'] as const) {
      test(`UI-05.7 restore saved ${mode} camera before meshes, then resize`, async () => {
        await launch(webgl);
        await page.evaluate((mode) => window.resizeTest.holdLoad(mode), mode);
        const before = await page.evaluate(async () => {
          window.resizeTest.releaseLoad();
          await window.resizeTest.loaded();
          return window.resizeTest.resize();
        });
        await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-projection', mode);
        await healthy(before);
      });
    }
  });
}
