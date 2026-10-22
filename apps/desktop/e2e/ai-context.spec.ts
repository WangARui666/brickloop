import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import type { ElectronApplication, Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { build } from 'vite';
import type { ImageBlock, ToolResult } from '@brickloop/ai';
import type { DesktopApi } from '../src/shared/api';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';
import type * as Context from '../src/renderer/src/ai-context';
import { SUMMARY_TEMPLATE } from '../../../packages/ai/src/agent/compaction';
import { estimateInputTokens } from '../../../packages/ai/src/agent/history';
import { createEditorTools } from '../../../packages/ai/src/tools';
import { fakeModel } from './ai-model-fixture';
import { imageModelServer } from './image-model-fixture';
import { launchElectron } from './electron-launch';
import { calibrate, classifyAttempt, decide } from './machine-speed';

declare global {
  interface Window {
    brickloop: DesktopApi;
    brickloopEditorTest: EditorTestApi;
  }
}
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(desktop, '../..');
const evidence = path.join(root, '.devdata/e2e-results/ai-context');
let context: typeof Context;
const capabilities = { vision: false, tools: false, reasoning: true, maxContext: 0, contextWindow: null };
test.beforeAll(async () => {
  // Bundle the renderer's exact source so workspace JSON imports also work in Node.
  const outDir = path.join(root, '.devdata/e2e-context-module');
  await build({
    root,
    configFile: false,
    cacheDir: path.join(root, '.devdata/vite-context-e2e'),
    logLevel: 'error',
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: path.join(desktop, 'src/renderer/src/ai-context.ts'),
        formats: ['es'],
        fileName: () => 'ai-context.mjs',
      },
    },
  });
  context = (await import(pathToFileURL(path.join(outDir, 'ai-context.mjs')).href)) as typeof context;
});
test.afterAll(async () => {
  await rm(path.join(root, '.devdata/e2e-context-module'), { recursive: true, force: true });
});
async function launch(directory: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron({
    args: [desktop],
    env: { ...env, BRICKLOOP_DATA_DIR: directory, BRICKLOOP_TEST_RETRY_DELAY_MS: '1000' },
    timeout: 30000,
  });
  const page = await app.firstWindow();

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setContentSize(1440, 900);
    window.webContents.setBackgroundThrottling(false);
  });
  try {
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45000,
    });
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'launch-failure.png') }).catch(() => undefined);
    await app.close();
    throw error;
  }
  return { app, page };
}
async function stop(app: ElectronApplication) {
  const page = app.windows()[0];
  if (page) await page.evaluate(() => window.brickloopEditorTest?.prepareClose()).catch(() => undefined);
  await app.close();
}
async function configure(page: Page, endpoint: string, presetId = 'custom', model = 'offline-model') {
  const id = randomUUID();
  await page.evaluate(
    async ({ id, endpoint, presetId, model }) => {
      await window.brickloop.aiSaveProvider(
        {
          id,
          type: 'compatible',
          presetId,
          name: '上下文离线验收',
          endpoint,
          model,
          models: [model],
          proxy: 'system',
          proxyUrl: '',
        },
        'offline-context-key',
      );
    },
    { id, endpoint, presetId, model },
  );
  await page.evaluate(() => window.brickloopEditorTest.action('ai.open'));
  return id;
}
async function start(page: Page, providerId: string, text: string, model = 'offline-model') {
  return page.evaluate(
    ({ providerId, text, model }) =>
      window.brickloop.aiStart({
        providerId,
        model,
        effort: 'balanced',
        text,
        images: [],
        selection: false,
        modelContext: true,
      }),
    { providerId, text, model },
  );
}
async function status(page: Page, id: string, expected: string) {
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(
          (id) => ({
            task: window.brickloopEditorTest.tasks().find((task) => task.taskId === id),
            turn: window.brickloopEditorTest.aiState().turns.find((turn) => turn.id === id),
          }),
          id,
        );
        if (state.task?.status === 'failed' && expected !== 'failed')
          throw new Error(
            `Unexpected failed task: ${JSON.stringify({ task: state.task, report: state.turn?.report, result: state.turn?.result })}`,
          );
        return state.task?.status;
      },
      { timeout: 60000 },
    )
    .toBe(expected);
}
async function shot(page: Page, name: string) {
  await page.mouse.move(16, 16);
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity,
        ).length === 0,
  );
  await page.screenshot({ path: path.join(evidence, `${name}.png`), animations: 'disabled', scale: 'css' });
}
async function recompute(page: Page, marks = context.emptyContextMarks()) {
  const state = await page.evaluate(async () => ({
    summary: await window.brickloopEditorTest.modelSummary(),
    turns: window.brickloopEditorTest.aiState().turns,
    tasks: window.brickloopEditorTest.tasks(),
    documentId: window.brickloopEditorTest.snapshot().document.documentId,
  }));
  const result = state.summary as ToolResult;
  expect(result.ok).toBe(true);
  const estimate = context.estimateContext({
    summary: result.ok ? result.data : {},
    modelContext: true,
    history: context.contextHistory(
      state.turns.filter((turn) => turn.documentId === state.documentId),
      marks,
      Object.fromEntries(state.tasks.map((task) => [task.taskId, task])),
    ),
    capabilities,
  });
  await expect(page.getByTestId('ai-context-bar')).toHaveAttribute('data-tokens', String(estimate.tokens), {
    timeout: 30000,
  });
  return estimate.tokens;
}
async function save(app: ElectronApplication, page: Page, file: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
  await page.evaluate(() => window.brickloopEditorTest.save(true));
  return unzipSync(await readFile(file));
}

test('CTX-03/04/05: failed chat exclusion, next-request usage, clear and reopen', async () => {
  test.setTimeout(240000);
  await mkdir(evidence, { recursive: true });
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/context-'));
  const model = await fakeModel();
  let app: ElectronApplication | undefined;
  try {
    let page: Page;
    ({ app, page } = await launch(directory));

    const providerId = await configure(page, model.endpoint);
    const initial = await recompute(page);
    expect(initial).toBeGreaterThan(0);
    await expect(page.getByTestId('ai-context-bar')).toContainText('上限未知 · 0 轮');
    await expect(page.getByTestId('ai-context-bar').getByRole('progressbar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '新对话', exact: true })).toBeDisabled();
    const a = await start(page, providerId, 'CTX-A 成功的要求');
    await status(page, a, 'merged');
    const afterA = await recompute(page);
    expect(afterA).toBeGreaterThan(initial);
    await expect(page.getByTestId('ai-context-bar')).toContainText('1 轮');
    await shot(page, '01-usage');

    model.route(
      'CTX-B',
      Array.from({ length: 11 }, () => ({ status: 500 })),
    );
    const b = await start(page, providerId, 'CTX-B 失败的要求');
    await status(page, b, 'failed');
    const failed = page.locator(`[data-task-id="${b}"] .ai-context-excluded`);
    await expect(failed).toHaveText('未计入上下文');
    await failed.hover();
    await expect(page.getByRole('tooltip', { name: '失败的回合不计入之后的对话', exact: true })).toBeVisible();
    await shot(page, '02-excluded');
    expect(await recompute(page)).toBe(afterA);
    await page.locator('.ai-panel .ant-alert-close-icon').click();

    model.route('CTX-C', [{ text: '第三轮完成', gate: 'context-running' }]);
    const c = await start(page, providerId, 'CTX-C 继续');
    await expect.poll(() => model.waiting('context-running')).toBe(true);
    expect(JSON.stringify(model.requests.at(-1))).toContain('CTX-A');
    expect(JSON.stringify(model.requests.at(-1))).not.toContain('CTX-B');
    await expect(page.getByRole('button', { name: '新对话', exact: true })).toBeDisabled();
    model.release('context-running');
    await status(page, c, 'merged');
    expect(await recompute(page)).toBeGreaterThan(afterA);

    const file = path.join(directory, 'context.brkl');
    await save(app, page, file);
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().state.dirty)).toBe(false);
    const before = await page.evaluate(() => ({
      history: window.brickloopEditorTest.snapshot().history,
      doc: window.brickloopEditorTest.normalized(),
      review: window.brickloopEditorTest.review(),
    }));
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('模型、审阅和撤销记录都不会改变');
    await expect(page.getByRole('dialog')).toContainText('保存工程后，重新打开仍然有效');
    await shot(page, '03-new-chat-confirm');
    await page.getByRole('button', { name: '开始新对话', exact: true }).click();
    expect(
      await page.evaluate(() => ({
        history: window.brickloopEditorTest.snapshot().history,
        doc: window.brickloopEditorTest.normalized(),
        review: window.brickloopEditorTest.review(),
      })),
    ).toEqual(before);
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().state.dirty)).toBe(true);
    await expect(page.locator('.ai-context-previous summary')).toHaveText('之前的对话 · 3 轮 · 未计入上下文');
    await expect(page.locator('.ai-context-previous')).not.toHaveAttribute('open');
    await expect(page.getByTestId('ai-context-bar')).toContainText('0 轮');
    await expect(page.getByTestId('ai-context-bar')).toHaveAttribute('data-tokens', String(initial));
    await shot(page, '04-previous-conversations');
    await page.locator('.ai-context-previous summary').click();
    await expect(page.locator('.ai-context-cleared')).toHaveCSS('opacity', '0.6');
    await expect(page.locator(`[data-task-id="${a}"]`)).toBeVisible();
    await page.locator('.ai-context-previous summary').click();
    const d = await start(page, providerId, 'CTX-D 新的要求');
    await status(page, d, 'merged');
    for (const old of ['CTX-A', 'CTX-B', 'CTX-C']) expect(JSON.stringify(model.requests.at(-1))).not.toContain(old);
    const archive = await save(app, page, file);
    const parsed = context.parseContextMarks(new TextDecoder().decode(archive['ai/context.json']));
    expect(parsed.warning).toBe(false);
    expect(parsed.marks.clearedTurnIds).toEqual([a, b, c]);
    expect(parsed.marks.clearedAt).toBeDefined();
    expect(await recompute(page, parsed.marks)).toBeGreaterThan(initial);
    await stop(app);
    app = undefined;
    ({ app, page } = await launch(directory));
    await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
    await page.evaluate(() => window.brickloopEditorTest.action('ai.open'));
    await expect(page.locator('.ai-context-previous summary')).toContainText('3 轮');
    await recompute(page, parsed.marks);
    const e = await start(page, providerId, 'CTX-E 重开后的要求');
    await status(page, e, 'merged');
    const sent = JSON.stringify(model.requests.at(-1));
    expect(sent).toContain('CTX-D');
    for (const old of ['CTX-A', 'CTX-B', 'CTX-C']) expect(sent).not.toContain(old);

    // History saving off still records the clear marker for the in-memory rounds.
    await page.evaluate(async () => {
      const state = await window.brickloop.aiSnapshot();
      await window.brickloop.aiSaveSettings({ ...state.settings, history: false });
    });
    const unsaved = await start(page, providerId, 'CTX-UNSAVED 不保存记录');
    await status(page, unsaved, 'merged');
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByRole('button', { name: '开始新对话', exact: true }).click();
    const noHistory = await save(app, page, file);
    expect(new TextDecoder().decode(noHistory['ai/history.jsonl'])).not.toContain('CTX-UNSAVED');
    expect(
      context.parseContextMarks(new TextDecoder().decode(noHistory['ai/context.json'])).marks.clearedTurnIds,
    ).toContain(unsaved);
  } finally {
    if (app) await stop(app);
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CTX-05: image outcomes are text-only; discarded merge conflicts stay excluded', async () => {
  test.setTimeout(240000);
  await mkdir(evidence, { recursive: true });
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/context-image-'));
  const model = await fakeModel(),
    images = await imageModelServer();
  let app: ElectronApplication | undefined;
  try {
    const running = await launch(directory);
    app = running.app;
    const page = running.page;
    const chatProvider = await configure(page, model.endpoint);
    const imageProvider = randomUUID();
    await page.evaluate(
      async ({ id, endpoint }) => {
        await window.brickloop.aiSaveProvider(
          {
            id,
            type: 'compatible',
            presetId: 'custom',
            name: '看图离线验收',
            endpoint,
            model: 'offline-model',
            models: ['offline-model'],
            proxy: 'system',
            proxyUrl: '',
          },
          'offline-image-key',
        );
      },
      { id: imageProvider, endpoint: images.endpoint },
    );
    const reference: ImageBlock = {
      type: 'image',
      mime: 'image/png',
      base64: await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const drawing = canvas.getContext('2d')!;
        drawing.fillStyle = '#ffffff';
        drawing.fillRect(0, 0, 64, 64);
        drawing.fillStyle = '#c91a09';
        drawing.fillRect(16, 16, 32, 40);
        return canvas.toDataURL('image/png').split(',')[1]!;
      }),
    };
    const imageStart = (description: string) =>
      page.evaluate(
        ({ id, description, reference }) =>
          window.brickloop.aiStartImage({
            providerId: id,
            model: 'offline-model',
            directStart: true,
            input: {
              description,
              images: [{ name: 'reference.png', image: reference, view: 'front' }],
              viewMode: 'fixed',
              priority: 'buildable',
              targetSize: 'small',
              palette: { source: 'factory' },
              parts: { source: 'factory' },
              style: '',
            },
            budget: { rounds: 2, toolCalls: 40, durationMs: 120000 },
          }),
        { id: imageProvider, description, reference },
      );
    images.controls.status = 400;
    images.controls.statusOnBuild = true;
    const failed = await imageStart('CTX-IMAGE-FAILED 失败的看图设计');
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) => window.brickloopEditorTest.aiState().turns.find((t) => t.id === id)?.report?.reason,
            failed,
          ),
        { timeout: 60000 },
      )
      .toBe('error');
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
    expect(images.requests.length).toBeGreaterThan(0);
    expect(
      images.requests.some((request) => JSON.stringify(request.messages).includes('Script workflow round: 1')),
    ).toBe(true);
    await expect(page.locator(`[data-task-id="${failed}"] .ai-context-excluded`)).toHaveText('未计入上下文');
    const afterFailed = await start(page, chatProvider, 'CTX-AFTER-IMAGE-FAIL');
    await status(page, afterFailed, 'merged');
    expect(JSON.stringify(model.requests.at(-1))).not.toContain('CTX-IMAGE-FAILED');
    images.controls.status = 0;
    const success = await imageStart('CTX-IMAGE-SUCCESS 红顶小房子');
    await status(page, success, 'merged');
    const report = await page.evaluate(
      (id) => window.brickloopEditorTest.aiState().turns.find((t) => t.id === id)?.report,
      success,
    );
    expect(report?.transaction).toBe('committed');
    const afterImage = await start(page, chatProvider, 'CTX-AFTER-IMAGE-SUCCESS');
    await status(page, afterImage, 'merged');
    const sent = JSON.stringify(model.requests.at(-1));
    expect(sent).toContain('CTX-IMAGE-SUCCESS');
    expect(sent).toContain(JSON.stringify(report!.summaryZh).slice(1, -1));
    expect(sent).toContain('参考图 1 张，未附上');
    expect(sent).not.toContain('image_url');
    expect(sent).not.toContain(reference.base64);

    const target = await page.evaluate(() => {
      const api = window.brickloopEditorTest;
      if (
        !api.command({
          type: 'part.add',
          partId: 'ld:3001',
          colorId: 'c:bright-red',
          transform: [1000, -24, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        })
      )
        throw new Error('Conflict fixture was not added');
      return api.expanded().find((row) => row.path.length === 1)!.path;
    });
    model.frames.push(
      {
        calls: [
          { name: 'move', arguments: { instanceIds: [target.at(-1)], delta: { x_ldu: 100, y_ldu: 0, z_ldu: 0 } } },
        ],
      },
      { text: '移动完成', gate: 'discard' },
    );
    const discarded = await start(page, chatProvider, 'CTX-DISCARD 将被放弃的要求');
    await expect.poll(() => model.waiting('discard')).toBe(true);
    expect(
      await page.evaluate(
        (id) =>
          window.brickloopEditorTest
            .aiState()
            .turns.find((turn) => turn.id === id)
            ?.events.find((event) => event.type === 'tool_result' && event.call.name === 'move'),
        discarded,
      ),
    ).toMatchObject({ result: { ok: true } });
    const edited = await page.evaluate((target) => {
      const api = window.brickloopEditorTest;
      api.select([target]);
      return api.command({ type: 'transform.translate', delta: [20, 0, 0] });
    }, target);
    expect(edited).toBe(true);
    model.release('discard');
    await status(page, discarded, 'pending_merge');
    expect(
      await page.evaluate(
        (id) => window.brickloopEditorTest.tasks().find((t) => t.taskId === id)?.summary?.conflicts,
        discarded,
      ),
    ).toBeGreaterThan(0);
    await page.evaluate((id) => window.brickloopEditorTest.taskDiscard(id), discarded);
    await status(page, discarded, 'discarded');
    const archive = await save(app, page, path.join(directory, 'discard.brkl'));
    expect(
      context.parseContextMarks(new TextDecoder().decode(archive['ai/context.json'])).marks.discardedTurnIds,
    ).toContain(discarded);
    const next = await start(page, chatProvider, 'CTX-AFTER-DISCARD');
    await status(page, next, 'merged');
    expect(JSON.stringify(model.requests.at(-1))).not.toContain('CTX-DISCARD');
  } finally {
    if (app) await stop(app);
    await model.close();
    await images.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CTX-04: 10,000 parts, 30 edits in 60 seconds, bounded background analysis', async () => {
  test.setTimeout(1500000);
  const maxLaunches = 10;
  // One of 13 normal runs had a 32.8 ms typing p95; the other 12 were 17.1–17.6 ms.
  // This bounds tolerance for occasional noise. A regression exceeding the unchanged
  // 20 ms limit on all three normal measurements still fails.
  const maxNormalFailures = 3;
  await mkdir(evidence, { recursive: true });
  await mkdir(path.join(root, '.devdata/tmp'), { recursive: true });
  let directory: string | undefined;
  const model = await fakeModel();
  let app: ElectronApplication | undefined;
  type Calibration = Awaited<ReturnType<typeof calibrate>>;
  type Attempt = {
    attempt: number;
    beforeSeed: Calibration;
    afterSeed: Calibration | null;
    afterRun: Calibration | null;
    editingMs: number | null;
    slow: boolean;
    decision: ReturnType<typeof decide>;
    reason: 'slow' | 'normal' | null;
  };
  const calibration: {
    attempts: Attempt[];
    slowAttempts: number;
    launches: number;
    normalFailures: number;
  } = { attempts: [], slowAttempts: 0, launches: 0, normalFailures: 0 };
  let lastPerformance: object = {};
  const typingFrameP95Samples: (number | undefined)[] = [];
  try {
    for (let attempt = 1; attempt <= maxLaunches; attempt++) {
      if (attempt > 1) await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      directory = await mkdtemp(path.join(root, '.devdata/tmp/context-perf-'));
      calibration.launches = attempt;
      let result: Attempt | undefined;
      let measured = false;
      try {
        let page: Page;
        ({ app, page } = await launch(directory));
        await page.evaluate(() => window.brickloopEditorTest.structure());
        result = {
          attempt,
          beforeSeed: await calibrate(page),
          afterSeed: null,
          afterRun: null,
          editingMs: null,
          slow: false,
          decision: 'fail',
          reason: null,
        };
        calibration.attempts.push(result);
        // Cheap rejection first; the final launch always gets a full measurement.
        if (result.beforeSeed.slow && attempt < maxLaunches) {
          result.decision = 'retry';
          continue;
        }
        await page.evaluate(() => window.brickloopEditorTest.seed(10000));
        await page.evaluate(() => window.brickloopEditorTest.assemblyReady());
        result.afterSeed = await calibrate(page);
        if (result.afterSeed.slow && attempt < maxLaunches) {
          result.decision = 'retry';
          continue;
        }
        // No context Worker should start while the panel is hidden.
        const workers: string[] = [];
        page.on('worker', (worker) => {
          void worker
            .evaluate(() => self.name)
            .then((name) => workers.push(name))
            .catch(() => undefined);
        });
        await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 2300)));
        expect(workers.filter((name) => /ai-(?:context|check)\.worker/.test(name))).toEqual([]);
        await configure(page, model.endpoint);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());
        await expect(page.getByTestId('ai-context-bar')).toHaveAttribute('data-tokens', /\d+/, { timeout: 60000 });
        await expect(page.getByTestId('ai-context-bar')).toHaveAttribute('data-analysis-count', '1');
        const input = page.getByRole('textbox', { name: '给 AI 助手的消息' });
        const focusStarted = Date.now();
        await input.focus();
        const focusMs = Date.now() - focusStarted;
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );
        const frames = await page.evaluateHandle(() => {
          const result = {
            frames: [] as number[],
            longTasks: [] as number[],
            stop: false,
            disconnect: (): void => undefined,
          };
          const observer = new PerformanceObserver((list) => {
            result.longTasks.push(...list.getEntries().map((entry) => entry.duration));
          });
          observer.observe({ entryTypes: ['longtask'] });
          result.disconnect = () => observer.disconnect();
          let previous = performance.now();
          const frame = (now: number) => {
            result.frames.push(now - previous);
            previous = now;
            if (!result.stop) requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
          return result;
        });
        const editingStarted = Date.now();
        const typingSamples: number[] = [];
        for (let edit = 0; edit < 30; edit++) {
          await page.evaluate((edit) => {
            if (
              !window.brickloopEditorTest.command({
                type: 'part.add',
                partId: 'ld:3001',
                colorId: 'c:bright-red',
                transform: [20000 + edit * 100, -24, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
              })
            )
              throw new Error('Performance edit failed');
          }, edit);
          // Measure typing frames after the edit itself has been rendered.
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
          );
          const before = await frames.evaluate((result) => result.frames.length);
          await input.pressSequentially('context ', { delay: 25 });
          typingSamples.push(...(await frames.evaluate((result, before) => result.frames.slice(before), before)));
          await page.waitForTimeout(Math.max(0, editingStarted + (edit + 1) * 2000 - Date.now()));
        }
        result.editingMs = Date.now() - editingStarted;
        const typingFrames = typingSamples;
        const typingLongTasks = await frames.evaluate((result) => result.longTasks.slice());
        await expect(page.getByTestId('ai-context-bar')).toHaveAttribute('data-tokens', /\d+/, { timeout: 60000 });
        const timings = await page.getByTestId('ai-context-bar').evaluate((bar) => ({
          calculationMs: Number((bar as HTMLElement).dataset.calculationMs),
          totalMs: Number((bar as HTMLElement).dataset.totalMs),
          analysisCount: Number((bar as HTMLElement).dataset.analysisCount),
          analysisMs: Number((bar as HTMLElement).dataset.analysisMs),
        }));
        const durations = await frames.evaluate((result) => {
          result.stop = true;
          result.disconnect();
          return result.frames;
        });
        await frames.dispose();
        const sorted = durations.slice(2).sort((a, b) => a - b);
        const performanceResult = {
          parts: 10000,
          edits: 30,
          editingMs: result.editingMs,
          ...timings,
          frameP95Ms: sorted[Math.floor(sorted.length * 0.95)],
          maxFrameMs: Math.max(...sorted),
          typingFrameP95Ms: typingFrames.slice().sort((a, b) => a - b)[Math.floor(typingFrames.length * 0.95)],
          typingMaxFrameMs: Math.max(...typingFrames),
          focusMs,
          typingLongTasks,
          calibration,
        };
        lastPerformance = performanceResult;
        typingFrameP95Samples.push(performanceResult.typingFrameP95Ms);
        measured = true;
        // Stop collecting frames before calibration so its work is not part of the measured run.
        result.afterRun = await calibrate(page);
        result.slow = classifyAttempt(result);
        // Counts are independent of machine speed: never retry either of these failures.
        expect(performanceResult.analysisCount).toBeLessThanOrEqual(3);
        expect(model.requests).toHaveLength(0);
        const passed = performanceResult.typingFrameP95Ms !== undefined && performanceResult.typingFrameP95Ms <= 20;
        if (!passed && !result.slow) calibration.normalFailures++;
        result.decision = decide({
          passed,
          slow: result.slow,
          launches: attempt,
          maxLaunches,
          normalFailures: calibration.normalFailures,
          maxNormalFailures,
        });
        if (result.decision === 'retry') continue;
        if (result.decision === 'fail') {
          throw new Error(
            result.slow
              ? '每次启动都处于慢速状态，见校准数据'
              : calibration.normalFailures >= maxNormalFailures
                ? `CTX-04 性能在正常机器状态下连续 3 次未达标：${JSON.stringify(typingFrameP95Samples)}`
                : `CTX-04 已达到 ${maxLaunches} 次启动上限，正常机器状态下 ${calibration.normalFailures} 次未达标：${JSON.stringify(typingFrameP95Samples)}`,
          );
        }
        expect(performanceResult.analysisCount).toBeLessThanOrEqual(3);
        expect(performanceResult.typingFrameP95Ms).toBeLessThanOrEqual(20);
        expect(model.requests).toHaveLength(0);
        await shot(page, '05-ten-thousand-parts');
        return;
      } catch (error) {
        if (result) result.decision = 'fail';
        throw error;
      } finally {
        if (result) {
          result.slow = classifyAttempt(result);
          result.reason = result.slow ? 'slow' : result.decision === 'retry' ? 'normal' : null;
          if (result.slow) calibration.slowAttempts++;
          console.log('CTX-04 attempt:', JSON.stringify(result));
          await writeFile(
            path.join(evidence, 'performance.json'),
            JSON.stringify({ ...lastPerformance, calibration }, null, 2),
          );
          if (measured) console.log('CTX-04 performance:', JSON.stringify(lastPerformance));
        }
        if (app) {
          await stop(app);
          app = undefined;
        }
        if (directory) {
          await rm(directory, { recursive: true, force: true });
          directory = undefined;
        }
      }
    }
  } catch (error) {
    console.error('CTX-04 calibration on failure:', JSON.stringify(calibration));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nCTX-04 calibration: ${JSON.stringify(calibration)}`,
      {
        cause: error,
      },
    );
  } finally {
    if (app) await stop(app);
    await model.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

for (const presetId of ['deepseek', 'custom']) {
  test(`AI-10 / CTX-04: ${presetId} reasoning replay and output ceiling`, async () => {
    test.setTimeout(120000);
    await mkdir(evidence, { recursive: true });
    await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
    const directory = await mkdtemp(path.join(root, '.devdata/e2e/context-reasoning-'));
    const server = await fakeModel();
    let app: ElectronApplication | undefined;
    try {
      const running = await launch(directory);
      app = running.app;
      const page = running.page;
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());

      const provider = await configure(page, server.endpoint, presetId, 'deepseek-flash');
      server.frames.push(
        {
          ...(presetId === 'deepseek' ? { reasoning: 'Reasoning from the first streamed response.' } : {}),
          calls: [{ name: 'get_model_summary', arguments: {} }],
        },
        { ...(presetId === 'deepseek' ? { reasoning: 'Reasoning for the final answer.' } : {}), text: '检查完成。' },
        { ...(presetId === 'deepseek' ? { reasoning: 'Reasoning in the second turn.' } : {}), text: '第二轮完成。' },
      );
      const first = await start(page, provider, 'REPLAY-FIRST 请检查模型', 'deepseek-flash');
      await status(page, first, 'merged');
      const second = await start(page, provider, 'REPLAY-SECOND 继续说明', 'deepseek-flash');
      await status(page, second, 'merged');
      type Request = {
        max_tokens?: number;
        messages: { role: string; content: unknown; reasoning_content?: string }[];
      };
      const requests = server.requests as Request[];
      expect(requests).toHaveLength(3);
      for (const request of requests) {
        if (presetId === 'deepseek') {
          expect(request.max_tokens).toBe(256000);
          for (const message of request.messages.filter((m) => m.role === 'assistant'))
            expect(message.reasoning_content).toBeTruthy();
        } else {
          expect(request).not.toHaveProperty('max_tokens');
          for (const message of request.messages) expect(message).not.toHaveProperty('reasoning_content');
        }
      }
      const bar = page.getByTestId('ai-context-bar');
      if (presetId === 'deepseek') {
        expect(requests[1]!.messages.find((m) => m.role === 'assistant')?.reasoning_content).toBe(
          'Reasoning from the first streamed response.',
        );
        expect(JSON.stringify(requests[2]!.messages)).toContain('[较早上下文摘要]');
        expect(JSON.stringify(requests[2]!.messages)).toContain('REPLAY-FIRST');
        await expect(bar).toContainText('/ 1M');
        await expect(bar).toContainText('% · 2 轮');
        await expect(bar.getByRole('progressbar')).toHaveCount(1);
        await expect(bar.locator('.ai-context-compression')).toHaveCount(0);
        await bar.locator('.ai-context-usage').hover();
        await expect(page.getByRole('tooltip')).toContainText('该服务商要求回传思考内容，之前的回合以摘要形式发送。');
        await expect(page.getByRole('tooltip')).toContainText('接近上限（约预留 15%）时会自动压缩较早内容');
        await expect(page.getByRole('tooltip')).not.toContainText('60%');
        const turns = await page.evaluate(() => window.brickloopEditorTest.aiState().turns);
        expect(turns.every((turn) => !turn.compressed)).toBe(true);
        const archive = await save(app, page, path.join(directory, 'reasoning.brkl'));
        expect(new TextDecoder().decode(archive['ai/history.jsonl'])).not.toContain('"compressed"');
      } else {
        await expect(bar).toContainText('上限未知');
        await expect(bar.getByRole('progressbar')).toHaveCount(0);
      }
    } finally {
      if (app) await stop(app);
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('M12-4: HTTP context overflow compresses earlier content and retries successfully', async () => {
  test.setTimeout(120000);
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/context-overflow-'));
  const server = await fakeModel();
  let app: ElectronApplication | undefined;
  try {
    const running = await launch(directory);
    app = running.app;
    const page = running.page;
    const provider = await configure(page, server.endpoint);
    const oldText = 'EARLIER-RAW-ANSWER '.repeat(6000);
    server.frames.push(
      { text: oldText },
      { status: 400, errorMessage: "This model's maximum context length is 65536 tokens..." },
      { text: '压缩后继续成功。' },
    );
    server.route('请为接手此 Brickloop', [{ text: SUMMARY_TEMPLATE }]);
    await status(page, await start(page, provider, '保留这段早先要求'), 'merged');
    const id = await start(page, provider, 'CURRENT-OVERFLOW-REQUEST');
    await status(page, id, 'merged');
    expect(server.requests).toHaveLength(4);
    const rejected = JSON.stringify(server.requests[1]);
    const retry = JSON.stringify(server.requests[3]);
    expect(rejected).toContain('EARLIER-RAW-ANSWER');
    expect(retry).not.toContain('EARLIER-RAW-ANSWER');
    expect(retry).toContain('[较早上下文摘要]');
    expect(retry).toContain('CURRENT-OVERFLOW-REQUEST');
    expect(retry.length).toBeLessThan(rejected.length * 0.7);
    const turn = await page.evaluate((id) => window.brickloopEditorTest.aiState().turns.find((t) => t.id === id), id);
    expect(turn?.result?.reason).toBe('completed');
    expect(turn?.result).not.toHaveProperty('error');
    expect(turn?.compressed).toBeDefined();
    expect(JSON.stringify(turn?.history ?? turn?.result?.history)).toContain('EARLIER-RAW-ANSWER');
    await expect(page.locator('[data-task-id="' + id + '"] .ai-failure')).toHaveCount(0);
    await expect(page.getByTestId('ai-context-bar')).toContainText('已压缩');
    await expect(page.getByTestId('ai-context-bar')).toContainText('上限未知');
    await page.locator('.ai-context-usage').hover();
    await expect(page.getByRole('tooltip')).toContainText('服务商提示过长时会自动压缩');
  } finally {
    if (app) await stop(app);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M12-4: default chat completes 100 consecutive tool calls without a budget summary', async () => {
  test.setTimeout(180000);
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/unlimited-tools-'));
  const server = await fakeModel();
  let app: ElectronApplication | undefined;
  try {
    const running = await launch(directory);
    app = running.app;
    const page = running.page;
    const provider = await configure(page, server.endpoint);
    expect((await page.evaluate(() => window.brickloop.aiSnapshot())).settings).toMatchObject({
      toolLimit: null,
      durationMinutes: null,
    });
    server.frames.push(
      ...Array.from({ length: 100 }, () => ({
        calls: [{ name: 'get_model_summary', arguments: {} }],
      })),
      { text: '100 次操作已完成。' },
    );
    const id = await start(page, provider, '连续检查 100 次后汇总');
    await status(page, id, 'merged');
    const turn = await page.evaluate((id) => window.brickloopEditorTest.aiState().turns.find((t) => t.id === id), id);
    expect(turn?.result).toMatchObject({ reason: 'completed', toolCalls: 100, text: '100 次操作已完成。' });
    expect(turn?.events.filter((event) => event.type === 'tool_result')).toHaveLength(100);
    expect(server.requests).toHaveLength(101);
    expect(JSON.stringify(server.requests)).not.toContain('tool-call budget has been exhausted');
  } finally {
    if (app) await stop(app);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M12-18: a long conversation persists its checkpoint, reuses the prefix after reopening, and clears it', async () => {
  test.setTimeout(180000);
  await mkdir(path.join(root, '.devdata/tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/tmp/m12-18-checkpoint-'));
  const server = await fakeModel();
  let app: ElectronApplication | undefined;
  try {
    let page: Page;
    ({ app, page } = await launch(directory));
    const provider = await configure(page, server.endpoint);
    const oldAnswer = 'OLD-VERBATIM-COMPONENT-DETAIL '.repeat(5000);
    const summary = SUMMARY_TEMPLATE.replace(
      '用户要完成什么；必须遵守的范围、限制和优先级。',
      'CHECKPOINT-ROOF：按 1:50 比例搭建，保留蓝色屋顶。',
    );
    server.route('请为接手此 Brickloop', [{ text: summary, inputTokens: 1234 }]);
    server.frames.push(
      { text: oldAnswer },
      { text: 'RECENT-ANSWER-VERBATIM' },
      { status: 400, errorMessage: 'context_length_exceeded' },
      { text: '继续搭建。' },
    );
    const old = await start(page, provider, 'OLD-GOAL 蓝色屋顶');
    await status(page, old, 'merged');
    const recent = await start(page, provider, 'RECENT-REQUEST-VERBATIM');
    await status(page, recent, 'merged');
    const compacted = await start(page, provider, 'COMPACT-NOW');
    await status(page, compacted, 'merged');
    type Request = { messages: { role: string; content: unknown }[]; tools?: unknown[] };
    const requests = server.requests as Request[];
    expect(requests).toHaveLength(5);
    const rejected = JSON.stringify(requests[2]!.messages);
    const retry = requests[4]!;
    expect(rejected).toContain('OLD-VERBATIM-COMPONENT-DETAIL');
    expect(JSON.stringify(retry.messages)).not.toContain('OLD-VERBATIM-COMPONENT-DETAIL');
    const checkpoint = retry.messages.find((message) => JSON.stringify(message.content).includes('CHECKPOINT-ROOF'))!;
    expect(checkpoint.role).toBe('user');
    expect(retry.messages.findIndex((message) => message === checkpoint)).toBe(1); // system, then checkpoint
    expect(JSON.stringify(retry.messages)).toContain('RECENT-REQUEST-VERBATIM');
    expect(JSON.stringify(retry.messages)).toContain('RECENT-ANSWER-VERBATIM');
    expect(JSON.stringify(requests[3])).toContain('严格使用下面全部六个标题');
    expect(requests[3]!.tools ?? []).toHaveLength(0);
    const compactedTurn = await page.evaluate(
      (id) => window.brickloopEditorTest.aiState().turns.find((turn) => turn.id === id),
      compacted,
    );
    const result = compactedTurn?.result;
    expect(result?.usage.inputTokens).toBe(1734);
    const file = path.join(directory, 'checkpoint.brkl');
    const archive = await save(app, page, file);
    const marks = context.parseContextMarks(new TextDecoder().decode(archive['ai/context.json'])).marks;
    expect(marks.checkpoint).toMatchObject({
      throughTurnId: old,
      coveredTurnIds: [old],
      throughMessage: 2,
    });
    expect(marks.checkpoint?.summary).toContain('CHECKPOINT-ROOF');
    expect(marks.checkpoint?.createdAt).toBeTruthy();
    expect(new TextDecoder().decode(archive['ai/history.jsonl'])).toContain('OLD-VERBATIM-COMPONENT-DETAIL');

    await status(page, await start(page, provider, 'AFTER-CHECKPOINT'), 'merged');
    expect((server.requests.at(-1) as Request).messages.slice(0, 2)).toEqual(retry.messages.slice(0, 2));
    expect(server.requests).toHaveLength(6);
    await save(app, page, file);
    await stop(app);
    app = undefined;
    ({ app, page } = await launch(directory));
    await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
    await page.evaluate(() => window.brickloopEditorTest.action('ai.open'));
    await status(page, await start(page, provider, 'AFTER-REOPEN'), 'merged');
    expect((server.requests.at(-1) as Request).messages.slice(0, 2)).toEqual(retry.messages.slice(0, 2));
    expect(server.requests).toHaveLength(7);
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByRole('button', { name: '开始新对话', exact: true }).click();
    const cleared = await save(app, page, file);
    expect(context.parseContextMarks(new TextDecoder().decode(cleared['ai/context.json'])).marks).not.toHaveProperty(
      'checkpoint',
    );
    await status(page, await start(page, provider, 'AFTER-CLEAR'), 'merged');
    expect(JSON.stringify(server.requests.at(-1))).not.toContain('CHECKPOINT-ROOF');
    expect(JSON.stringify(server.requests.at(-1))).not.toContain('RECENT-REQUEST-VERBATIM');
    // Keep a small, machine-readable comparison alongside the ordinary e2e report.
    await writeFile(
      path.join(root, '.devdata/tmp/m12-18-compaction-evidence.json'),
      JSON.stringify(
        {
          rejectedBytes: Buffer.byteLength(JSON.stringify(requests[2])),
          retryBytes: Buffer.byteLength(JSON.stringify(retry)),
          estimatedTokensBefore: estimateInputTokens(
            String(requests[2]!.messages[0]!.content),
            result!.history.slice(0, -1),
            createEditorTools(),
          ),
          estimatedTokensAfter: compactedTurn?.compressed?.estimatedTokens,
          checkpoint: marks.checkpoint,
          stablePrefixAfterReopen: true,
        },
        null,
        2,
      ),
    );
  } finally {
    if (app) await stop(app);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('M12-18: failed retained edits are summarized, labelled and restored after reopening', async () => {
  test.setTimeout(150000);
  await mkdir(path.join(root, '.devdata/tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/tmp/m12-18-failed-'));
  const server = await fakeModel();
  let app: ElectronApplication | undefined;
  try {
    let page: Page;
    ({ app, page } = await launch(directory));
    const provider = await configure(page, server.endpoint);
    server.frames.push(
      {
        calls: [
          {
            name: 'place_part',
            arguments: { partId: 'ld:3001', colorId: 'c:bright-red', pose: { kind: 'grid', x: 0, level: 3, z: 0 } },
          },
        ],
      },
      { status: 402, errorMessage: 'Insufficient balance', errorCode: 'insufficient_balance' },
    );
    const failed = await start(page, provider, 'RETAINED-FAILURE 放置一块红砖');
    await status(page, failed, 'merged');
    await expect(page.locator(`[data-task-id="${failed}"] .ai-context-summarized`)).toHaveText('已以摘要计入');
    await expect(page.locator(`[data-task-id="${failed}"] .ai-context-excluded`)).toHaveCount(0);
    const turn = await page.evaluate(
      (id) => window.brickloopEditorTest.aiState().turns.find((turn) => turn.id === id),
      failed,
    );
    expect(turn?.result?.reason).toBe('error');
    expect(turn?.context?.retainedEdits).toMatchObject({ added: 1, modified: 0, deleted: 0 });
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(1);
    await status(page, await start(page, provider, 'AFTER-RETAINED-FAILURE'), 'merged');
    const request = JSON.stringify(server.requests.at(-1));
    expect(request).toContain('[失败回合摘要（已保留修改）]');
    expect(request).toContain('RETAINED-FAILURE 放置一块红砖');
    expect(request).toContain('quota_exceeded');
    expect(request).toContain('insufficient_balance');
    expect(request).toContain('added');
    expect(request).not.toContain('tool_call_id');
    expect(request).not.toContain('image_url');
    const file = path.join(directory, 'retained.brkl');
    const archive = await save(app, page, file);
    expect(new TextDecoder().decode(archive['ai/history.jsonl'])).toContain('retainedEdits');
    expect(await page.evaluate(() => window.brickloopEditorTest.reviewUndo())).toBe(true);
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(0);
    await status(page, await start(page, provider, 'AFTER-UNDO-RETAINED'), 'merged');
    const afterUndo = (server.requests.at(-1) as { messages: { role: string; content: unknown }[] }).messages;
    expect(JSON.stringify(afterUndo.find((message) => message.role === 'system'))).toContain('\\"partCount\\":0');
    expect(JSON.stringify(afterUndo)).not.toContain('tool_call_id');
    await stop(app);
    app = undefined;
    ({ app, page } = await launch(directory));
    await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
    await page.evaluate(() => window.brickloopEditorTest.action('ai.open'));
    await expect(page.locator(`[data-task-id="${failed}"] .ai-context-summarized`)).toHaveText('已以摘要计入');
    await status(page, await start(page, provider, 'REOPEN-RETAINED'), 'merged');
    expect(JSON.stringify(server.requests.at(-1))).toContain('[失败回合摘要（已保留修改）]');
    expect(JSON.stringify(server.requests.at(-1))).not.toContain('tool_call_id');
  } finally {
    if (app) await stop(app);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
