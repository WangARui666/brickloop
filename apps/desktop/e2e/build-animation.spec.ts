import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import type { ElectronApplication, Page } from '@playwright/test';
import type { BaseWindow, SaveDialogOptions } from 'electron';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';
import { imageModelServer } from './image-model-fixture';
import { animationCottage } from './animation-fixture';
import { inspectAnimationMp4 } from './animation-mp4';
declare global {
  interface Window {
    brickloopEditorTest: EditorTestApi;
  }
}
const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url))),
  desktop = path.join(root, 'apps/desktop');
const shots = path.join(root, '.devdata/m10-1-shots'),
  results = path.join(root, '.devdata/e2e-results');
test('ANI-09: unsaved, saved and submodel names match player, exported frames and save defaults', async () => {
  test.setTimeout(180000);
  await mkdir(results, { recursive: true });
  const directory = await mkdtemp(path.join(results, 'animation-names-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron({
    args: [desktop],
    env: { ...env, BRICKLOOP_DATA_DIR: directory },
    timeout: 60000,
  });
  const page = await app.firstWindow();

  try {
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 60000,
    });
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.evaluate(async () => {
      const api = window.brickloopEditorTest;
      await api.seed(2);
      api.applyOps([{ type: 'meta.update', changes: { title: '未命名 1' } }]);
      await api.meshesReady();
    });
    for (const name of ['未命名 1', '城堡样例', '双色塔楼']) {
      if (name === '城堡样例') {
        await app.evaluate(
          ({ dialog }, filePath) => {
            dialog.showSaveDialog = async () => ({ canceled: false, filePath });
          },
          path.join(directory, '城堡样例.brkl'),
        );
        await page.evaluate(() => window.brickloopEditorTest.save());
        expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().document.meta.title)).toBe('未命名 1');
      }
      if (name === '双色塔楼') {
        await page.evaluate(() => {
          const api = window.brickloopEditorTest;
          api.select(api.expanded().map((part) => part.path));
          api.command({ type: 'submodel.create', name: '双色塔楼' });
          api.structure();
        });
        await page.locator('.definition-row').filter({ hasText: '双色塔楼' }).first().click({ button: 'right' });
        await page.getByRole('menuitem', { name: '播放搭建动画', exact: true }).click();
      } else {
        await expect(page.locator('.document-tab')).toContainText(name);
        await page.getByRole('menuitem', { name: '视图', exact: true }).click();
        await page.getByRole('menuitem', { name: '搭建动画…', exact: true }).click();
      }
      await stablePlayer(page);
      await expect(page.locator('.animation-caption strong')).toHaveText(name);
      await page.getByRole('spinbutton', { name: '时长', exact: true }).fill('5');
      await page.getByRole('spinbutton', { name: '时长', exact: true }).blur();
      await stablePlayer(page);
      await page.getByRole('button', { name: '导出视频…', exact: true }).click();
      await expect(page.locator('.animation-export-options')).toContainText('MP4 · H.264');
      const saveOptions = await app.evaluateHandle(
        ({ dialog }, filePath) => {
          const defaults: string[] = [];
          dialog.showSaveDialog = async (
            windowOrOptions: BaseWindow | SaveDialogOptions,
            options?: SaveDialogOptions,
          ) => {
            defaults.push((options ?? (windowOrOptions as SaveDialogOptions)).defaultPath ?? '');
            return { canceled: false, filePath };
          };
          return defaults;
        },
        path.join(directory, `${name}.mp4`),
      );
      const frameTitles = await page.evaluateHandle(() => {
        const titles: string[] = [];
        const original = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof original>) {
          if (this.canvas.width === 1920 && this.canvas.height === 1080 && this.font.startsWith('600 '))
            titles.push(args[0]);
          original.apply(this, args);
        };
        return { titles, original };
      });
      try {
        await page.getByRole('button', { name: '导出视频', exact: true }).click();
        await expect(page.locator('.animation-export-options')).toContainText('视频已保存', { timeout: 60000 });
        expect((await saveOptions.jsonValue()).map((file) => path.basename(file))).toEqual([`${name}-搭建动画.mp4`]);
        const titles = await frameTitles.evaluate(({ titles }) => titles);
        expect(titles).toHaveLength(150);
        expect([...new Set(titles)]).toEqual([name]);
      } finally {
        await frameTitles.evaluate(({ original }) => {
          CanvasRenderingContext2D.prototype.fillText = original;
        });
        await frameTitles.dispose();
        await saveOptions.dispose();
      }
      await page
        .getByRole('dialog', { name: '导出搭建视频', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .last()
        .click();
      await page.locator('.build-animation-dialog .ant-modal-close').click();
    }
  } finally {
    await page.evaluate(() => window.brickloopEditorTest.prepareClose()).catch(() => undefined);
    await app.close();
    expect(path.dirname(path.resolve(directory))).toBe(results);
    await rm(directory, { recursive: true, force: true });
  }
});
async function stablePlayer(page: Page) {
  await expect(page.locator('.animation-session')).toHaveAttribute('data-ready', 'true', { timeout: 60000 });
  await page.waitForFunction(() => {
    const dialog = document.querySelector('.build-animation-dialog');
    if (!dialog || dialog.querySelector('[class*="ant-zoom-"]')) return false;
    for (let element: Element | null = dialog; element && element !== document.body; element = element.parentElement) {
      if (element.className.includes('ant-zoom-') || getComputedStyle(element).opacity !== '1') return false;
    }
    const content = dialog.querySelector('.ant-modal-content') ?? dialog.querySelector('.ant-modal-container');
    return !!content && getComputedStyle(content).opacity === '1' && getComputedStyle(dialog).transform === 'none';
  });
}
test('ANI-04–08: scripted cottage, all entries, immutable player, AVC frames, cancel and measured performance', async () => {
  test.setTimeout(900_000);
  await mkdir(shots, { recursive: true });
  await mkdir(results, { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/m10-1-e2e-')),
    server = await imageModelServer();
  server.controls.animationCode = animationCottage;
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    app = await launchElectron({ args: [desktop], env: { ...env, BRICKLOOP_DATA_DIR: directory }, timeout: 60000 });
    const page = await app.firstWindow();

    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await app.evaluate(({ BrowserWindow, powerSaveBlocker }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.setContentSize(1600, 1000);
      w.webContents.setBackgroundThrottling(false);
      powerSaveBlocker.start('prevent-display-sleep');
    });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 60000,
    });
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.getByRole('menuitem', { name: '视图', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '搭建动画…', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('Escape');
    await page.evaluate(async (endpoint) => {
      const settings = await window.brickloop.aiSaveProvider({
        id: crypto.randomUUID(),
        name: '动画脚本夹具',
        type: 'compatible',
        endpoint,
        model: 'offline-model',
        models: ['offline-model'],
        proxy: 'system',
        proxyUrl: '',
      });
      await window.brickloop.aiSaveSettings({ ...settings.settings, localOnly: true });
    }, server.endpoint);
    await page.reload();
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.evaluate(async () => {
      window.brickloopEditorTest.applyOps([{ type: 'meta.update', changes: { title: '庭院村舍' } }]);
      const snapshot = await window.brickloop.aiSnapshot();
      await window.brickloopEditorTest.imageStart({
        providerId: snapshot.settings.providers[0]!.id,
        model: 'offline-model',
        directStart: true,
        budget: { rounds: 2, toolCalls: 80, durationMs: 180000 },
        input: {
          description: '搭建庭院村舍，两千件积木，浅色墙体、红色坡屋顶、门窗和步道',
          images: [],
          targetSize: 'large',
          palette: { source: 'factory' },
          parts: { source: 'all' },
          style: '乡村建筑',
          priority: 'appearance',
        },
      });
    });
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.tasks().at(-1)?.status), {
        timeout: 240000,
        intervals: [500, 1000, 2000],
      })
      .toBe('merged');
    await page.evaluate(async () => {
      await window.brickloopEditorTest.meshesReady();
      window.brickloopEditorTest.action('view.fitAll');
    });
    const count = await page.evaluate(() => window.brickloopEditorTest.expanded().length);
    expect(count).toBe(2000);
    expect(
      await page.evaluate(
        () => window.brickloopEditorTest.expanded().filter((p) => p.colorId === 'c:bright-red').length,
      ),
    ).toBeGreaterThan(300);
    const appearance = [];
    for (const backend of [true, false]) {
      const comparison = await page.evaluate(
        (gpu) => window.brickloopEditorTest.animation.compareCompleted(gpu),
        backend,
      );
      const { actualPng, expectedPng, ...metrics } = comparison;
      await writeFile(
        path.join(shots, `comparison-${metrics.backend}-animation.png`),
        Buffer.from(actualPng.split(',')[1]!, 'base64'),
      );
      await writeFile(
        path.join(shots, `comparison-${metrics.backend}-editor.png`),
        Buffer.from(expectedPng.split(',')[1]!, 'base64'),
      );
      appearance.push(metrics);
    }
    await writeFile(path.join(results, 'm10-1-appearance.json'), JSON.stringify(appearance, null, 2));
    for (const metric of appearance) {
      expect(metric.modelPixels).toBeGreaterThan(100000);
      expect(metric.redPixels).toBeGreaterThan(20000);
      expect(metric.colors.find((c) => c.id === 'c:bright-red')?.alpha).toBe(1);
      expect(metric.meanDifference).toBeLessThan(6);
      expect(metric.redLuminanceDifference).toBeLessThan(3);
      for (const transition of metric.handoff) expect(transition.meanDifference).toBeLessThan(6);
    }
    await page.evaluate(() => window.brickloopEditorTest.action('ai.open'));
    const entry = page.locator('.image-report').getByRole('button', { name: '播放搭建动画', exact: true });
    await expect(entry).toBeVisible();
    await entry.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, '05-report-entry.png') });
    await page.evaluate(() => window.brickloopEditorTest.select([window.brickloopEditorTest.expanded()[0]!.path]));
    const baseline = await page.evaluate(() => {
      const a = window.brickloopEditorTest,
        s = a.snapshot();
      return {
        document: s.document,
        workspace: s.workspace,
        history: s.history,
        redo: s.redo,
        camera: a.camera(),
        dirty: s.dirty,
      };
    });
    await entry.click();
    await stablePlayer(page);
    const stage = page.locator('.animation-stage');
    expect(
      await stage.evaluate((el) => {
        const canvas = el.querySelector('canvas')!;
        return Math.abs(canvas.clientWidth - el.clientWidth) < 1 && Math.abs(canvas.clientHeight - el.clientHeight) < 1;
      }),
    ).toBe(true);
    await expect(page.locator('.animation-session')).toBeFocused();
    expect(await stage.evaluate((el) => getComputedStyle(el).borderColor)).not.toBe('rgb(255, 138, 61)');
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.animation.state()?.time ?? 0))
      .toBeGreaterThan(0.3);
    expect(await page.evaluate(() => window.brickloopEditorTest.animation.state()?.playing)).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.animation.state()?.playing)).toBe(false);
    await page.keyboard.press('ArrowRight');
    const nextLayer = await page.evaluate(() => window.brickloopEditorTest.animation.state()!.time);
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => window.brickloopEditorTest.animation.state()!.time)).toBeLessThan(nextLayer);
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.animation.state()?.playing)).toBe(true);
    await page.evaluate(() => window.brickloopEditorTest.animation.seek(10));
    const canvas = await page.locator('.animation-surface canvas').elementHandle();
    for (const name of ['压暗已完成部分', '显示文字', '显示文字', '压暗已完成部分']) {
      await page.getByRole('checkbox', { name, exact: true }).click();
      expect(await page.evaluate(() => window.brickloopEditorTest.animation.state()?.time)).toBe(10);
      expect(await canvas!.evaluate((el) => el === document.querySelector('.animation-surface canvas'))).toBe(true);
    }
    for (const mode of ['固定', '环绕']) {
      await page.getByRole('combobox', { name: '相机', exact: true }).click();
      await page.locator('.ant-select-item-option-content').getByText(mode, { exact: true }).click();
      expect(await page.evaluate(() => window.brickloopEditorTest.animation.state()?.time)).toBe(10);
      expect(await canvas!.evaluate((el) => el === document.querySelector('.animation-surface canvas'))).toBe(true);
    }
    await canvas!.dispose();
    // Shift+Tab from the first setting enters the stage, so only keyboard focus gets the accent.
    await page.getByRole('combobox', { name: '拼装顺序', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(stage).toBeFocused();
    expect(await stage.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    expect(await stage.evaluate((el) => getComputedStyle(el).borderColor)).toBe('rgb(255, 138, 61)');
    await page.keyboard.press('Tab');
    await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
    await stage.click({ position: { x: 12, y: 12 } });
    for (const [fraction, file] of [
      [0.3, '01-player-30.png'],
      [0.7, '02-player-70.png'],
      [1, '03-completed.png'],
    ] as const) {
      await page.evaluate((f) => {
        const a = window.brickloopEditorTest.animation;
        a.seek(a.state()!.duration * f);
      }, fraction);
      await page.screenshot({ path: path.join(shots, file) });
      const state = await page.evaluate(() => window.brickloopEditorTest.animation.state()!);
      if (fraction < 1) {
        expect(state.visible).toBeGreaterThan(0);
        expect(state.visible).toBeLessThan(count);
      } else expect(state.visible).toBe(count);
    }
    expect(errors.slice(0, 3)).toEqual([]);
    await page.evaluate(() => window.brickloopEditorTest.animation.close());
    expect(
      await page.evaluate(() => {
        const a = window.brickloopEditorTest,
          s = a.snapshot();
        return {
          document: s.document,
          workspace: s.workspace,
          history: s.history,
          redo: s.redo,
          camera: a.camera(),
          dirty: s.dirty,
        };
      }),
    ).toEqual(baseline);
    // View, structure, instructions and merged-review entry points.
    await page.getByRole('menuitem', { name: '视图', exact: true }).click();
    await page.getByRole('menuitem', { name: '搭建动画…', exact: true }).click();
    await expect(page.locator('.animation-session')).toHaveAttribute('data-ready', 'true');
    await page.evaluate(() => window.brickloopEditorTest.animation.close());
    await page.evaluate(() => window.brickloopEditorTest.structure());
    await page.locator('.definition-row').filter({ hasText: '庭院村舍' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '播放搭建动画', exact: true }).click();
    await expect(page.locator('.animation-session')).toHaveAttribute('data-ready', 'true');
    await page.evaluate(() => window.brickloopEditorTest.animation.close());
    await page.evaluate(() => window.brickloopEditorTest.pdf());
    await page.getByRole('button', { name: '预览搭建动画', exact: true }).click();
    await stablePlayer(page);
    await expect(page.getByTestId('animation-group')).toContainText('步');
    await page.evaluate(() => window.brickloopEditorTest.animation.seek(1));
    const opaqueStage = await stage.screenshot();
    await page.locator('.instruction-dialog').evaluate((el) => {
      (el as HTMLElement).style.visibility = 'hidden';
    });
    expect(await stage.screenshot()).toEqual(opaqueStage);
    await page.locator('.instruction-dialog').evaluate((el) => {
      (el as HTMLElement).style.visibility = '';
    });
    await page.screenshot({ path: path.join(shots, '06-instruction-steps.png') });
    await page.evaluate(() => window.brickloopEditorTest.animation.close());
    await page.locator('.instruction-dialog').getByRole('button', { name: '关闭', exact: true }).last().click();
    await page.locator('.review-bar').getByRole('button', { name: '播放搭建动画', exact: true }).click();
    await expect(page.locator('.animation-session')).toHaveAttribute('data-ready', 'true');
    const canceled = path.join(directory, 'cancel.mp4');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, canceled);
    await page.getByRole('button', { name: '导出视频…', exact: true }).click();
    await page.getByRole('button', { name: '导出视频', exact: true }).click();
    await expect(page.getByTestId('animation-export-progress')).toBeVisible();
    await expect
      .poll(async () =>
        Number(
          await page.getByTestId('animation-export-progress').getByRole('progressbar').getAttribute('aria-valuenow'),
        ),
      )
      .toBeGreaterThanOrEqual(15);
    await page.screenshot({ path: path.join(shots, '04-export-progress.png') });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByText('已取消导出', { exact: true })).toBeVisible({ timeout: 20000 });
    expect((await readdir(directory)).filter((n) => n.startsWith('cancel.mp4'))).toEqual([]);
    await page.getByRole('button', { name: '关闭', exact: true }).last().click();
    await page.evaluate(() => window.brickloopEditorTest.animation.close());
    // Same production export path, compressed to exactly 90 frames for ANI-05.
    const short = path.join(shots, 'verification-720p.mp4');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, short);
    const video = await page.evaluate(() =>
      window.brickloopEditorTest.animation.export({ height: 720, fps: 30, white: false }, 3, true),
    );
    expect(video.choice.format).toBe('mp4');
    const bytes = await readFile(short),
      mp4 = inspectAnimationMp4(bytes);
    expect(mp4.boxes).toEqual(expect.arrayContaining(['ftyp', 'moov', 'mdat']));
    expect(mp4.fastStart).toBe(true);
    expect(mp4.duration).toBeCloseTo(3, 1);
    expect(mp4.count).toBe(90);
    expect(mp4.codec).toMatch(/^avc1.64/);
    expect(mp4.chromaFormat).toBe(1); // YUV 4:2:0, for Windows/WeChat hardware decoders.
    expect(mp4.bitDepth).toBe(8);
    expect(mp4.trackCount).toBe(1);
    const decoded = await page.evaluate(
      async (data) => window.brickloopEditorTest.animation.decode([], data.samples, data.description, data.codec),
      mp4,
    );
    expect(decoded.frames).toBe(90);
    const differences = decoded.pixels.map(
      (pixels, index) =>
        pixels.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : Math.abs(value - video.references[index]![i]!)), 0) /
        (160 * 90 * 3),
    );
    expect(differences).toHaveLength(3);
    differences.forEach((value) => expect(value).toBeLessThan(8));
    // Unwritable path rejects and leaves no target or temporary files.
    const failed = path.join(directory, 'missing-parent', 'failure.mp4');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, failed);
    await page.evaluate(() => window.brickloopEditorTest.animation.open());
    await expect(page.locator('.animation-session')).toHaveAttribute('data-ready', 'true');
    await page.getByRole('spinbutton', { name: '时长', exact: true }).fill('5');
    await page.getByRole('spinbutton', { name: '时长', exact: true }).blur();
    await expect(page.locator('.animation-session')).toHaveAttribute('data-ready', 'true');
    await page.getByRole('button', { name: '导出视频…', exact: true }).click();
    const failureStarted = performance.now();
    await page.getByRole('button', { name: '导出视频', exact: true }).click();
    // The destination preflight fails in well under a second, before rendering; retain the original UI timeout.
    await expect(page.locator('.animation-export-options').getByText(/ENOENT/)).toBeVisible({ timeout: 30000 });
    const failureElapsedMs = performance.now() - failureStarted;
    console.log('Animation export time-to-error', JSON.stringify({ failureElapsedMs }));
    expect(failureElapsedMs).toBeLessThan(5000);
    await page.getByRole('button', { name: '关闭', exact: true }).last().click();
    await page.evaluate(() => window.brickloopEditorTest.animation.close());
    expect((await readdir(directory)).some((n) => n.includes('.tmp'))).toBe(false);
    // Force only the capability probe to reject AVC; exercise the real VP9 encoder/muxer.
    const originalSupport = await page.evaluateHandle(() => VideoEncoder.isConfigSupported.bind(VideoEncoder));
    await page.evaluate(() => {
      const support = VideoEncoder.isConfigSupported.bind(VideoEncoder);
      VideoEncoder.isConfigSupported = async (config) =>
        config.codec.startsWith('avc') ? { supported: false, config } : support(config);
    });
    const fallbackFile = path.join(directory, 'fallback.webm');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, fallbackFile);
    let fallback;
    try {
      await page.evaluate(() => window.brickloopEditorTest.animation.open());
      await expect(page.locator('.animation-session')).toHaveAttribute('data-ready', 'true');
      await page.getByRole('button', { name: '导出视频…', exact: true }).click();
      await expect(
        page.getByText('本机不支持所选规格的 H.264 编码，将导出 WebM（VP9）。', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: '关闭', exact: true }).last().click();
      await page.evaluate(() => window.brickloopEditorTest.animation.close());
      fallback = await page.evaluate(() =>
        window.brickloopEditorTest.animation.export({ height: 720, fps: 30, white: true }, 0.3),
      );
      expect(fallback.choice.format).toBe('webm');
      expect((await readFile(fallbackFile)).subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    } finally {
      await originalSupport.evaluate((fn) => {
        VideoEncoder.isConfigSupported = fn;
      });
      await originalSupport.dispose();
    }
    const playback = [];
    for (const preferWebGPU of [true, false])
      for (const size of [2000, 20000])
        playback.push(
          await page.evaluate(
            async ({ size, preferWebGPU }) => window.brickloopEditorTest.animation.playback(size, preferWebGPU),
            { size, preferWebGPU },
          ),
        );
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      },
      path.join(shots, 'demo.mp4'),
    );
    const exported = await page.evaluate(() =>
      window.brickloopEditorTest.animation.export({ height: 1080, fps: 30, white: false }, 30),
    );
    expect(exported.frames).toBe(900);
    expect(exported.uiTicks).toBeGreaterThan(20);
    const demo = inspectAnimationMp4(await readFile(path.join(shots, 'demo.mp4')));
    expect(demo.count).toBe(900);
    expect(demo.duration).toBeCloseTo(30, 2);
    expect(demo.codec).toMatch(/^avc1.64/);
    expect(demo.chromaFormat).toBe(1);
    expect(demo.bitDepth).toBe(8);
    const lastFrame = await page.evaluate(
      (data) => window.brickloopEditorTest.animation.decode([], data.samples, data.description, data.codec, true),
      {
        samples: demo.samples.slice(demo.samples.reduce((last, sample, index) => (sample.key ? index : last), 0)),
        description: demo.description,
        codec: demo.codec,
      },
    );
    await writeFile(path.join(shots, 'demo-last.png'), Buffer.from(lastFrame.png!.split(',')[1]!, 'base64'));
    await writeFile(
      path.join(results, 'm10-1-perf.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          parts: count,
          playback,
          export: { ...exported, references: undefined },
          shortVideo: {
            choice: video.choice,
            frames: mp4.count,
            duration: mp4.duration,
            codec: mp4.codec,
            chromaFormat: mp4.chromaFormat,
            bitDepth: mp4.bitDepth,
            meanPixelDifferences: differences,
          },
          fallback: fallback?.choice,
          errors,
        },
        null,
        2,
      ),
    );
    expect(errors.slice(0, 3)).toEqual([]);
  } finally {
    if (app) {
      await app
        .firstWindow()
        .then((p) => p.evaluate(() => window.brickloopEditorTest?.prepareClose()))
        .catch(() => undefined);
      await app.close();
    }
    await server.close();
    // directory was created by this test under the worktree .devdata; never follow library junctions.
    if (path.resolve(directory).startsWith(path.join(root, '.devdata') + path.sep))
      await rm(directory, { recursive: true, force: true });
  }
});
