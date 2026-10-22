import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { expandInstances } from '@brickloop/core';
import { importIo } from '../../../packages/io/src/studio';
import { unpackProject } from '../../../packages/io/src/project';
import { launchElectron } from './electron-launch';
import { inspectAnimationMp4 } from './animation-mp4';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';
import type { DesktopApi } from '../src/shared/api';
import { loadCatalogSnapshot } from '../src/main/catalog-cache';

declare global {
  interface Window {
    brickloop: DesktopApi;
    brickloopEditorTest: EditorTestApi;
  }
}
export const root = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const evidence = path.join(root, '.devdata/tmp/real-usage');
export const reference = path.join(root, 'packages/ai/test/ai-eval/references/01-front.png');
const catalogCache = path.join(root, '.devdata/m12-5-catalog');
let catalogReady: Promise<unknown> | undefined;
export async function launchUsage(directory: string) {
  // Reuse a real, fingerprinted catalog snapshot, like a designer's normal launch.
  // Each profile gets its own copy, so background validation cannot race another
  // session. Cold indexing of the entire LDraw tree is covered by catalog tests.
  catalogReady ??= loadCatalogSnapshot({
    library: path.join(root, 'library/ldraw'),
    demo: path.join(root, 'library/packs/demo'),
    catalog: catalogCache,
  });
  await catalogReady;
  await cp(catalogCache, path.join(directory, 'cache/catalog'), { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'BRICKLOOP_EVAL_API_KEY', 'BRICKLOOP_AI_EVAL'])
    delete env[key];
  const app = await launchElectron({
    args: [path.join(root, 'apps/desktop')],
    env: { ...env, BRICKLOOP_DATA_DIR: directory },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setContentSize(1440, 1000);
    window.webContents.setBackgroundThrottling(false);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', { timeout: 60000 });
  await page.waitForFunction(() => !!window.brickloopEditorTest);
  return { app, page };
}
export async function closeUsage(app: ElectronApplication) {
  await app
    .windows()[0]
    ?.evaluate(() => window.brickloopEditorTest.prepareClose())
    .catch(() => undefined);
  // Failure cleanup cannot wait on a running workflow's discard confirmation.
  // Successful save/reopen uses the normal window close path below.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await app.close().catch(() => undefined);
}
export async function usageSession(endpoint: string) {
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, 'profile-'));
  let session = await launchUsage(directory);
  await session.page.evaluate(async (endpoint) => {
    const snapshot = await window.brickloop.aiSaveProvider({
      id: crypto.randomUUID(),
      type: 'compatible',
      name: '本机真实流程夹具',
      endpoint,
      model: 'offline-model',
      models: ['offline-model'],
      proxy: 'system',
      proxyUrl: '',
    });
    await window.brickloop.aiSaveSettings({ ...snapshot.settings, history: true, localOnly: true });
  }, endpoint);
  // Configuration through IPC does not refresh the mounted settings store. Restart
  // normally, rather than reloading a renderer with a live recovery document.
  await session.page.evaluate(() => window.brickloopEditorTest.flush());
  await Promise.all([
    session.app.waitForEvent('close'),
    session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()),
  ]);
  session = await launchUsage(directory);
  await session.page.keyboard.press('Control+k');
  return { ...session, directory };
}
export async function cleanupUsage(directory: string) {
  expect(path.dirname(path.resolve(directory))).toBe(evidence);
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
export async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), animations: 'disabled' });
}
export async function dropFile(page: Page, selector: string, file: string, mime = 'image/png') {
  const bytes = await readFile(file);
  const transfer = await page.evaluateHandle(
    ({ base64, name, mime }) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name, { type: mime }));
      return data;
    },
    { base64: bytes.toString('base64'), name: path.basename(file), mime },
  );
  await page.locator(selector).dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
}
export async function planAndStart(page: Page, description: string, expectRound = true) {
  await page.getByRole('textbox', { name: '描述', exact: true }).fill(description);
  await page.getByRole('button', { name: '生成计划', exact: true }).click();
  await expect(page.locator('.image-plan-modal')).toBeVisible({ timeout: 120000 });
  await page.getByRole('textbox', { name: '部件名称', exact: true }).first().fill('设计师修改的主体');
  await page.getByRole('button', { name: '开始搭建', exact: true }).click();
  if (expectRound) {
    await expect(page.locator('.image-task-card')).toBeVisible();
    await expect(page.locator('.image-task-card')).toContainText('轮');
  }
}
export async function completedReport(page: Page) {
  await expect(page.locator('.image-report').last()).toBeVisible({ timeout: 120000 });
  // The report precedes the durable asset/history merge; a near-limit reference
  // takes longer to persist than the default ten-second locator wait.
  await expect
    .poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running), { timeout: 120000 })
    .toBe(false);
  const report = await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)!.report!);
  expect(report).toBeDefined();
  return report;
}
export async function visibleModel(page: Page) {
  await page.evaluate(async () => {
    await window.brickloopEditorTest.meshesReady();
    window.brickloopEditorTest.action('view.fitAll');
  });
  const pixels = await page.evaluate(async () => {
    const bytes = await window.brickloopEditorTest.captureViewport();
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
    const image = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    // Review overlays tint new parts green; compare with the grid-free background instead of requiring red.
    for (let i = 0; i < rgba.length; i += 4)
      if (
        rgba[i + 3]! > 0 &&
        Math.abs(rgba[i]! - rgba[0]!) + Math.abs(rgba[i + 1]! - rgba[1]!) + Math.abs(rgba[i + 2]! - rgba[2]!) > 40
      )
        colored++;
    image.close();
    return colored;
  });
  expect(pixels).toBeGreaterThan(100);
}
export async function saveTo(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, file);
}
/** Real UI exports, actual archive/video readers, then a complete Electron restart. */
export async function finishImageFlow(
  session: Awaited<ReturnType<typeof usageSession>>,
  name: string,
  images: number,
  undo = false,
) {
  let { app, page } = session;
  const report = await completedReport(page);
  expect(report.reason).toBe('completed');
  expect(report.partCount).toBeGreaterThan(0);
  expect(report.plan?.components[0]?.name).toBe('设计师修改的主体');
  expect(report.rounds.length).toBeGreaterThan(1);
  expect(report.unfinished).toEqual([]);
  expect(report.validation.checked).toBe(true);
  expect(report.references).toHaveLength(images);
  if (images === 8)
    expect(report.references.map((r) => r.view)).toEqual([
      'front',
      'back',
      'left',
      'right',
      'top',
      'top',
      'front',
      'left',
    ]);
  if (images) {
    expect(report.comparisons.length).toBeGreaterThanOrEqual(images);
    for (const comparison of report.comparisons) {
      expect(comparison.iou).toBeGreaterThanOrEqual(0);
      expect(comparison.iou).toBeLessThanOrEqual(1);
    }
  } else expect(report.comparisons).toEqual([]);
  const before = await page.evaluate(() => window.brickloopEditorTest.expanded());
  expect(report.partCount).toBe(before.length);
  await visibleModel(page);
  await expect(page.getByTestId('review-bar')).toBeVisible();
  await shot(page, `${name}-model`);
  if (undo) {
    await page.getByTestId('review-bar').getByRole('button', { name: '撤销整轮', exact: true }).click();
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded())).toEqual([]);
    // Restore the designer-approved result before exporting the same completed workflow.
    await page.locator('.document-title').click();
    await page.keyboard.press('Control+y');
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded())).toEqual(before);
  } else await page.getByTestId('review-bar').getByRole('button', { name: '全部保留', exact: true }).click();
  const section = page.locator('.image-report').last();
  await expect(section).toContainText(String(report.partCount));
  await expect(section).toContainText('未完成');
  await section.scrollIntoViewIfNeeded();
  await shot(page, `${name}-report`);
  await section.getByRole('button', { name: '播放搭建动画', exact: true }).click();
  await expect(page.locator('.animation-session')).toHaveAttribute('data-ready', 'true', { timeout: 60000 });
  await expect
    .poll(() => page.evaluate(() => window.brickloopEditorTest.animation.state()?.time ?? 0))
    .toBeGreaterThan(0);
  await page.getByRole('spinbutton', { name: '时长', exact: true }).fill('5');
  await page.getByRole('spinbutton', { name: '时长', exact: true }).blur();
  await expect(page.locator('.animation-session')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '导出视频…', exact: true }).click();
  const mp4 = path.join(session.directory, `${name}.mp4`);
  await saveTo(app, mp4);
  await page.getByRole('button', { name: '导出视频', exact: true }).click();
  await expect(page.locator('.animation-export-options')).toContainText('视频已保存', { timeout: 90000 });
  const video = inspectAnimationMp4(await readFile(mp4));
  expect(video.boxes).toEqual(expect.arrayContaining(['ftyp', 'moov', 'mdat']));
  expect(video.codec).toMatch(/^avc1\./);
  expect(video.duration).toBeCloseTo(5, 1);
  expect(video.count).toBe(150);
  await page
    .getByRole('dialog', { name: '导出搭建视频', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .last()
    .click();
  await page.locator('.build-animation-dialog .ant-modal-close').click();
  const ioPath = path.join(session.directory, `${name}.io`);
  await saveTo(app, ioPath);
  await section.getByRole('button', { name: '导出 .io…', exact: true }).click();
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('导出报告', { timeout: 45000 });
  const colors = await page.evaluate(() => window.brickloop.catalogColors());
  const imported = importIo(await readFile(ioPath), { colors: colors.all });
  expect(imported.report.errors).toEqual([]);
  const rows = expandInstances(imported.doc!);
  expect(rows).toHaveLength(before.length);
  expect(rows.map((r) => [r.partId, r.colorId, Array.from(r.worldMatrix)])).toEqual(
    before.map((r) => [r.partId, r.colorId, r.matrix]),
  );
  await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
  const file = path.join(session.directory, `${name}.brkl`);
  await saveTo(app, file);
  await page.locator('.document-title').click();
  await page.keyboard.press('Control+s');
  await expect(page).not.toHaveTitle(/^•/);
  await expect
    .poll(async () =>
      readFile(file).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  const saved = unpackProject(await readFile(file));
  expect(expandInstances(saved.doc!)).toHaveLength(before.length);
  const bar = page.getByTestId('ai-context-bar');
  await expect(bar).toContainText('1 轮');
  const tokens = Number(await bar.getAttribute('data-tokens'));
  expect(tokens).toBeGreaterThan(0);
  const turn = await page.evaluate(() => {
    const turn = window.brickloopEditorTest.aiState().turns.at(-1)!;
    return { user: turn.user, text: turn.text };
  });
  await page.evaluate(() => window.brickloopEditorTest.flush());
  // ElectronApplication.close() quits the process directly. Use the actual window
  // close path so each document removes its recovery snapshot.
  await Promise.all([
    app.waitForEvent('close'),
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()),
  ]);
  ({ app, page } = await launchUsage(session.directory));
  session.app = app;
  session.page = page;
  await shot(page, `${name}-restart`);
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await page.getByRole('menuitem', { name: '文件', exact: true }).click();
  await page.getByRole('menuitem', { name: /^打开/ }).click();
  await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', String(before.length));
  await page.keyboard.press('Control+k');
  expect(await page.evaluate(() => window.brickloopEditorTest.expanded())).toEqual(before);
  await expect(page.locator('.image-report')).toBeVisible();
  const restored = await page.evaluate(() => {
    const turn = window.brickloopEditorTest.aiState().turns.at(-1)!;
    return { user: turn.user, text: turn.text, report: turn.report };
  });
  expect(restored.report).toEqual(report);
  expect(restored.user).toBe(turn.user);
  expect(restored.text).toBe(turn.text);
  await expect(page.getByTestId('ai-context-bar')).toContainText('1 轮');
  await expect(page.getByTestId('ai-context-bar')).toHaveAttribute('data-tokens', String(tokens));
  await expect(page.locator('.ai-context-excluded')).toHaveCount(0);
  await writeFile(
    path.join(evidence, `${name}-result.json`),
    JSON.stringify(
      {
        parts: before.length,
        rounds: report.rounds.length,
        references: images,
        comparisons: report.comparisons.length,
        unfinished: report.unfinished,
        video: { duration: video.duration, frames: video.count },
        contextTokens: tokens,
      },
      null,
      2,
    ),
  );
  await shot(page, `${name}-reopened`);
}
