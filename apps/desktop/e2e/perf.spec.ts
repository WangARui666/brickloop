// Results default to .devdata/perf-results. Set BRICKLOOP_PERF_OUTPUT to the
// absolute docs/perf/data path when intentionally updating the private report.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import type { ElectronApplication, Page } from '@playwright/test';
import { format, resolveConfig } from 'prettier';
import { unpackProject } from '../../../packages/io/src/project';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';
import { generateFixtures } from './fixtures/perf/generate';
import type { PerfFixture } from './fixtures/perf/generate';

declare global {
  interface Window {
    brickloopEditorTest: EditorTestApi;
  }
}
const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const desktop = path.join(root, 'apps/desktop');
const scratch = path.join(root, '.devdata/perf-fixtures');
const output = process.env.BRICKLOOP_PERF_OUTPUT ?? path.join(root, '.devdata/perf-results');
const phase = process.env.BRICKLOOP_PERF_PHASE === 'before' ? 'before' : 'round2';
async function writeData(name: string, value: unknown) {
  const file = path.join(output, name);
  await writeFile(file, await format(JSON.stringify(value), { ...(await resolveConfig(file)), parser: 'json' }));
}
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    meanMs: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
    p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
  };
};
async function memory(app: ElectronApplication) {
  return app.evaluate(({ app }) => {
    const processes = app.getAppMetrics().map((entry) => ({ type: entry.type, pid: entry.pid, ...entry.memory }));
    return {
      at: Date.now(),
      workingSetMB: processes.reduce((sum, p) => sum + p.workingSetSize, 0) / 1024,
      peakWorkingSetMB: processes.reduce((sum, p) => sum + p.peakWorkingSetSize, 0) / 1024,
      processes,
    };
  });
}
async function launch(directory: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron({
    args: [desktop],
    env: { ...env, BRICKLOOP_DATA_DIR: directory },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  // Native window occlusion can otherwise throttle rAF to 1 Hz during unattended runs.
  const throttling = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => {
      window.webContents.setBackgroundThrottling(false);
      return window.webContents.getBackgroundThrottling();
    }),
  );
  expect(throttling).toEqual([false]);
  const displaySleepBlocked = await app.evaluate(({ powerSaveBlocker }) =>
    powerSaveBlocker.isStarted(powerSaveBlocker.start('prevent-display-sleep')),
  );
  expect(displaySleepBlocked).toBe(true);
  await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true');
  await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
  return { app, page };
}
async function measurementWindow(app: ElectronApplication, active: boolean) {
  await app.evaluate(({ BrowserWindow }, active) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setAlwaysOnTop(active);
    if (active) {
      window.restore();
      window.show();
      window.focus();
      window.moveTop();
    }
  }, active);
}
async function closeProject(page: Page) {
  await page.evaluate(async () => {
    window.brickloopEditorTest.prepareClose();
    await window.brickloopEditorTest.flush();
    window.brickloopEditorTest.action('file.close');
  });
  await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', '0');
  await page.evaluate(() => window.brickloopEditorTest.flush());
  await page.evaluate(() => window.brickloopEditorTest.assemblyReady());
}
async function openProject(page: Page, fixture: PerfFixture) {
  return page.evaluate(async ({ file, count }) => {
    const surface = document.querySelector<HTMLElement>('.brickloop-viewport')!;
    const start = performance.now();
    const meshBefore = window.brickloopEditorTest.meshMetrics();
    const registrationBefore = window.brickloopEditorTest.metrics();
    let firstFrameMs = 0;
    const before = surface.dataset.renderCount;
    const observer = new MutationObserver((records) => {
      if (
        !firstFrameMs &&
        records.some((record) => record.attributeName === 'data-render-count') &&
        Number(surface.dataset.partCount) > 0 &&
        surface.dataset.renderCount !== before
      )
        firstFrameMs = performance.now() - start;
    });
    observer.observe(surface, { attributes: true });
    try {
      await window.brickloopEditorTest.open(file);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const interactiveMs = performance.now() - start;
      const initialPartCount = Number(surface.dataset.loadedPartCount);
      await window.brickloopEditorTest.meshesReady();
      let retries = 0;
      while (Number(surface.dataset.loadedPartCount) !== count && retries < 4) {
        retries++;
        await window.brickloopEditorTest.meshesReady();
      }
      await window.brickloopEditorTest.assemblyReady();
      window.brickloopEditorTest.action('view.fitAll');
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (Number(surface.dataset.loadedPartCount) !== count)
        throw new Error(`Incomplete geometry: ${surface.dataset.loadedPartCount}/${count}`);
      const meshAfter = window.brickloopEditorTest.meshMetrics();
      const registrationAfter = window.brickloopEditorTest.metrics();
      return {
        firstFrameMs,
        interactiveMs,
        fullyLoadedMs: performance.now() - start,
        initialPartCount,
        meshRetries: retries,
        meshPipeline: Object.fromEntries(
          Object.keys(meshAfter).map((key) => [
            key,
            meshAfter[key as keyof typeof meshAfter] - meshBefore[key as keyof typeof meshBefore],
          ]),
        ),
        meshRegistrationMs: registrationAfter.meshRegistrationMs - registrationBefore.meshRegistrationMs,
        geometryBvhMs: registrationAfter.geometryBvhMs - registrationBefore.geometryBvhMs,
      };
    } finally {
      observer.disconnect();
    }
  }, fixture);
}
async function rotate(page: Page) {
  const area = (await page.locator('.brickloop-viewport canvas').first().boundingBox())!;
  await page.mouse.move(area.x + area.width * 0.5, area.y + area.height * 0.5);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  try {
    return await page.evaluate(async ({ x, y, width, height }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('.brickloop-viewport canvas')!;
      const surface = canvas.parentElement!;
      const samples: {
        frameMs: number;
        cameraMs: number;
        renderMs: number;
        drawCalls: number;
        triangles: number;
        lines: number;
      }[] = [];
      let previous = performance.now();
      for (let i = 0; i < 150; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const now = performance.now();
        const metrics = window.brickloopEditorTest.metrics();
        if (i >= 30)
          samples.push({
            frameMs: now - previous,
            cameraMs: Number(surface.dataset.cameraUpdateMs),
            renderMs: metrics.renderMs,
            drawCalls: metrics.drawCalls,
            triangles: metrics.triangles,
            lines: metrics.lines,
          });
        previous = now;
        canvas.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerId: 1,
            pointerType: 'mouse',
            buttons: 1,
            button: -1,
            altKey: true,
            clientX: x + width / 2 + i * 1.5,
            clientY: y + height / 2,
          }),
        );
      }
      return samples;
    }, area);
  } finally {
    await page.mouse.up();
    await page.keyboard.up('Alt');
  }
}
async function moveSingle(page: Page) {
  const before = await page.evaluate(() => window.brickloopEditorTest.expanded()[0]!.matrix);
  await page.evaluate(() => {
    const api = window.brickloopEditorTest;
    api.select([api.expanded()[0]!.path]);
    api.preset('front');
    api.action('view.fitSelection');
  });
  await page.getByRole('button', { name: '移动', exact: true }).click();
  const handles = await page.evaluate(() => window.brickloopEditorTest.handles());
  const point = handles.find((p) => p.axis === 'X');
  if (!point) throw new Error('Move handle unavailable');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.snapshot().previewing)).toBe(true);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const startCounters = await cdp.send('Performance.getMetrics');
  const samples = await page.evaluate(async (point) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.brickloop-viewport canvas')!;
    const samples: { dispatchMs: number; syncMs: number; matrixWrites: number }[] = [];
    for (let frame = 0; frame < 60; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const start = performance.now();
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 1,
          pointerType: 'mouse',
          buttons: 1,
          button: -1,
          clientX: point.x + frame * 2,
          clientY: point.y,
        }),
      );
      const dispatchMs = performance.now() - start;
      const metrics = window.brickloopEditorTest.metrics();
      samples.push({ dispatchMs, syncMs: metrics.syncWorkMs ?? metrics.syncMs, matrixWrites: metrics.matrixWrites });
    }
    return samples;
  }, point);
  // Keep the historical whole-gesture counter below, and separately measure the
  // 60 preview frames: commit validation is intentionally deferred until pointer-up.
  const previewCounters = await cdp.send('Performance.getMetrics');
  const previewDelta = (name: string) =>
    1000 *
    ((previewCounters.metrics.find((entry) => entry.name === name)?.value ?? 0) -
      (startCounters.metrics.find((entry) => entry.name === name)?.value ?? 0));
  const previewThread = {
    frames: samples.length,
    scriptMsPerFrame: previewDelta('ScriptDuration') / samples.length,
    taskMsPerFrame: previewDelta('TaskDuration') / samples.length,
    elapsedMs: previewDelta('Timestamp'),
  };
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.snapshot().previewing)).toBe(false);
  const after = await page.evaluate(() => window.brickloopEditorTest.expanded()[0]!.matrix);
  expect(after).not.toEqual(before);
  const endCounters = await cdp.send('Performance.getMetrics');
  await cdp.detach();
  const delta = (name: string) =>
    1000 *
    ((endCounters.metrics.find((entry) => entry.name === name)?.value ?? 0) -
      (startCounters.metrics.find((entry) => entry.name === name)?.value ?? 0));
  const mainThread = {
    frames: samples.length,
    scriptMsPerFrame: delta('ScriptDuration') / samples.length,
    taskMsPerFrame: delta('TaskDuration') / samples.length,
    elapsedMs: delta('Timestamp'),
  };
  const assembly = await page.evaluate(() => window.brickloopEditorTest.assembly().timings);
  return {
    samples,
    before,
    after,
    mainThread,
    previewThread,
    dispatch: summary(samples.map((s) => s.dispatchMs)),
    projection: summary(samples.map((s) => s.syncMs)),
    assembly: summary(assembly.map((s) => s.snapMs + s.collisionMs)),
  };
}

test('PERF-01 cold/hot scenes and PERF-02 twenty open/close cycles', async () => {
  await mkdir(output, { recursive: true });
  const fixtures = await generateFixtures(root);
  const selected = process.env.BRICKLOOP_PERF_SCENE
    ? fixtures.filter((f) => f.name === process.env.BRICKLOOP_PERF_SCENE)
    : phase === 'before'
      ? fixtures.filter((f) => f.count >= 1000 && f.definitions === 1)
      : fixtures;
  const results: unknown[] = [];
  let environment: unknown;
  for (const fixture of selected) {
    const directory = await mkdtemp(path.join(scratch, `${phase}-${fixture.name}-`));
    const { app, page } = await launch(directory);

    try {
      environment ??= {
        date: new Date().toISOString(),
        platform: os.platform(),
        release: os.release(),
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        ramGB: os.totalmem() / 1024 ** 3,
        node: process.version,
        backgroundThrottling: false,
        displaySleepBlocked: true,
        foregroundGestureSampling: true,
        display: await app.evaluate(({ BrowserWindow, screen }) => ({
          displays: screen.getAllDisplays(),
          windowBounds: BrowserWindow.getAllWindows()[0]!.getBounds(),
          backgroundThrottling: BrowserWindow.getAllWindows()[0]!.webContents.getBackgroundThrottling(),
        })),
        gpu: await app.evaluate(({ app }) => app.getGPUInfo('complete')),
      };
      for (const cache of ['cold', 'hot'] as const) {
        console.log(`Starting ${phase} ${fixture.name} ${cache}`);
        const bytes = await readFile(fixture.file);
        const start = performance.now();
        const parsed = unpackProject(bytes);
        const parseMs = performance.now() - start;
        expect(parsed.doc).not.toBeNull();
        const profileSession =
          process.env.BRICKLOOP_PERF_PROFILE && cache === 'hot' ? await page.context().newCDPSession(page) : undefined;
        if (profileSession) {
          await profileSession.send('Profiler.enable');
          await profileSession.send('Profiler.start');
        }
        const loading = await openProject(page, fixture);
        if (profileSession) {
          const profile = await profileSession.send('Profiler.stop');
          await writeFile(path.join(scratch, 'hot-profile.json'), JSON.stringify(profile));
          await profileSession.detach();
        }
        const loadedMemory = await memory(app);
        await measurementWindow(app, true);
        const rotationSamples = await rotate(page);
        const rotation = summary(rotationSamples.map((s) => s.frameMs));
        const scene = await page.evaluate(() => window.brickloopEditorTest.metrics());
        const movement = await moveSingle(page);
        await measurementWindow(app, false);
        const saveTo = path.join(scratch, 'saved.brkl');
        await app.evaluate(({ dialog }, filePath) => {
          dialog.showSaveDialog = async () => ({ canceled: false, filePath });
        }, saveTo);
        const saveMs = await page.evaluate(async () => {
          const start = performance.now();
          await window.brickloopEditorTest.save(true);
          return performance.now() - start;
        });
        const bom = await page.evaluate(async () => {
          const state = window.brickloopEditorTest.snapshot();
          const start = performance.now();
          const result = await window.brickloop.projectBom(
            { doc: state.document, workspace: state.workspace, assets: {} },
            {},
          );
          return { ms: performance.now() - start, result };
        });
        const peakMemory = await memory(app);
        if (fixture.count === 10000 && fixture.definitions === 1) await measurementWindow(app, true);
        const commandPreview =
          fixture.count === 10000 && fixture.definitions === 1
            ? await page.evaluate(() => window.brickloopEditorTest.benchmark(10000))
            : null;
        await measurementWindow(app, false);
        const result = {
          fixture: { ...fixture, file: path.basename(fixture.file) },
          cache,
          parseMs,
          ...loading,
          rotation: { ...rotation, fps: 1000 / rotation.meanMs, medianFps: 1000 / rotation.p50Ms },
          rotationSamples,
          movement,
          commandPreview,
          saveMs,
          bomMs: bom.ms,
          scene,
          loadedMemory,
          peakMemory,
        };
        results.push(result);
        console.log(
          `${phase} ${fixture.name} ${cache}: load=${loading.fullyLoadedMs.toFixed(0)}ms rotation=${rotation.p50Ms.toFixed(2)}/${rotation.p95Ms.toFixed(2)}ms save=${saveMs.toFixed(0)}ms BOM=${bom.ms.toFixed(1)}ms`,
        );
        await writeData(`${phase}.json`, { environment, results });
        await closeProject(page);
      }
    } finally {
      await page.evaluate(() => window.brickloopEditorTest.prepareClose()).catch(() => undefined);
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (phase === 'before' || process.env.BRICKLOOP_PERF_SCENE) return;
  const directory = await mkdtemp(path.join(scratch, 'leak-'));
  const { app, page } = await launch(directory);
  const cdp = await page.context().newCDPSession(page);
  const curve: unknown[] = [];
  let settledGpuBytes = 0;
  try {
    const fixture = fixtures.find((f) => f.count === 10000 && f.definitions === 1)!;
    for (let cycle = 0; cycle <= 20; cycle++) {
      if (cycle) {
        await openProject(page, fixture);
        await closeProject(page);
      }
      await cdp.send('HeapProfiler.collectGarbage');
      const heap = await cdp.send('Runtime.getHeapUsage');
      const viewport = await page.evaluate(() => {
        const { batches, cachedDefinitions, gpuBytes } = window.brickloopEditorTest.metrics();
        return { batches, cachedDefinitions, gpuBytes };
      });
      const entry = { cycle, ...(await memory(app)), heap, viewport };
      expect(viewport.batches).toBe(0);
      expect(viewport.cachedDefinitions).toBeLessThanOrEqual(64);
      curve.push(entry);
      console.log(
        `PERF-02 cycle=${cycle} workingSet=${entry.workingSetMB.toFixed(1)}MB heap=${(heap.usedSize / 1024 ** 2).toFixed(1)}MB`,
      );
      await writeData('round2-memory.json', { environment, curve });
      if (cycle === 1) settledGpuBytes = viewport.gpuBytes;
      // Allow small lazy renderer caches, but reject per-project instance-buffer retention.
      if (cycle > 1) expect(viewport.gpuBytes).toBeLessThanOrEqual(settledGpuBytes + 1024 ** 2);
    }
  } finally {
    await cdp.detach();
    await page.evaluate(() => window.brickloopEditorTest.prepareClose()).catch(() => undefined);
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
