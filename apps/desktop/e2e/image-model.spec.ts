import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import { setStableContentSize } from './window-size';
import type { ElectronApplication, Page } from '@playwright/test';
import { expandInstances } from '@brickloop/core';
import { importIo } from '../../../packages/io/src/studio';
import type { WorkflowReport, ToolResult } from '@brickloop/ai';
import { imageModelServer, fixturePlan, cathedralPlan } from './image-model-fixture';
import { runEvaluation } from '../scripts/ai-eval';
import { unpackProject } from '../../../packages/io/src/project';
import { usageSession, launchUsage, saveTo, closeUsage, cleanupUsage, completedReport } from './real-usage-helpers';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
  root = path.resolve(desktop, '../..');
const evidence = path.join(desktop, '../../.devdata/e2e-evidence/m6-1b');
async function capture(app: ElectronApplication, page: Page, name: string, target?: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const [width, height] of [
    [1440, 900],
    [1100, 700],
  ]) {
    // Keep screenshot viewport dimensions stable across Windows native resize delivery.
    await page.setViewportSize({ width: width!, height: height! });
    await setStableContentSize(app, page, width!, height!);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
    if (target)
      await page
        .locator(target)
        .last()
        .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.mouse.move(16, 16);
    await page.waitForFunction(
      () =>
        document.getAnimations().filter((a) => {
          const timing = a.effect?.getComputedTiming();
          return a.playState === 'running' && timing?.iterations !== Infinity;
        }).length === 0,
    );
    await page.screenshot({
      path: path.join(evidence, `${name}-${width}x${height}.png`),
      animations: 'disabled',
      scale: 'css',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
}
async function input(page: Page, text: string) {
  await page.getByRole('button', { name: '按参考图生成', exact: true }).click();
  await page.getByRole('textbox', { name: '描述', exact: true }).fill(text);
}
// Windows can send a real buttonless WM_MOUSEMOVE between synthetic mousedown and mousemove,
// e.g. when another window appears under the cursor. It can cancel the gesture or start a drag
// before Playwright intercepts it; neither delivers a drop to the target row.
// Only a drop on the original target row confirms completion.
async function dragPlanRow(page: Page) {
  const source = page.locator('.plan-order [draggable]').first(),
    rows = page.locator('.image-plan-table tbody tr');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const dragEvents = await source.evaluateHandle((element) => {
      const tbody = element.closest('tbody')!,
        target = tbody.rows[tbody.rows.length - 1]!;
      const state = { started: false, dropRow: 0, droppedOnTarget: false };
      const recordStart = (event: Event) => {
        state.started = event.target === element;
      };
      const recordDrop = (event: Event) => {
        const row = event.target instanceof Element ? event.target.closest('tr') : null;
        if (row?.parentElement === tbody) {
          state.dropRow = row.sectionRowIndex + 1;
          state.droppedOnTarget = row === target;
        }
      };
      element.addEventListener('dragstart', recordStart, { capture: true, once: true });
      tbody.addEventListener('drop', recordDrop, { capture: true, once: true });
      return {
        state,
        cleanup: () => {
          element.removeEventListener('dragstart', recordStart, true);
          tbody.removeEventListener('drop', recordDrop, true);
        },
      };
    });
    let result: { started: boolean; dropRow: number; droppedOnTarget: boolean };
    try {
      await source.dragTo(rows.last());
      result = await dragEvents.evaluate(({ state }) => state);
    } finally {
      await dragEvents.evaluate(({ cleanup }) => cleanup());
      await dragEvents.dispose();
    }
    if (result.droppedOnTarget) return;
    if (result.dropRow)
      throw new Error(`IMG-01 plan drag dropped on row ${result.dropRow} instead of the original last row.`);
    await expect(page.getByRole('textbox', { name: '部件名称', exact: true }).first()).toHaveValue('主体');
    await expect(rows).toHaveCount(2);
    if (attempt < 3)
      test.info().annotations.push({
        type: 'plan-drag-retry',
        description: `No drop on attempt ${attempt}; dragstart=${result.started} (${
          result.started ? 'drag began before Playwright interception' : 'gesture canceled before dragstart'
        }); retrying (${attempt + 1}/3).`,
      });
  }
  throw new Error('IMG-01 plan drag did not deliver a drop to the target row after 3 attempts.');
}
async function finished(page: Page, timeout = 90000) {
  await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running), { timeout }).toBe(false);
  const report = await page.evaluate(
    () => [...window.brickloopEditorTest.aiState().turns].reverse().find((t) => t.report)?.report,
  );
  expect(report).toBeDefined();
  return report as WorkflowReport;
}
async function closeImageTest(app: ElectronApplication) {
  const page = app.windows()[0];
  if (page) {
    await page
      .evaluate(() => window.brickloop.aiStop(window.brickloopEditorTest.aiState().workflow?.taskId))
      .catch(() => undefined);
    await page.waitForFunction(() => !window.brickloopEditorTest.aiState().running).catch(() => undefined);
    await page.evaluate(() => window.brickloopEditorTest.prepareClose()).catch(() => undefined);
  }
  await app.close();
}

// Like the M12-19 JPEG fixture: deterministic photo-like noise/gradients and a clean border.
async function syntheticPng(page: Page, width = 4000, height = 3000, alpha = 255) {
  return page.evaluate(
    ({ width, height, alpha }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      const pixels = context.createImageData(width, height);
      pixels.data.fill(255);
      let seed = 132;
      for (let y = Math.floor(height * 0.3); y < height * 0.7; y++)
        for (let x = Math.floor(width * 0.3); x < width * 0.7; x++)
          for (let channel = 0; channel < 3; channel++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            pixels.data[(y * width + x) * 4 + channel] = (seed >>> 25) + Math.floor((x / width + y / height) * 60);
          }
      // One almost-opaque pixel that resampling can erase; opacity must inspect the original.
      pixels.data[3] = alpha;
      context.putImageData(pixels, 0, 0);
      const base64 = canvas.toDataURL('image/png').split(',')[1]!;
      canvas.width = canvas.height = 1;
      return base64;
    },
    { width, height, alpha },
  );
}

function referenceUrls(request: Awaited<ReturnType<typeof imageModelServer>>['requests'][number]) {
  return request.messages.flatMap((message) =>
    typeof message.content === 'string'
      ? []
      : message.content.flatMap((block) => (block.image_url ? [block.image_url.url] : [])),
  );
}

for (const entry of ['file', 'drop', 'paste'] as const)
  test(`M12-24: opaque photo PNG via ${entry} sends JPEG and reopens byte-identical originals`, async () => {
    test.setTimeout(300000);
    const server = await imageModelServer();
    const session = await usageSession(server.endpoint);
    try {
      const { page } = session;
      const original = await syntheticPng(page);
      const buffer = Buffer.from(original, 'base64');
      expect(buffer.length).toBeGreaterThan(3_000_000);
      await input(page, `M12-24 ${entry} 合成参考小房子`);
      if (entry === 'file')
        await page.getByLabel('选择参考图', { exact: true }).setInputFiles({
          name: 'synthetic.png',
          mimeType: 'image/png',
          buffer,
        });
      else
        await page.locator('.image-input-form').evaluate(
          (element, { original, entry }) => {
            const transfer = new DataTransfer();
            transfer.items.add(
              new File([Uint8Array.from(atob(original), (c) => c.charCodeAt(0))], 'synthetic.png', {
                type: 'image/png',
              }),
            );
            element.dispatchEvent(
              entry === 'drop'
                ? new DragEvent('drop', { bubbles: true, dataTransfer: transfer })
                : new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }),
            );
          },
          { original, entry },
        );
      await expect(page.locator('.reference-cell')).toHaveCount(1);
      await page.getByRole('button', { name: '生成计划', exact: true }).click();
      const modal = page.locator('.image-plan-modal');
      await expect(modal.getByRole('button', { name: '开始搭建', exact: true })).toBeEnabled({ timeout: 60000 });
      const urls = referenceUrls(server.requests[0]!);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toMatch(/^data:image\/jpeg;base64,\/9j\//);
      const sentBytes = Buffer.from(urls[0]!.split(',')[1]!, 'base64').length;
      expect(sentBytes).toBeLessThan(buffer.length * 0.5);
      expect(server.requestBytes[0]).toBeLessThan(buffer.length * 0.5);
      const dimensions = await page.evaluate(async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        return [image.naturalWidth, image.naturalHeight];
      }, urls[0]!);
      expect(dimensions).toEqual([1568, 1176]);
      await modal.getByRole('button', { name: '开始搭建', exact: true }).click();
      const report = await completedReport(page);
      expect(report.reason).toBe('completed');
      expect(server.requestBytes.length).toBeGreaterThan(1);
      for (const bytes of server.requestBytes) expect(bytes).toBeLessThan(buffer.length * 0.5);
      console.log(
        'M12-24 request bytes',
        JSON.stringify({
          entry,
          originalBytes: buffer.length,
          mime: 'image/jpeg',
          sentBytes,
          requests: server.requestBytes,
          maxRequestRatio: Math.max(...server.requestBytes) / buffer.length,
        }),
      );
      await page.getByTestId('review-bar').getByRole('button', { name: '全部保留', exact: true }).click();
      const file = path.join(session.directory, `m12-24-${entry}.brkl`);
      await saveTo(session.app, file);
      await page.locator('.document-title').click();
      await page.keyboard.press('Control+s');
      await expect(page).not.toHaveTitle(/^•/);
      await expect
        .poll(() =>
          stat(file).then(
            () => true,
            () => false,
          ),
        )
        .toBe(true);
      const saved = unpackProject(await readFile(file));
      const references = Object.values(saved.doc!.referenceImages);
      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({ width: 4000, height: 3000 });
      expect(Buffer.from(saved.assets[String(references[0]!.path)]!).equals(buffer)).toBe(true);
      await page.evaluate(() => window.brickloopEditorTest.flush());
      await Promise.all([
        session.app.waitForEvent('close'),
        session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()),
      ]);
      Object.assign(session, await launchUsage(session.directory));
      await session.app.evaluate(({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
      }, file);
      await session.page.getByRole('menuitem', { name: '文件', exact: true }).click();
      await session.page.getByRole('menuitem', { name: /^打开/ }).click();
      await expect(session.page.locator('.brickloop-viewport')).toHaveAttribute(
        'data-part-count',
        String(report.partCount),
      );
      await session.page.keyboard.press('Control+k');
      await expect(session.page.locator('.image-report')).toBeVisible();
      const restored = session.page.locator('.ai-user img');
      await expect(restored).toHaveCount(1);
      const restoredBase64 = await restored.evaluate(async (element) => {
        const blob = await (await fetch((element as HTMLImageElement).src)).blob();
        return new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]!);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      });
      expect(Buffer.from(restoredBase64, 'base64').equals(buffer)).toBe(true);
    } finally {
      await closeUsage(session.app);
      await server.close();
      await cleanupUsage(session.directory);
    }
  });

test('M12-24: original alpha, huge images and flat PNG stay lossless; large unscaled PNG can use JPEG', async () => {
  test.setTimeout(180000);
  const server = await imageModelServer();
  const session = await usageSession(server.endpoint);
  try {
    const { page } = session;
    const singleAlpha = await syntheticPng(page, 4000, 3000, 254);
    const unscaled = await syntheticPng(page, 1024, 768);
    expect(unscaled.length).toBeGreaterThan(262144);
    const others = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d')!;
      return [
        { width: 800, height: 600, alpha: 254 },
        { width: 128, height: 128, alpha: 255 },
        { width: 4001, height: 4000, alpha: 254 },
      ].map(({ width, height, alpha }) => {
        canvas.width = width;
        canvas.height = height;
        context.fillStyle = '#6699cc';
        context.fillRect(0, 0, width, height);
        const pixel = context.getImageData(0, 0, 1, 1);
        pixel.data[3] = alpha;
        context.putImageData(pixel, width - 1, height - 1);
        const base64 = canvas.toDataURL('image/png').split(',')[1]!;
        const jpeg = canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
        canvas.width = canvas.height = 1;
        return { base64, jpeg };
      });
    });
    expect(others[1]!.jpeg.length).toBeGreaterThan(others[1]!.base64.length * 0.75);
    const originals = [singleAlpha, ...others.map((image) => image.base64), unscaled];
    await input(page, 'M12-24 透明与平涂参考图');
    await page.getByLabel('选择参考图', { exact: true }).setInputFiles(
      originals.map((base64, index) => ({
        name: `alpha-${index}.png`,
        mimeType: 'image/png',
        buffer: Buffer.from(base64, 'base64'),
      })),
    );
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    await expect(page.locator('.image-plan-modal')).toBeVisible({ timeout: 60000 });
    const urls = referenceUrls(server.requests[0]!);
    expect(urls).toHaveLength(5);
    for (const url of urls.slice(0, 4)) expect(url).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(urls[4]).toMatch(/^data:image\/jpeg;base64,\/9j\//);
    expect(urls[1]).toBe('data:image/png;base64,' + originals[1]);
    expect(urls[2]).toBe('data:image/png;base64,' + originals[2]);
    const decoded = await page.evaluate(
      async (urls) =>
        Promise.all(
          urls.map(async (url) => {
            const image = new Image();
            image.src = url;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext('2d')!;
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let minAlpha = 255;
            for (let index = 3; index < pixels.length; index += 4) minAlpha = Math.min(minAlpha, pixels[index]!);
            const result = { width: canvas.width, height: canvas.height, minAlpha };
            canvas.width = canvas.height = 1;
            return result;
          }),
        ),
      urls,
    );
    expect(decoded[0]).toEqual({ width: 1568, height: 1176, minAlpha: 255 });
    expect(decoded[1]).toEqual({ width: 800, height: 600, minAlpha: 254 });
    expect(decoded[2]).toEqual({ width: 128, height: 128, minAlpha: 255 });
    expect(decoded[3]).toMatchObject({ width: 1568, height: 1567 });
    expect(decoded[4]).toEqual({ width: 1024, height: 768, minAlpha: 255 });
    await page.locator('.image-plan-modal').getByRole('button', { name: '取消', exact: true }).click();
    await finished(page);
  } finally {
    await closeUsage(session.app);
    await server.close();
    await cleanupUsage(session.directory);
  }
});

test('M12-19: browser resizing preserves PNG alpha, JPEG orientation, and GIF/WebP support', async () => {
  test.setTimeout(120000);
  const server = await imageModelServer();
  const session = await usageSession(server.endpoint);
  try {
    const { page } = session;
    const originals = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 4000;
      canvas.height = 3000;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 2000, 1500);
      return ['image/png', 'image/jpeg', 'image/webp'].map((mime) => canvas.toDataURL(mime, 0.95).split(',')[1]!);
    });
    // Synthetic EXIF orientation 6 (90 degrees clockwise); the original JPEG bytes stay untouched.
    const exif = Buffer.alloc(36);
    exif.writeUInt16BE(0xffe1, 0);
    exif.writeUInt16BE(34, 2);
    exif.write('Exif\0\0', 4, 'ascii');
    exif.write('II', 10, 'ascii');
    exif.writeUInt16LE(42, 12);
    exif.writeUInt32LE(8, 14);
    exif.writeUInt16LE(1, 18);
    exif.writeUInt16LE(0x112, 20);
    exif.writeUInt16LE(3, 22);
    exif.writeUInt32LE(1, 24);
    exif.writeUInt16LE(6, 28);
    const jpeg = Buffer.from(originals[1]!, 'base64');
    const files = [
      { name: 'alpha.png', mimeType: 'image/png', buffer: Buffer.from(originals[0]!, 'base64') },
      {
        name: 'oriented.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]),
      },
      { name: 'reference.webp', mimeType: 'image/webp', buffer: Buffer.from(originals[2]!, 'base64') },
      // A code-generated one-pixel GIF, with a two-entry black/white palette.
      {
        name: 'pixel.gif',
        mimeType: 'image/gif',
        buffer: Buffer.from(
          '47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b',
          'hex',
        ),
      },
    ];
    await page.getByRole('button', { name: '按参考图生成', exact: true }).click();
    await page.getByLabel('选择参考图', { exact: true }).setInputFiles(files);
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    await expect(page.locator('.image-plan-modal')).toBeVisible({ timeout: 60000 });
    const urls = server.requests[0]!.messages.flatMap((message) =>
      typeof message.content === 'string'
        ? []
        : message.content.flatMap((block) => (block.image_url ? [block.image_url.url] : [])),
    );
    expect(urls.map((url) => url.slice(0, url.indexOf(';')))).toEqual([
      'data:image/png',
      'data:image/jpeg',
      'data:image/png',
      'data:image/gif',
    ]);
    const decoded = await page.evaluate(
      async (urls) =>
        Promise.all(
          urls.map(async (url) => {
            const image = new Image();
            image.src = url;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(image, 0, 0);
            return {
              width: canvas.width,
              height: canvas.height,
              alpha: ctx.getImageData(canvas.width - 1, canvas.height - 1, 1, 1).data[3],
            };
          }),
        ),
      urls,
    );
    expect(decoded).toEqual([
      { width: 1568, height: 1176, alpha: 0 },
      { width: 1176, height: 1568, alpha: 255 },
      { width: 1568, height: 1176, alpha: 0 },
      { width: 1, height: 1, alpha: 0 },
    ]);
    expect(urls[3] === 'data:image/gif;base64,' + files[3]!.buffer.toString('base64')).toBe(true);
    await page.locator('.image-plan-modal').getByRole('button', { name: '取消', exact: true }).click();
    await finished(page);
  } finally {
    await closeUsage(session.app);
    await server.close();
    await cleanupUsage(session.directory);
  }
});

test('M12-19: origin plans, colour rewrite, four large references under 3 MB, and original assets after reopening', async () => {
  test.setTimeout(300000);
  const server = await imageModelServer();
  server.controls.originPlan = true;
  server.controls.planColorsOnce = ['c:does-not-exist', 'Bright Green'];
  const session = await usageSession(server.endpoint);
  try {
    const { page } = session;
    const originals = await page.evaluate(() =>
      Array.from({ length: 4 }, (_, index) => {
        const canvas = document.createElement('canvas');
        canvas.width = 4000;
        canvas.height = 3000;
        const ctx = canvas.getContext('2d')!;
        const pixels = ctx.createImageData(canvas.width, canvas.height);
        pixels.data.fill(255);
        let seed = 126 + index;
        // Code-generated photo-like texture, with a clean border for foreground comparison.
        for (let y = 900; y < 2100; y++)
          for (let x = 1200; x < 2800; x++)
            for (let channel = 0; channel < 3; channel++) {
              seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
              pixels.data[(y * canvas.width + x) * 4 + channel] = seed >>> 24;
            }
        ctx.putImageData(pixels, 0, 0);
        return canvas.toDataURL('image/jpeg', 0.95).split(',')[1]!;
      }),
    );
    const buffers = originals.map((base64) => Buffer.from(base64, 'base64'));
    expect(buffers.reduce((sum, bytes) => sum + bytes.length, 0)).toBeGreaterThan(4_900_000);
    await page.getByRole('button', { name: '按参考图生成', exact: true }).click();
    await page.getByRole('textbox', { name: '描述', exact: true }).fill('M12-19 合成参考小房子');
    await page.getByLabel('选择参考图', { exact: true }).setInputFiles(
      buffers.map((buffer, index) => ({
        name: `synthetic-${index}.jpg`,
        mimeType: 'image/jpeg',
        buffer,
      })),
    );
    await page.getByText('固定视角', { exact: true }).click();
    for (const [index, view] of ['front', 'back', 'left', 'right'].entries())
      await page.getByRole('combobox', { name: `第 ${index + 1} 张图片视角`, exact: true }).selectOption(view);
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    const modal = page.locator('.image-plan-modal');
    await expect(modal.getByRole('button', { name: '开始搭建', exact: true })).toBeEnabled({ timeout: 60000 });
    const planning = server.requests.filter((request) => !request.tools?.length);
    expect(planning).toHaveLength(2);
    expect(JSON.stringify(planning[0])).toContain('Allowed palette colour IDs');
    expect(JSON.stringify(planning[1])).toContain('components.0.colors.0');
    expect(JSON.stringify(planning[1])).toContain('c:does-not-exist');
    expect(JSON.stringify(planning[1])).toContain('Allowed palette colour IDs');
    await expect(modal.getByRole('spinbutton', { name: '包围盒起点 Y', exact: true }).last()).toHaveValue('3');
    await expect(modal.locator('.plan-errors')).toHaveCount(0);
    await modal.getByRole('button', { name: '开始搭建', exact: true }).click();
    const report = await completedReport(page);
    expect(report.reason).toBe('completed');
    expect(report.plan!.components[1]!.boundingBox).toEqual({
      min: { x: 0, y: 3, z: 0 },
      max: { x: 6, y: 6, z: 6 },
    });
    expect(report.comparisons.length).toBeGreaterThanOrEqual(8);
    expect(server.requestBytes.length).toBeGreaterThan(8);
    for (const bytes of server.requestBytes) expect(bytes).toBeLessThan(3_000_000);
    const urls = (request: (typeof server.requests)[number]) =>
      request.messages.flatMap((message) =>
        typeof message.content === 'string'
          ? []
          : message.content.flatMap((block) => (block.image_url ? [block.image_url.url] : [])),
      );
    const firstUrls = urls(planning[0]!);
    expect(firstUrls).toHaveLength(4);
    expect(firstUrls.every((url) => url.startsWith('data:image/jpeg;base64,'))).toBe(true);
    const dimensions = await page.evaluate(
      async (urls) =>
        Promise.all(
          urls.map(async (url) => {
            const image = new Image();
            image.src = url;
            await image.decode();
            return [image.naturalWidth, image.naturalHeight];
          }),
        ),
      firstUrls,
    );
    expect(dimensions).toEqual(Array.from({ length: 4 }, () => [1568, 1176]));
    expect(urls(planning[1]!)).toHaveLength(4);
    expect(urls(planning[1]!).every((url, index) => url === firstUrls[index])).toBe(true);
    const firstRound = server.requests.filter((request) =>
      request.messages.some(
        (message) =>
          typeof message.content !== 'string' &&
          message.content.some((block) => block.text?.startsWith('Script workflow round: 1\n')),
      ),
    );
    expect(firstRound.length).toBeGreaterThan(1);
    for (const request of firstRound) {
      expect(urls(request)).toHaveLength(4);
      expect(urls(request).every((url, index) => url === firstUrls[index])).toBe(true);
    }
    for (const original of originals)
      expect(server.requests.some((request) => urls(request).includes('data:image/jpeg;base64,' + original))).toBe(
        false,
      );
    for (const comparison of report.comparisons)
      for (const image of comparison.images) {
        // A-136 changes the encoding, while the A-114 dimensions stay identical.
        const size = await session.app.evaluate(
          ({ nativeImage }, base64) => nativeImage.createFromBuffer(Buffer.from(base64, 'base64')).getSize(),
          image.base64,
        );
        expect([size.width, size.height]).toEqual([768, 576]);
      }
    await page.getByTestId('review-bar').getByRole('button', { name: '全部保留', exact: true }).click();
    const file = path.join(session.directory, 'm12-19-originals.brkl');
    await saveTo(session.app, file);
    await page.locator('.document-title').click();
    await page.keyboard.press('Control+s');
    await expect(page).not.toHaveTitle(/^•/);
    await expect
      .poll(() =>
        stat(file).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    const saved = unpackProject(await readFile(file));
    const references = Object.values(saved.doc!.referenceImages);
    expect(references).toHaveLength(4);
    for (const reference of references) {
      expect(reference).toMatchObject({ width: 4000, height: 3000 });
      const bytes = Buffer.from(saved.assets[String(reference.path)]!);
      expect(buffers.some((original) => original.equals(bytes))).toBe(true);
    }
    for (const original of buffers)
      expect(references.some((reference) => Buffer.from(saved.assets[String(reference.path)]!).equals(original))).toBe(
        true,
      );
    const sorted = [...server.requestBytes].sort((a, b) => a - b);
    const measurements = {
      originals: buffers.map((buffer) => buffer.length),
      requests: server.requestBytes,
      min: sorted[0],
      median: (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2,
      max: sorted.at(-1),
    };
    console.log('M12-19 request bytes', JSON.stringify(measurements));
    await writeFile(
      path.join(root, '.devdata/e2e-results/m12-19-request-bytes.json'),
      JSON.stringify(measurements, null, 2),
    );
    await writeFile(
      path.join(root, '.devdata/e2e-results/m12-19-planning-prompt.txt'),
      planning[0]!.messages
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content))
        .join('\n\n'),
    );
    await page.evaluate(() => window.brickloopEditorTest.flush());
    await Promise.all([
      session.app.waitForEvent('close'),
      session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()),
    ]);
    Object.assign(session, await launchUsage(session.directory));
    await session.app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, file);
    await session.page.getByRole('menuitem', { name: '文件', exact: true }).click();
    await session.page.getByRole('menuitem', { name: /^打开/ }).click();
    await expect(session.page.locator('.brickloop-viewport')).toHaveAttribute(
      'data-part-count',
      String(report.partCount),
    );
    await session.page.keyboard.press('Control+k');
    await expect(session.page.locator('.image-report')).toBeVisible();
    const restoredImages = session.page.locator('.ai-user img');
    await expect.poll(() => restoredImages.count()).toBeGreaterThanOrEqual(4);
    await expect
      .poll(() =>
        restoredImages.evaluateAll(
          (elements) =>
            elements.filter((element) => {
              const image = element as HTMLImageElement;
              return image.complete && image.naturalWidth === 4000 && image.naturalHeight === 3000;
            }).length,
        ),
      )
      .toBe(4);
  } finally {
    await closeUsage(session.app);
    await server.close();
    await cleanupUsage(session.directory);
  }
});

test('IMG-A112: palette repairs, direct start and actionable invalid-plan feedback', async () => {
  test.setTimeout(240000);
  const directory = await mkdtemp(path.join(root, '.devdata/tmp/m12-7-colors-'));
  const server = await imageModelServer();
  let app: ElectronApplication | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.BRICKLOOP_EVAL_API_KEY;
    app = await launchElectron({ args: [desktop], env: { ...env, BRICKLOOP_DATA_DIR: directory }, timeout: 45000 });
    const page = await app.firstWindow();

    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45000,
    });
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.evaluate(
      async ({ id, endpoint }) => {
        const snapshot = await window.brickloop.aiSaveProvider({
          id,
          name: '本机颜色测试',
          type: 'compatible',
          endpoint,
          model: 'offline-model',
          models: ['offline-model'],
          proxy: 'system',
          proxyUrl: '',
        });
        await window.brickloop.aiSaveSettings({ ...snapshot.settings, localOnly: true });
      },
      { id: randomUUID(), endpoint: server.endpoint },
    );
    await page.reload();
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 700));
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.keyboard.press('Control+k');
    server.controls.planOverride = structuredClone(fixturePlan);
    server.controls.planOverride.components[0]!.colors = ['bright-green', 'Dark Green', 'foo'];
    await input(page, '搭建配色小房子');
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    const modal = page.locator('.image-plan-modal');
    const start = modal.getByRole('button', { name: '开始搭建', exact: true });
    await expect(start).toBeEnabled();
    const repairs = modal.locator('.plan-color-repairs');
    await expect(repairs).toContainText('已把 3 处颜色换成色板中的颜色');
    await repairs.locator('summary').click();
    await expect(repairs).toContainText('bright-green →');
    await expect(repairs).toContainText('Dark Green →');
    await expect(repairs).toContainText('无法识别 foo，已删除');
    await start.click();
    const confirmed = await finished(page);
    expect(confirmed.reason).toBe('completed');
    expect(confirmed.plan!.components[0]!.colors).toEqual(['c:bright-green', 'c:dark-green']);

    // The same normalization also applies without confirmation, within project/custom scopes.
    for (const source of ['project', 'custom'] as const) {
      await page.evaluate(async (source) => {
        const snapshot = await window.brickloop.aiSnapshot();
        await window.brickloopEditorTest.imageStart({
          providerId: snapshot.settings.providers[0]!.id,
          model: 'offline-model',
          directStart: true,
          budget: { toolCalls: 400, durationMs: 60000 },
          input: {
            description: '搭建配色小房子',
            images: [],
            targetSize: 'medium',
            style: '',
            // Reuse the red sample document for project colors; overlapping fixture output is intentional here.
            priority: 'appearance',
            palette: { source, ...(source === 'custom' ? { colorIds: ['c:bright-red'] } : {}) },
            parts: { source: 'factory' },
          },
        });
      }, source);
      const report = await finished(page);
      expect(report.reason).toBe('completed');
      expect(report.plan!.components.every((c) => c.colors.length === 1 && c.colors[0] === 'c:bright-red')).toBe(true);
      await expect(modal).toBeHidden();
    }

    server.controls.planOverride = structuredClone(cathedralPlan);
    const last = server.controls.planOverride.components.at(-1)!;
    last.size.width = 0;
    last.boundingBox!.max.x = last.boundingBox!.min.x;
    await page.evaluate(() => window.brickloopEditorTest.action('file.new'));
    await input(page, '检查长计划的尺寸');
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    await expect(start).toBeDisabled();
    const reason = modal
      .locator('.ant-modal-footer')
      .getByRole('button', { name: '第 16 个部件：宽度必须大于 0（点击定位）', exact: true });
    await expect(reason).toBeInViewport();
    await expect(start).toBeInViewport();
    await reason.click();
    const row = modal.locator('tbody tr').last();
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport();
    await row.getByRole('spinbutton', { name: '宽（格）', exact: true }).fill('4');
    await expect(start).toBeEnabled();
    await expect(modal.locator('.plan-errors')).toHaveCount(0);
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    await finished(page);
  } finally {
    if (app) await closeImageTest(app);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('IMG-01/02/04/05 and MOS-01: workflow UI, real host, transaction and factory mosaic', async () => {
  test.setTimeout(360000);
  await mkdir(evidence, { recursive: true });
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/image-')),
    server = await imageModelServer();
  let app: ElectronApplication | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.BRICKLOOP_EVAL_API_KEY;
    app = await launchElectron({ args: [desktop], env: { ...env, BRICKLOOP_DATA_DIR: directory }, timeout: 45000 });
    const page = await app.firstWindow(),
      errors: string[] = [];

    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45000,
    });
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.evaluate(
      async ({ id, endpoint }) => {
        const snapshot = await window.brickloop.aiSaveProvider({
          id,
          name: '本机测试模型',
          type: 'compatible',
          endpoint,
          model: 'offline-model',
          models: ['offline-model'],
          proxy: 'system',
          proxyUrl: '',
          prices: { input: 1, output: 2, cacheRead: 0.1 },
        });
        await window.brickloop.aiSaveSettings({ ...snapshot.settings, localOnly: true });
      },
      { id: randomUUID(), endpoint: server.endpoint },
    );
    await page.reload();
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.keyboard.press('Control+k');
    await input(page, '红色屋顶的 6×6 小房子');
    const refs = ['01-front.png', '11-right.png', '02-front.png'].map((name) =>
      path.join(root, 'packages/ai/test/ai-eval/references', name),
    );
    await page.getByLabel('选择参考图', { exact: true }).setInputFiles(refs[0]!);
    for (const [index, kind] of ['drop', 'paste'].entries()) {
      const file = refs[index + 1]!;
      await expect(page.locator('.reference-cell')).toHaveCount(index + 1);
      await page.locator('.image-input-form').evaluate(
        (element, data) => {
          const transfer = new DataTransfer();
          transfer.items.add(
            new File([Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0))], data.name, { type: 'image/png' }),
          );
          element.dispatchEvent(
            data.kind === 'drop'
              ? new DragEvent('drop', { bubbles: true, dataTransfer: transfer })
              : new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }),
          );
        },
        { name: path.basename(file), base64: (await readFile(file)).toString('base64'), kind },
      );
    }
    await expect(page.locator('.reference-cell')).toHaveCount(3);
    for (const [index, view] of ['前视图', '右视图', '顶视图'].entries()) {
      await page.getByRole('combobox', { name: `第 ${index + 1} 张图片视角` }).selectOption({ label: view });
    }
    await capture(app, page, 'input');
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    await expect(page.getByRole('button', { name: '开始搭建', exact: true })).toBeVisible({ timeout: 30000 });
    // A plan arriving while paused must leave the task controls reachable.
    await page.evaluate(() => window.brickloop.aiImageControl('pause'));
    await expect(page.getByRole('button', { name: '开始搭建', exact: true })).toBeHidden();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect(page.getByRole('button', { name: '开始搭建', exact: true })).toBeVisible();
    await capture(app, page, 'plan');
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(0);
    await page.locator('.image-plan-modal').getByRole('button', { name: '取消', exact: true }).click();
    await finished(page);
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length)).toBe(0);
    await expect(page.getByRole('region', { name: '本轮修改审阅' })).toHaveCount(0);

    // IMG-01: editable plan, text only, a single real editor transaction.
    await input(page, '红色屋顶的 6×6 小房子');
    await page.getByRole('combobox', { name: '零件范围', exact: true }).click();
    await page.locator('.ant-select-dropdown:visible').getByText('工厂件', { exact: true }).click();
    for (let i = 0; i < 3; i++) await page.locator('.image-input-modal .reference-remove').first().click();
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    await expect(page.getByRole('button', { name: '开始搭建', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '添加部件', exact: true }).click();
    await expect(page.locator('.image-plan-table tbody tr')).toHaveCount(3);
    await page.getByRole('button', { name: '删除部件', exact: true }).last().click();
    await dragPlanRow(page);
    await expect(page.getByRole('textbox', { name: '部件名称', exact: true }).first()).toHaveValue('屋顶');
    await page.getByRole('button', { name: '上移', exact: true }).last().click();
    await page.getByRole('textbox', { name: '部件名称', exact: true }).first().fill('房屋主体');
    await page.getByRole('button', { name: '开始搭建', exact: true }).click();
    const textReport = await finished(page);
    expect(textReport.reason).toBe('completed');
    expect(textReport.validation).toEqual({ checked: true, issues: [] });
    expect(textReport.plan?.components[0]?.name).toBe('房屋主体');
    expect(textReport.partCount).toBe(2);
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.snapshot().state.locked)).toBeNull();
    await page.getByRole('menuitem', { name: '工具', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '马赛克…', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await page.getByTestId('review-bar').getByRole('button', { name: '撤销整轮', exact: true }).click();
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(0);

    // IMG-02: single reference, fixed task card, pause/resume/interjection, report and comparison previews.
    server.controls.delay = 800;
    await input(page, '按参考图搭建小汽车，分为车身和车轮');
    await page
      .getByLabel('选择参考图', { exact: true })
      .setInputFiles(path.join(root, 'packages/ai/test/ai-eval/references/05-front.png'));
    await page.getByRole('combobox', { name: '第 1 张图片视角' }).selectOption({ label: '前视图' });
    await page.getByRole('checkbox', { name: '跳过计划确认，直接开始', exact: true }).check();
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    await expect(page.locator('.image-task-card .image-comparison')).toBeVisible({
      timeout: 60000,
    });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().state.locked)).toBeNull();
    await page.evaluate(() => window.brickloopEditorTest.preset('front'));
    await page.getByRole('textbox', { name: '插话', exact: true }).fill('车身保持红色');
    await page.getByRole('textbox', { name: '插话', exact: true }).press('Enter');
    await capture(app, page, 'task-checking');
    await page.getByRole('button', { name: '继续', exact: true }).click();
    server.controls.delay = 0;
    const imageReport = await finished(page);
    expect(imageReport.reason).toBe('completed');
    expect(imageReport.components).toHaveLength(2);
    expect(imageReport.comparisons.length).toBeGreaterThan(0);
    expect(imageReport.comparisons[0]?.images).toHaveLength(2);
    expect(imageReport.interjections).toContain('车身保持红色');
    expect(JSON.stringify(server.requests.at(-1))).toContain('车身保持红色');
    await capture(app, page, 'report', '.image-report');

    // IMG-05: the report opens the existing export flow; @brickloop/io reads the artifact back.
    const ioPath = path.join(directory, 'image-result.io');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, ioPath);
    const before = await page.evaluate(() => window.brickloopEditorTest.expanded());
    const colors = await page.evaluate(() => window.brickloop.catalogColors());
    await page.getByRole('button', { name: '导出 .io…', exact: true }).last().click();
    await page.getByRole('button', { name: '导出', exact: true }).click();
    await expect
      .poll(() =>
        stat(ioPath).then(
          (s) => s.size,
          () => 0,
        ),
      )
      .toBeGreaterThan(0);
    const imported = importIo(new Uint8Array(await readFile(ioPath)), { colors: colors.all });
    expect(imported.doc).not.toBeNull();
    const rows = expandInstances(imported.doc!);
    expect(rows.length).toBe(before.length);
    expect(rows.map((r) => r.colorId).sort()).toEqual(before.map((r) => r.colorId).sort());
    await page.getByRole('button', { name: '关闭', exact: true }).last().click();

    // IMG-04: exactly 30 charged calls; incomplete work remains a valid undoable document.
    await page.evaluate(() => window.brickloopEditorTest.action('file.new'));
    server.controls.budget = true;
    await input(page, '测试操作预算');
    await page.locator('.image-input-modal details summary').click();
    await page.getByRole('spinbutton', { name: '总操作安全上限', exact: true }).fill('30');
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    const budgetReport = await finished(page);
    expect(budgetReport.reason).toBe('tool_budget');
    expect(budgetReport.toolCalls).toBe(30);
    expect(budgetReport.unfinished.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length)).toBe(1);
    await page.getByTestId('review-bar').getByRole('button', { name: '撤销整轮', exact: true }).click();
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(0);

    // Stop during a pause merges completed copy changes and enters review.
    server.controls.budget = false;
    server.controls.delay = 800;
    await input(page, '搭建并停止');
    await page.getByRole('spinbutton', { name: '总操作安全上限', exact: true }).fill('400');
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.previewCounts().parts), { timeout: 30000 })
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.locator('.image-task-card').getByRole('button', { name: '停止', exact: true }).click();
    expect((await finished(page)).reason).toBe('user_stopped');
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().state.locked)).toBeNull();
    await page.getByTestId('review-bar').getByRole('button', { name: '撤销整轮', exact: true }).click();
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(0);

    // MOS-01: 32×32 grid, factory palette, deterministic layout, one transaction each time.
    const layouts: unknown[] = [];
    for (let pass = 0; pass < 2; pass++) {
      await page.getByRole('menuitem', { name: '工具', exact: true }).click();
      await page.getByRole('menuitem', { name: '马赛克…', exact: true }).click();
      if (pass === 0) await page.getByLabel('选择图片', { exact: true }).setInputFiles(refs[0]!);
      await expect(page.getByLabel('像素网格预览', { exact: true })).toBeVisible({ timeout: 45000 });
      if (pass === 0) {
        await page.getByRole('combobox', { name: '零件样式', exact: true }).click();
        await page.locator('.ant-select-dropdown:visible').getByText('圆板', { exact: true }).click();
        await expect(page.getByRole('checkbox', { name: '合并同色相邻格' })).toBeDisabled();
        await expect(page.getByLabel('像素网格预览', { exact: true })).toBeVisible();
        await page.getByRole('checkbox', { name: '抖动', exact: true }).check();
        await expect(page.getByLabel('像素网格预览', { exact: true })).toBeVisible();
        await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
        await page.getByRole('combobox', { name: '零件样式', exact: true }).click();
        await page.locator('.ant-select-dropdown:visible').getByText('平滑板', { exact: true }).click();
        await page.getByRole('checkbox', { name: '抖动', exact: true }).uncheck();
        await expect(page.getByLabel('像素网格预览', { exact: true })).toBeVisible();
        await capture(app, page, 'mosaic');
      }
      const history = await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length);
      await page.getByRole('button', { name: '生成', exact: true }).click();
      await expect(page.locator('.mosaic-modal')).toBeHidden();
      const result = await page.evaluate(async () => ({
        rows: window.brickloopEditorTest
          .expanded()
          .map((r) => ({ partId: r.partId, colorId: r.colorId, matrix: r.matrix })),
        catalog: await window.brickloop.assemblyCatalog(),
        history: window.brickloopEditorTest.snapshot().history.length,
      }));
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.history).toBe(history + 1);
      expect(await page.evaluate(() => window.brickloopEditorTest.review())).toBeNull();
      for (const row of result.rows) {
        expect(result.catalog.colors).toContain(row.colorId);
        expect(result.catalog.parts.find((p) => p.id === row.partId)?.colors).toContain(row.colorId);
      }
      layouts.push(result.rows);
      await page.evaluate(() => window.brickloopEditorTest.action('edit.undo'));
      expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(0);
    }
    expect(layouts[0]).toEqual(layouts[1]);
    expect(errors).toEqual([]);
  } finally {
    if (app) await closeImageTest(app);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('IMG-08: one main script builds a tower building with 1500+ parts in five rounds, repairs collisions, and records a thumbnail timeline', async () => {
  test.setTimeout(600000);
  const shots = path.join(root, '.devdata/m9-4-shots');
  await mkdir(shots, { recursive: true });
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/tower-'));
  const server = await imageModelServer();
  let app: ElectronApplication | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.BRICKLOOP_EVAL_API_KEY;
    app = await launchElectron({ args: [desktop], env: { ...env, BRICKLOOP_DATA_DIR: directory }, timeout: 45000 });
    const page = await app.firstWindow(),
      errors: string[] = [];

    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45000,
    });
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.evaluate(
      async ({ id, endpoint }) => {
        const snapshot = await window.brickloop.aiSaveProvider({
          id,
          name: '本机脚本化模型',
          type: 'compatible',
          endpoint,
          model: 'offline-model',
          models: ['offline-model'],
          proxy: 'system',
          proxyUrl: '',
          prices: { input: 1, output: 2, cacheRead: 0.1 },
        });
        await window.brickloop.aiSaveSettings({ ...snapshot.settings, localOnly: true });
      },
      { id: randomUUID(), endpoint: server.endpoint },
    );
    await page.reload();
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('Control+k');
    await input(page, '搭建带塔楼的建筑：黄色墙体、红色屋顶，完整主体、屋顶平台和塔楼。至少 1500 件，最多 5 轮。');
    await page
      .getByLabel('选择参考图', { exact: true })
      .setInputFiles(path.join(root, 'packages/ai/test/ai-eval/references/01-front.png'));
    await expect(page.getByRole('spinbutton', { name: '迭代轮数', exact: true })).toBeHidden();
    await expect(page.locator('.image-input-modal')).toContainText('对比指标连续两轮不再提升且部件完整时会自动结束');
    await page.locator('.image-input-modal details summary').click();
    await expect(page.getByRole('spinbutton', { name: '迭代轮数', exact: true })).toHaveValue('20');
    await expect(page.getByRole('spinbutton', { name: '总操作安全上限', exact: true })).toHaveValue('2000');
    await expect(page.getByRole('spinbutton', { name: '任务时长（分钟）', exact: true })).toHaveValue('120');
    await expect(page.locator('.image-input-modal')).toContainText('全部零件（概念设计）');
    await expect(page.locator('.image-input-modal')).toContainText('可搭建优先');
    await page.getByRole('spinbutton', { name: '迭代轮数', exact: true }).fill('5');
    await page.screenshot({ path: path.join(shots, '01-dialog.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    const modal = page.locator('.image-plan-modal');
    await expect(modal.getByRole('button', { name: '开始搭建', exact: true })).toBeVisible();
    await expect(modal.getByRole('combobox', { name: '设计类别', exact: true })).toHaveCount(3);
    await expect(modal.getByRole('spinbutton', { name: '包围盒起点 X', exact: true }).last()).toHaveValue('6');
    await modal.getByRole('combobox', { name: '设计类别', exact: true }).first().selectOption('plants');
    await modal.getByRole('combobox', { name: '设计类别', exact: true }).first().selectOption('buildings');
    await modal.getByRole('spinbutton', { name: '包围盒起点 X', exact: true }).last().fill('6');
    await page.screenshot({ path: path.join(shots, '02-plan.png'), animations: 'disabled' });
    server.controls.delay = 400;
    await modal.getByRole('button', { name: '开始搭建', exact: true }).click();
    await expect
      .poll(() => page.locator('.image-task-card .image-round-timeline li').count(), { timeout: 240000 })
      .toBeGreaterThanOrEqual(3);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible();
    await page.evaluate(() =>
      window.brickloopEditorTest.restoreCamera({
        mode: 'perspective',
        fov: 45,
        position: [1000, -1050, -900],
        target: [200, -312, 160],
        up: [0, -1, 0],
      }),
    );
    await expect(page.locator('.preview-empty')).toBeHidden();
    await page.screenshot({ path: path.join(shots, '03-timeline.png'), animations: 'disabled' });
    server.controls.delay = 0;
    await page.getByRole('button', { name: '继续', exact: true }).click();
    const report = await finished(page, 240000);
    await writeFile(path.join(shots, 'report.json'), JSON.stringify(report, null, 2));
    expect(report.reason).toBe('completed');
    expect(report.rounds).toHaveLength(5);
    expect(report.partCount).toBeGreaterThanOrEqual(1500);
    expect(report.colorCount).toBe(2);
    expect(report.components.map((c) => c.componentId)).toEqual(['body', 'roof', 'tower']);
    expect(report.rounds.slice(0, 4).every((r) => r.issues.some((i) => i.kind === 'collision'))).toBe(true);
    expect(report.validation.checked).toBe(true);
    expect(report.validation.issues.filter((i) => ['collision', 'floating'].includes(i.kind))).toEqual([]);
    expect(report.unfinished).toEqual([]);
    expect(report.script?.code).toContain("submodel('tower'");
    expect(report.rounds.every((r) => r.partCount >= 1500 && r.comparisons.length === 1 && r.images.length === 2)).toBe(
      true,
    );
    await expect(page.locator('.image-report .image-round-timeline li')).toHaveCount(5);
    expect(
      await page
        .locator('.image-report .image-round-timeline img')
        .evaluateAll((images) =>
          images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0),
        ),
    ).toBe(true);
    await page.locator('.image-report .image-script-source summary').click();
    await expect(page.locator('.image-report .image-script-source pre')).toContainText("submodel('tower'");
    expect(report.summaryZh).toContain('共 5 轮');
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length)).toBe(1);
    const rounds = server.requests.filter((r) => r.tools?.length && r.messages.every((m) => m.role !== 'tool'));
    expect(rounds).toHaveLength(5);
    expect(rounds.every((r) => JSON.stringify(r.messages).includes('Design guide: buildings'))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    if (app) await closeImageTest(app);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('ai:eval runner smoke: synthetic credential stays out of output and the isolated profile is removed', async () => {
  test.setTimeout(240000);
  const server = await imageModelServer(),
    previous = process.env.BRICKLOOP_EVAL_API_KEY;
  const key = `offline-eval-${randomUUID()}`;
  process.env.BRICKLOOP_EVAL_API_KEY = key;
  let output: string | undefined;
  try {
    output = await runEvaluation([
      '--provider',
      'compatible',
      '--model',
      'offline-model',
      '--base-url',
      server.endpoint,
      '--cases',
      'text-01',
    ]);
    const json = await readFile(path.join(output, 'results.json'), 'utf8'),
      markdown = await readFile(path.join(output, 'summary.md'), 'utf8');
    expect(json).not.toContain(key);
    expect(markdown).not.toContain(key);
    const result = JSON.parse(json) as { records: { partCount: number; connectedComponents: number }[] };
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ partCount: 2, connectedComponents: 1 });
    expect(
      await stat(path.join(root, '.devdata/ai-eval-profile')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.BRICKLOOP_EVAL_API_KEY;
    else process.env.BRICKLOOP_EVAL_API_KEY = previous;
    await server.close();
    if (output) await rm(output, { recursive: true, force: true });
  }
});

test('IMG-06/07/03: inferred views, designer overrides, fixed views and four-view IoU', async () => {
  test.setTimeout(360000);
  const shots = path.join(root, '.devdata/m8-4-shots');
  await mkdir(shots, { recursive: true });
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/view-modes-'));
  const server = await imageModelServer();
  let app: ElectronApplication | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.BRICKLOOP_EVAL_API_KEY;
    app = await launchElectron({ args: [desktop], env: { ...env, BRICKLOOP_DATA_DIR: directory }, timeout: 45000 });
    const page = await app.firstWindow();
    const errors: string[] = [];

    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45000,
    });
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.evaluate(
      async ({ id, endpoint }) => {
        const snapshot = await window.brickloop.aiSaveProvider({
          id,
          name: '本机脚本化模型',
          type: 'compatible',
          endpoint,
          model: 'offline-model',
          models: ['offline-model'],
          proxy: 'system',
          proxyUrl: '',
          prices: { input: 1, output: 2, cacheRead: 0.1 },
        });
        await window.brickloop.aiSaveSettings({ ...snapshot.settings, localOnly: true });
      },
      { id: randomUUID(), endpoint: server.endpoint },
    );
    await page.reload();
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('Control+k');
    const buffers = await Promise.all(
      ['01-front.png', '11-right.png'].map((name) =>
        readFile(path.join(root, 'packages/ai/test/ai-eval/references', name)),
      ),
    );
    const detail = await page.evaluate(async (base64) => {
      const image = new window.Image();
      image.src = 'data:image/png;base64,' + base64;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      canvas
        .getContext('2d')!
        .drawImage(image, image.width / 3, image.height / 3, image.width / 3, image.height / 3, 0, 0, 128, 128);
      return canvas.toDataURL('image/png').split(',')[1]!;
    }, buffers[0]!.toString('base64'));
    const files = [
      { name: '正面.png', mimeType: 'image/png', buffer: buffers[0]! },
      { name: '左侧.png', mimeType: 'image/png', buffer: buffers[1]! },
      { name: '局部特写.png', mimeType: 'image/png', buffer: Buffer.from(detail, 'base64') },
    ];
    const choose = async (label: string, value: string) => {
      await page.getByRole('combobox', { name: label, exact: true }).selectOption({ label: value });
    };
    await input(page, '按多角度参考搭建小房子，局部特写用于理解细节');
    await page.getByLabel('选择参考图', { exact: true }).setInputFiles(files);
    await expect(page.getByRole('radio', { name: '不固定视角', exact: true })).toBeChecked();
    await page.getByText('固定视角', { exact: true }).click();
    await expect(page.getByRole('button', { name: '生成计划', exact: true })).toBeDisabled();
    await page.getByText('不固定视角', { exact: true }).click();
    await page.screenshot({ path: path.join(shots, '01-view-mode-input.png'), animations: 'disabled' });
    server.controls.compareExcluded = true;
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    const modal = page.locator('.image-plan-modal');
    await expect(page.locator('.image-input-modal')).toBeHidden();
    await expect(modal.getByText('推测：前视图 · 0.90', { exact: true })).toBeVisible();
    await expect(modal.getByText('推测：左视图 · 0.80', { exact: true })).toBeVisible();
    await expect(modal.getByText('推测：非标准视角 · 0.20', { exact: true })).toBeVisible();
    await expect(modal.getByText('推测：左视图 · 0.80', { exact: true })).toHaveAttribute(
      'title',
      '主体左侧轮廓完整可见。',
    );
    await page.screenshot({ path: path.join(shots, '02-plan-view-estimates.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '开始搭建', exact: true }).click();
    const inferred = await finished(page);
    expect(inferred.reason).toBe('completed');
    expect(inferred.references.map((r) => [r.view, r.source, r.confidence])).toEqual([
      ['front', 'ai', 0.9],
      ['left', 'ai', 0.8],
      [null, 'excluded', null],
    ]);
    expect(inferred.comparisons.every((c) => c.inferredView && ['front', 'left'].includes(c.view))).toBe(true);
    expect(inferred.references[2]?.iou).toBeNull();
    await expect(page.locator('.image-reference-report').getByText('未参与对比', { exact: true })).toBeVisible();
    expect(JSON.stringify(server.requests)).toContain('REFERENCE_NOT_COMPARABLE');
    expect(inferred.summaryZh).toContain('AI 推测视角 · 0.90');

    // Confirmation choices must affect execution, including promoting a low-confidence close-up.
    server.controls.compareExcluded = false;
    await page.evaluate(() => window.brickloopEditorTest.action('file.new'));
    await input(page, '由设计师修改参考视角');
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    await expect(page.getByRole('button', { name: '开始搭建', exact: true })).toBeVisible();
    await expect(page.locator('.image-input-modal')).toBeHidden();
    await choose('第 1 张参考图对比视角', '不参与对比');
    await choose('第 2 张参考图对比视角', '右视图');
    await choose('第 3 张参考图对比视角', '顶视图');
    await page.getByRole('button', { name: '开始搭建', exact: true }).click();
    const overridden = await finished(page);
    expect(overridden.reason).toBe('completed');
    expect(overridden.references.map((r) => [r.view, r.source])).toEqual([
      [null, 'excluded'],
      ['right', 'designer'],
      ['top', 'designer'],
    ]);
    expect(overridden.comparisons.every((c) => !c.inferredView && ['right', 'top'].includes(c.view))).toBe(true);

    // IMG-07, then IMG-03: fixed front/top and four designer views use no estimates.
    for (const labels of [
      ['前视图', '顶视图'],
      ['前视图', '后视图', '左视图', '右视图'],
    ]) {
      // IMG-03 uses four views of the scripted target, so completing the roof should improve the match.
      const references =
        labels.length === 4
          ? await page.evaluate(async () => {
              const result = (await window.brickloopEditorTest.aiTool('render_views', {
                views: ['front', 'back', 'left', 'right'],
                width: 192,
                height: 192,
                transparent: true,
              })) as ToolResult;
              if (!result.ok) throw new Error('Target reference render failed');
              return (result.data as { images: { base64: string }[] }).images.map((image) => image.base64);
            })
          : buffers.map((buffer) => buffer.toString('base64'));
      await page.evaluate(() => window.brickloopEditorTest.action('file.new'));
      await input(page, '按固定视角搭建小房子');
      while (await page.locator('.image-input-modal .reference-remove').count())
        await page.locator('.image-input-modal .reference-remove').first().click();
      await page.getByLabel('选择参考图', { exact: true }).setInputFiles(
        labels.map((_, index) => ({
          name: `固定视角${index + 1}.png`,
          mimeType: 'image/png',
          buffer: Buffer.from(references[index % references.length]!, 'base64'),
        })),
      );
      await page.getByText('固定视角', { exact: true }).click();
      await expect(page.getByRole('button', { name: '生成计划', exact: true })).toBeDisabled();
      for (const [index, view] of labels.entries()) await choose(`第 ${index + 1} 张图片视角`, view);
      const requestStart = server.requests.length;
      await page.getByRole('button', { name: '生成计划', exact: true }).click();
      await expect(page.getByRole('button', { name: '开始搭建', exact: true })).toBeVisible();
      expect(JSON.stringify(server.requests[requestStart])).toContain('Do not estimate views');
      await expect(modal.locator('.plan-view-estimate').filter({ hasText: '推测：' })).toHaveCount(0);
      await page.getByRole('button', { name: '开始搭建', exact: true }).click();
      const report = await finished(page);
      expect(report.reason).toBe('completed');
      expect(report.references.map((r) => r.view)).toEqual(
        labels.length === 2 ? ['front', 'top'] : ['front', 'back', 'left', 'right'],
      );
      expect(report.comparisons.every((c) => !c.inferredView)).toBe(true);
      for (const reference of report.references) {
        expect(reference.source).toBe('designer');
        const first = report.comparisons.find((c) => c.referenceId === reference.referenceId)!;
        expect(reference.iou).not.toBeNull();
        if (labels.length === 4) expect(reference.iou).toBeGreaterThanOrEqual(first.iou);
      }
    }
    // Legacy callers have no viewMode and still send unknown through the actual IPC boundary.
    await page.evaluate(() => window.brickloopEditorTest.action('file.new'));
    await page.evaluate(async (base64) => {
      const snapshot = await window.brickloop.aiSnapshot();
      await window.brickloopEditorTest.imageStart({
        providerId: snapshot.settings.providers[0]!.id,
        model: 'offline-model',
        directStart: true,
        budget: { toolCalls: 400, durationMs: 60000 },
        input: {
          description: '兼容旧版参考图请求',
          images: [{ name: '旧版参考图.png', image: { type: 'image', mime: 'image/png', base64 }, view: 'unknown' }],
          targetSize: 'medium',
          palette: { source: 'factory' },
          parts: { source: 'factory' },
          style: '',
        },
      });
    }, buffers[0]!.toString('base64'));
    const legacy = await finished(page);
    expect(legacy.reason).toBe('completed');
    expect(legacy.references[0]).toMatchObject({ view: 'front', source: 'ai', confidence: 0.9 });
    expect(legacy.comparisons.every((c) => c.inferredView && c.view === 'front')).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    if (app) await closeImageTest(app);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
