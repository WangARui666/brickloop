import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import type { Page, ElectronApplication } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { imageModelServer } from './image-model-fixture';
import { fakeModel } from './ai-model-fixture';
import type { ToolResult } from '@brickloop/ai';
import { contentSecurityPolicy } from '../src/shared/content-security-policy';
import type { AllowedPageError } from './page-errors';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(desktop, '../..');

async function launch(rendererUrl?: string, allowPageErrors?: AllowedPageError[]) {
  const directory = await mkdtemp(path.join(root, '.devdata/retest-'));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
    BRICKLOOP_DATA_DIR: directory,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BRICKLOOP_EVAL_API_KEY;
  delete env.ELECTRON_RENDERER_URL;
  if (rendererUrl) env.ELECTRON_RENDERER_URL = rendererUrl;
  const app = await launchElectron({ args: [desktop], env, ...(allowPageErrors ? { allowPageErrors } : {}) });
  const page = await app.firstWindow();
  const errors: string[] = [];

  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setContentSize(1100, 700);
    window.webContents.setBackgroundThrottling(false);
  });
  await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', { timeout: 45_000 });
  await page.waitForFunction(() => !!window.brickloopEditorTest);
  return { app, page, errors, directory };
}
async function close(fixture: Awaited<ReturnType<typeof launch>>) {
  const { app, page, directory } = fixture;
  await page.evaluate(() => window.brickloop.aiStop()).catch(() => undefined);
  await page
    .waitForFunction(() => !window.brickloopEditorTest.aiState().running, undefined, { timeout: 5000 })
    .catch(() => undefined);
  await page.evaluate(() => window.brickloopEditorTest.prepareClose()).catch(() => undefined);
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    })
    .catch(() => undefined);
  await app.close();
  // Chromium's profile database can stay locked briefly after the process exits on Windows.
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
async function provider(page: Page, endpoint: string) {
  const id = randomUUID();
  await page.evaluate(
    async ({ id, endpoint }) => {
      const snapshot = await window.brickloop.aiSaveProvider({
        id,
        name: '脚本复测',
        type: 'compatible',
        endpoint,
        model: 'offline-model',
        models: ['offline-model'],
        proxy: 'system',
        proxyUrl: '',
      });
      await window.brickloop.aiSaveSettings({ ...snapshot.settings, defaultProviderId: id, localOnly: true });
    },
    { id, endpoint },
  );
  return id;
}
async function startImage(page: Page, id: string, directStart = false) {
  const base64 = (await readFile(path.join(root, 'packages/ai/test/ai-eval/references/01-front.png'))).toString(
    'base64',
  );
  return page.evaluate(
    async ({ base64, id, directStart }) =>
      window.brickloopEditorTest.imageStart({
        providerId: id,
        model: 'offline-model',
        directStart,
        budget: { rounds: 8, toolCalls: 400, durationMs: 120_000 },
        input: {
          description: '十六部件大教堂',
          images: [{ name: '参考图', view: 'front', image: { type: 'image', mime: 'image/png', base64 } }],
          targetSize: 'medium',
          palette: { source: 'factory' },
          parts: { source: 'all' },
          style: '',
        },
      }),
    { base64, id, directStart },
  );
}

async function assertCsp(page: Page, directory: string) {
  // Runtime.evaluate normally bypasses CSP, including new Function inside page.evaluate.
  const cdp = await page.context().newCDPSession(page);
  const probe = await cdp.send('Runtime.evaluate', {
    expression: `(()=>{try{new Function('return 1')();return false}catch(e){return e instanceof EvalError}})()`,
    allowUnsafeEvalBlockedByCSP: false,
    returnByValue: true,
  });
  expect(probe.result.value).toBe(true);
  await cdp.detach();
  const source = `let blocked=false;try{new Function('return 1')()}catch(e){blocked=e instanceof EvalError}WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0])).then(()=>postMessage({blocked,wasm:true}),()=>postMessage({blocked,wasm:false}));`;
  const workerFile = path.join(directory, 'csp-probe.js');
  await writeFile(workerFile, source);
  // The production helper wraps file modules in a blob entry that inherits page CSP.
  for (const worker of page.url().startsWith('file:') ? [pathToFileURL(workerFile).href, null] : [null]) {
    const result = worker
      ? await page.evaluate((url) => window.brickloopEditorTest.probeWorker(url), worker)
      : await page.evaluate(
          async ({ source, worker }) => {
            const url = worker ?? URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            try {
              return await new Promise<{ blocked: boolean; wasm: boolean }>((resolve, reject) => {
                const instance = new Worker(url);
                const timeout = setTimeout(() => {
                  instance.terminate();
                  reject(new Error('CSP Worker did not reply'));
                }, 10_000);
                instance.onmessage = (e) => {
                  clearTimeout(timeout);
                  instance.terminate();
                  resolve(e.data);
                };
                instance.onerror = (e) => {
                  clearTimeout(timeout);
                  instance.terminate();
                  reject(new Error(e.message));
                };
              });
            } finally {
              if (!worker) URL.revokeObjectURL(url);
            }
          },
          { source, worker },
        );
    expect(result).toEqual({ blocked: true, wasm: true });
  }
}

for (const development of [false, true])
  test(`M9-5h CSP/WASM: ${development ? 'development HTTP' : 'production file'}`, async () => {
    test.setTimeout(120_000);
    const vite = development
      ? await createServer({
          configFile: false,
          root: path.join(desktop, 'src/renderer'),
          mode: 'test',
          plugins: [
            react(),
            {
              name: 'test-csp',
              transformIndexHtml: (html) => html.replace('__BRICKLOOP_CSP__', contentSecurityPolicy(true)),
            },
          ],
          cacheDir: path.join(root, '.devdata/vite-retest'),
          optimizeDeps: { include: ['quickjs-emscripten'] },
          resolve: {
            alias: {
              'quickjs-emscripten': path.join(
                root,
                'packages/buildscript/node_modules/quickjs-emscripten/dist/index.mjs',
              ),
            },
          },
          worker: { format: 'es' },
          server: { host: '127.0.0.1', port: 0 },
        })
      : undefined;
    await vite?.listen();
    const fixture = await launch(vite?.resolvedUrls?.local[0]);
    const model = await fakeModel();
    try {
      const { page, directory } = fixture;
      expect(page.url().startsWith(development ? 'http:' : 'file:')).toBe(true);
      await assertCsp(page, directory);
      const id = await provider(page, model.endpoint);
      model.frames.push(
        {
          calls: [
            {
              name: 'run_build_script',
              arguments: {
                scriptId: 'csp-script',
                code: `part('3001',{x:0,z:0,y:3},'c:bright-red'); part('3001',{x:1,z:0,y:3},'c:bright-red');`,
              },
            },
          ],
        },
        { text: '脚本化模型已生成零件。' },
      );
      const taskId = await page.evaluate(
        async (providerId) =>
          window.brickloop.aiStart({
            providerId,
            model: 'offline-model',
            effort: 'fast',
            text: '脚本测试',
            images: [],
            selection: false,
            modelContext: false,
          }),
        id,
      );
      await expect
        .poll(() =>
          page.evaluate((id) => window.brickloopEditorTest.tasks().find((task) => task.taskId === id)?.status, taskId),
        )
        .toBe('merged');
      expect(
        await page.evaluate(() => window.brickloopEditorTest.expanded().length),
        JSON.stringify({
          errors: fixture.errors,
          turns: await page.evaluate(() => window.brickloopEditorTest.aiState().turns),
        }),
      ).toBe(2);
      const checked = (await page.evaluate(async () =>
        window.brickloopEditorTest.aiTool('validate', {}),
      )) as ToolResult;
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      expect(JSON.stringify(checked)).toContain('collision');
      await page.screenshot({
        path: path.join(root, `.devdata/e2e-results/m9-5h-${development ? 'dev' : 'file'}.png`),
      });
      expect(fixture.errors).toEqual([]);
    } finally {
      await close(fixture);
      await model.close();
      await vite?.close();
    }
  });

async function burstProgress(app: ElectronApplication, page: Page) {
  const workflow = await page.evaluate(() => {
    const w = window.brickloopEditorTest.aiState().workflow;
    return w?.state ? { taskId: w.taskId, state: w.state } : null;
  });
  if (workflow)
    await app.evaluate(({ BrowserWindow }, w) => {
      for (let index = 0; index < 200; index++)
        BrowserWindow.getAllWindows()[0]!.webContents.send('ai.notice', {
          type: 'workflow',
          turnId: w.taskId,
          event: { type: 'state', state: w.state },
        });
    }, workflow);
}

test('M9-5h: React 185 regression, six-round layout and paused UI clocks', async () => {
  test.setTimeout(180_000);
  const fixture = await launch(),
    server = await imageModelServer();
  server.controls.cathedral = true;
  server.controls.delay = 1000;
  try {
    const { page, app } = fixture;
    const id = await provider(page, server.endpoint);
    await page.keyboard.press('Control+k');
    const notices = await page.evaluateHandle(() => {
      const received = { planningStates: 0, rounds: [] as number[], comparisons: [] as number[] };
      window.brickloop.onAiNotice((notice) => {
        if (notice.type !== 'workflow') return;
        const event = notice.event;
        if (event.type === 'state' && event.state.phase === 'understanding') received.planningStates++;
        if (event.type === 'round') received.rounds.push(event.round.round);
        if (event.type === 'comparison') received.comparisons.push(event.comparison.round);
      });
      return received;
    });
    await startImage(page, id);
    await page.waitForFunction(() => window.brickloopEditorTest.aiState().workflow?.state?.phase === 'understanding');
    for (let n = 0; n < 5; n++) await burstProgress(app, page);
    await expect(page.locator('.image-plan-table tbody tr')).toHaveCount(16);
    await page.getByRole('textbox', { name: '部件名称', exact: true }).first().fill('设计师修改的正门');
    await burstProgress(app, page);
    await expect(page.getByRole('textbox', { name: '部件名称', exact: true }).first()).toHaveValue('设计师修改的正门');
    expect(fixture.errors).toEqual([]);
    expect(await notices.evaluate((received) => received.planningStates)).toBeGreaterThanOrEqual(1000);
    await page.getByRole('button', { name: '开始搭建', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().workflow?.rounds?.length ?? 0), {
        timeout: 100_000,
      })
      .toBeGreaterThanOrEqual(6);
    await page.locator('.image-task-card').getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.locator('.image-task-card').getByRole('button', { name: '继续', exact: true })).toBeVisible();
    await burstProgress(app, page);
    const before = await page.locator('.image-task-budget').innerText();
    await page.waitForTimeout(1500);
    expect(await page.locator('.image-task-budget').innerText()).toBe(before);
    const bounds = await page.evaluate(() => {
      const card = document.querySelector('.image-task-card')!,
        list = document.querySelector('.ai-message-list')!;
      return {
        card: card.getBoundingClientRect().height,
        panel: card.parentElement!.getBoundingClientRect().height,
        list: list.getBoundingClientRect().height,
        scroll: list.scrollHeight > list.clientHeight,
      };
    });
    expect(bounds.card).toBeLessThanOrEqual(bounds.panel * 0.45 + 1);
    expect(bounds.list).toBeGreaterThan(80);
    expect(bounds.scroll).toBe(true);
    await expect(page.locator('.image-task-card .image-round-timeline details[open]')).toHaveCount(1);
    const oldest = page.locator('.ai-message-list .ai-tool').first();
    await oldest.locator('summary').click();
    await expect(oldest.locator('pre')).toBeInViewport();
    await burstProgress(app, page);
    await expect(oldest.locator('pre')).toBeInViewport();
    const received = await notices.jsonValue();
    for (let round = 1; round <= 6; round++) {
      expect(received.rounds).toContain(round);
      expect(received.comparisons).toContain(round);
    }
    await page.locator('.image-task-card').getByRole('button', { name: '继续', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().workflow?.rounds?.length ?? 0))
      .toBeGreaterThanOrEqual(7);
    await expect(oldest.locator('pre')).toBeInViewport();
    await page.screenshot({ path: path.join(root, '.devdata/e2e-results/m9-5h-six-rounds.png') });
    expect(fixture.errors).toEqual([]);
  } finally {
    await close(fixture);
    await server.close();
  }
});

test('M9-5h: large working-copy preview stays framed on an empty document', async () => {
  test.setTimeout(180_000);
  const fixture = await launch(),
    server = await imageModelServer();
  server.controls.largePreview = true;
  server.controls.delay = 1000;
  try {
    const { page, app } = fixture;
    const initial = await page.evaluate(() => window.brickloopEditorTest.camera());
    await startImage(page, await provider(page, server.endpoint), true);
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.previewCounts().parts), {
        timeout: 100_000,
      })
      .toBe(1112);
    await page.evaluate(() => window.brickloop.aiImageControl('pause'));
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(0);
    const picture = await page.locator('.brickloop-viewport > canvas').screenshot({
      path: path.join(root, '.devdata/e2e-results/m9-5h-large-preview.png'),
    });
    const blueFraction = await app.evaluate(({ nativeImage }, base64) => {
      const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
      const bitmap = image.toBitmap();
      let blue = 0;
      for (let i = 0; i < bitmap.length; i += 4) {
        const b = bitmap[i]!,
          g = bitmap[i + 1]!,
          r = bitmap[i + 2]!;
        if (b > 100 && b > r * 1.2 && b > g * 1.15) blue++;
      }
      return blue / (bitmap.length / 4);
    }, picture.toString('base64'));
    expect(fixture.errors).toEqual([]);
    expect(blueFraction).toBeGreaterThan(0.005);
    expect(blueFraction).toBeLessThan(0.5);
    const framed = await page.evaluate(() => window.brickloopEditorTest.camera());
    expect(framed.span).toBeGreaterThan(initial.span * 2);
    await writeFile(
      path.join(root, '.devdata/e2e-results/m9-5h-large-preview-metrics.json'),
      JSON.stringify({ blueFraction, initial, framed }, null, 2),
    );
    // A deliberate close inspection must survive later working-copy updates.
    await page.evaluate(() => window.brickloopEditorTest.zoomReview(0.05));
    const manual = await page.evaluate(() => window.brickloopEditorTest.camera());
    await page.evaluate(() => window.brickloop.aiImageControl('resume'));
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.previewCounts().parts), {
        timeout: 60_000,
      })
      .toBe(1150);
    await page.evaluate(() => window.brickloop.aiImageControl('pause'));
    expect(await page.evaluate(() => window.brickloopEditorTest.camera())).toEqual(manual);
    await page.evaluate((camera) => window.brickloopEditorTest.restoreCamera(camera, camera.span), framed);
    await page.evaluate(() => window.brickloop.aiStop());
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(1150);
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.previewCounts().parts)).toBe(0);
    expect((await page.evaluate(() => window.brickloopEditorTest.camera())).span).toBeCloseTo(framed.span);
    await page.screenshot({ path: path.join(root, '.devdata/e2e-results/m9-5h-large-preview-merged.png') });
    expect(fixture.errors).toEqual([]);
  } finally {
    await close(fixture);
    await server.close();
  }
});

test('M9-5h: unavailable engine stops both image workflow and chat after one call', async () => {
  const fixture = await launch(),
    imageServer = await imageModelServer(),
    model = await fakeModel();
  try {
    const { page } = fixture;
    await page.keyboard.press('Control+k');
    await page.evaluate(() => {
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          if (String(url).includes('buildscript.worker') || options?.name?.includes('buildscript.worker'))
            throw new Error('WebAssembly module unavailable');
          super(url, options);
        }
      };
    });
    await startImage(page, await provider(page, imageServer.endpoint), true);
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)?.report?.reason))
      .toBe('engine_unavailable');
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
    const report = await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)!.report!);
    expect(report.rounds).toHaveLength(0);
    await expect(page.getByText('搭建引擎无法启动', { exact: true })).toBeVisible();
    const id = await provider(page, model.endpoint);
    model.frames.push(
      { calls: [{ name: 'run_build_script', arguments: { scriptId: 'engine', code: 'box(0,0,0,4,4,3,"Red")' } }] },
      { calls: [{ name: 'run_build_script', arguments: { scriptId: 'engine', code: 'box(0,0,0,4,4,3,"Red")' } }] },
    );
    await page.evaluate(
      async (providerId) =>
        window.brickloop.aiStart({
          providerId,
          model: 'offline-model',
          effort: 'fast',
          text: '搭建测试',
          images: [],
          selection: false,
          modelContext: false,
        }),
      id,
    );
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
    expect(model.requests).toHaveLength(1);
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(0);
    await expect(
      page.getByRole('alert').getByText('搭建引擎无法启动。本次任务已停止，请重新加载界面后重试。', { exact: true }),
    ).toBeVisible();
    expect(fixture.errors).toEqual([]);
  } finally {
    await close(fixture);
    await imageServer.close();
    await model.close();
  }
});

test('M9-5h: render boundary offers reload and restores unsaved document', async () => {
  const fixture = await launch(undefined, [
    {
      pattern: /^Cannot read properties of null \(reading 'every'\)$/,
      reason:
        'crashRenderer intentionally sets the view document to null to exercise the render boundary and recovery.',
    },
  ]);
  try {
    const { page } = fixture;
    await page.evaluate(() =>
      window.brickloopEditorTest.command({ type: 'part.add', partId: 'ld:3001', colorId: 'c:bright-red' }),
    );
    const documentId = await page.evaluate(() => window.brickloopEditorTest.snapshot().document.documentId);
    await page.evaluate(() => window.brickloopEditorTest.crashRenderer());
    await expect(page.getByRole('heading', { name: '界面遇到了错误' })).toBeVisible();
    expect(fixture.errors.some((error) => /null|every/.test(error))).toBe(true);
    fixture.errors.length = 0;
    await page.getByRole('button', { name: '重新加载界面', exact: true }).click();
    await expect(page.getByRole('button', { name: '恢复', exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '恢复', exact: true }).first().click();
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(1);
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().document.documentId)).toBe(documentId);
    expect(fixture.errors).toEqual([]);
  } finally {
    await close(fixture);
  }
});
