import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { unpackProject } from '../../../packages/io/src/project';
import { imageModelServer } from './image-model-fixture';
import {
  usageSession,
  launchUsage,
  saveTo,
  closeUsage,
  cleanupUsage,
  reference,
  dropFile,
  planAndStart,
  finishImageFlow,
  completedReport,
  shot,
} from './real-usage-helpers';

test('M12-10 / A-114: large references stay small across rounds, reports and saved history', async () => {
  test.setTimeout(240000);
  const server = await imageModelServer();
  const session = await usageSession(server.endpoint);
  try {
    const { page } = session;
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 2400;
      canvas.height = 1800;
      const ctx = canvas.getContext('2d')!;
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      pixels.data.fill(255);
      let seed = 114;
      // A noisy subject with a clean background resists PNG compression, like a photo.
      for (let y = 300; y < 1500; y++)
        for (let x = 400; x < 2000; x++)
          for (let channel = 0; channel < 3; channel++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            pixels.data[(y * canvas.width + x) * 4 + channel] = seed >>> 24;
          }
      ctx.putImageData(pixels, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    const original = Buffer.from(base64, 'base64');
    expect(original.length).toBeGreaterThan(3_000_000);
    expect(original.length).toBeLessThan(10_000_000);
    await page.getByRole('button', { name: '按参考图生成', exact: true }).click();
    await page.getByLabel('选择参考图', { exact: true }).setInputFiles({
      name: 'synthetic-2400x1800.png',
      mimeType: 'image/png',
      buffer: original,
    });
    await page.getByRole('combobox', { name: '第 1 张图片视角', exact: true }).selectOption('front');
    await planAndStart(page, 'M12-10 大尺寸合成参考的小房子');
    const report = await completedReport(page);
    expect(report.reason).toBe('completed');
    expect(report.rounds.length).toBeGreaterThanOrEqual(2);
    expect(report.comparisons.length).toBeGreaterThanOrEqual(2);
    const blocks = (request: (typeof server.requests)[number]) =>
      request.messages.flatMap((message) => (typeof message.content === 'string' ? [] : message.content));
    const urls = (request: (typeof server.requests)[number]) =>
      blocks(request).flatMap((block) => (block.image_url ? [block.image_url.url] : []));
    const inRound = (request: (typeof server.requests)[number], round: number) =>
      blocks(request).some((block) => block.text?.startsWith('Script workflow round: ' + round + '\n'));
    const originalUrl = 'data:image/png;base64,' + base64;
    // A-126 originally resized this reference to a single 1568×1176 PNG for compatible providers.
    // A-132: this opaque non-JPEG reference now uses JPEG at quality 0.9 after resizing (saving at least 25%).
    const preparedUrl = await page.evaluate(async (originalUrl) => {
      const image = new Image();
      image.src = originalUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 1568;
      canvas.height = 1176;
      const context = canvas.getContext('2d')!;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, 1568, 1176);
      return canvas.toDataURL('image/jpeg', 0.9);
    }, originalUrl);
    expect(urls(server.requests.find((request) => !request.tools?.length)!)).toContain(preparedUrl);
    expect(urls(server.requests.find((request) => inRound(request, 1))!)).toContain(preparedUrl);
    const secondRound = server.requests.flatMap((request, index) =>
      inRound(request, 2) ? [{ request, bytes: server.requestBytes[index]! }] : [],
    );
    expect(secondRound.length).toBeGreaterThan(0);
    const imageBytes = secondRound.map(({ request }) =>
      Buffer.byteLength(JSON.stringify(blocks(request).filter((block) => block.image_url))),
    );
    for (const [index, { request, bytes }] of secondRound.entries()) {
      expect(urls(request)).not.toContain(originalUrl);
      expect(imageBytes[index]).toBeLessThan(3_000_000);
      expect(bytes).toBeLessThan(3_000_000);
    }
    // A-136 permits JPEG as well as PNG for model-facing images. Decode both
    // formats while retaining the exact A-114 size and original-asset checks.
    const imageSize = (bytes: Uint8Array) =>
      session.app.evaluate(({ nativeImage }, base64) => {
        const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
        if (image.isEmpty()) throw new Error('Invalid stored model image');
        return image.getSize();
      }, Buffer.from(bytes).toString('base64'));
    for (const comparison of report.comparisons) {
      expect(comparison.images).toHaveLength(2);
      for (const image of comparison.images)
        expect(await imageSize(Buffer.from(image.base64, 'base64'))).toEqual({ width: 768, height: 576 });
    }
    const visibleComparisons = async () => {
      const collapsed = session.page.locator('.image-report .image-round-timeline details:not([open]) > summary');
      while (await collapsed.count()) await collapsed.first().click();
      const images = session.page.locator('.image-report .image-round-timeline img');
      await expect(images.first()).toBeVisible();
      expect(await images.count()).toBeGreaterThanOrEqual(report.comparisons.length * 2);
      await expect
        .poll(() =>
          images.evaluateAll((elements) =>
            elements.every((element) => {
              const image = element as HTMLImageElement;
              return (
                image.complete && image.naturalWidth > 0 && Math.max(image.naturalWidth, image.naturalHeight) <= 768
              );
            }),
          ),
        )
        .toBe(true);
    };
    await visibleComparisons();
    await page.getByTestId('review-bar').getByRole('button', { name: '全部保留', exact: true }).click();
    const file = path.join(session.directory, 'large-reference.brkl');
    await saveTo(session.app, file);
    await page.locator('.document-title').click();
    await page.keyboard.press('Control+s');
    await expect(page).not.toHaveTitle(/^•/);
    await expect
      .poll(() =>
        readFile(file).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    const savedBytes = await readFile(file);
    expect(savedBytes.length).toBeLessThan(10_000_000);
    expect(savedBytes.length - original.length).toBeLessThan(3_000_000);
    const saved = unpackProject(savedBytes);
    expect(saved.doc).toBeDefined();
    const references = Object.values(saved.doc!.referenceImages);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ width: 2400, height: 1800 });
    expect(Buffer.from(saved.assets[String(references[0]!.path)]!)).toEqual(original);
    const imageAssets = Object.entries(saved.assets).filter(([name]) => name.startsWith('assets/images/'));
    expect(imageAssets.filter(([, bytes]) => Buffer.from(bytes).equals(original))).toHaveLength(1);
    for (const [name, bytes] of imageAssets) {
      if (name === references[0]!.path) continue;
      const size = await imageSize(bytes);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(768);
    }
    const history = Buffer.from(saved.assets['ai/history.jsonl']!).toString('utf8');
    expect(history).toContain('"resource":');
    expect(history).not.toContain('"base64":');
    expect(Buffer.byteLength(history)).toBeLessThan(1_000_000);
    console.log(
      'M12-10 image sizes (bytes)',
      JSON.stringify({
        reference: original.length,
        secondRoundImages: imageBytes[0],
        secondRoundBody: secondRound[0]!.bytes,
        maxSecondRoundImages: Math.max(...imageBytes),
        maxSecondRoundBody: Math.max(...secondRound.map((value) => value.bytes)),
        project: savedBytes.length,
        history: Buffer.byteLength(history),
        rounds: report.rounds.length,
      }),
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
    expect(await session.page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)!.report)).toEqual(
      report,
    );
    await visibleComparisons();
  } finally {
    await closeUsage(session.app);
    await server.close();
    await cleanupUsage(session.directory);
  }
});

for (const mode of ['file', 'folder-drop', 'panel-drop', 'clipboard', 'eight-images', 'text'] as const) {
  test(`M12-5 image ${mode}: plan, review, animation, exports, save and reopen`, async () => {
    test.setTimeout(300000);
    const server = await imageModelServer();
    server.controls.delay = 150;
    const session = await usageSession(server.endpoint);
    try {
      const { app, page, directory } = session;
      if (mode === 'panel-drop') {
        await dropFile(page, '.ai-panel', reference);
        await expect(page.locator('.ai-composer .ai-images img')).toHaveCount(1);
      }
      await page.getByRole('button', { name: '按参考图生成', exact: true }).click();
      if (mode === 'panel-drop') {
        await expect(page.locator('.image-input-modal .reference-grid img')).toHaveAttribute(
          'src',
          `data:image/png;base64,${(await readFile(reference)).toString('base64')}`,
        );
        await expect(page.getByRole('combobox', { name: '第 1 张图片视角', exact: true })).toHaveValue('auto');
        await expect(page.locator('.ai-composer .ai-images img')).toHaveCount(0);
      }
      if (mode === 'file') await page.getByLabel('选择参考图', { exact: true }).setInputFiles(reference);
      if (mode === 'folder-drop') await dropFile(page, '.image-input-form', reference);
      if (mode === 'clipboard') {
        // Electron 44 replaced writeImage with async write(ClipboardItem). This still
        // writes the OS clipboard in the main process; paste is a real Ctrl+V.
        const backup = await app.evaluateHandle(async ({ clipboard, ClipboardItem, nativeImage }, file) => {
          const before = await Promise.all(
            (await clipboard.read())
              // Electron can return an empty item; it has no MIME data to restore.
              .filter((item) => item.types.length > 0)
              .map(
                async (item) =>
                  new ClipboardItem(
                    Object.fromEntries(
                      await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
                    ),
                  ),
              ),
          );
          const png = Uint8Array.from(nativeImage.createFromPath(file).toPNG());
          await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
          return { restore: () => (before.length ? clipboard.write(before) : clipboard.clear()) };
        }, reference);
        try {
          await page.getByRole('textbox', { name: '描述', exact: true }).focus();
          await page.keyboard.press('Control+v');
          await expect(page.locator('.image-input-modal .reference-remove')).toHaveCount(1);
        } finally {
          await backup.evaluate((saved) => saved.restore());
          await backup.dispose();
        }
      }
      if (mode === 'eight-images') {
        const encoded = await page.evaluate(
          async (base64) => {
            const original = new Image();
            original.src = 'data:image/png;base64,' + base64;
            await original.decode();
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 256;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(original, 0, 0, 256, 256);
            const small = ['image/png', 'image/jpeg', 'image/webp'].map(
              (mime) => canvas.toDataURL(mime).split(',')[1]!,
            );
            canvas.width = 1600;
            canvas.height = 1536;
            const pixels = ctx.createImageData(canvas.width, canvas.height);
            let seed = 109;
            for (let i = 0; i < pixels.data.length; i++) {
              seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
              pixels.data[i] = seed >>> 24;
            }
            ctx.putImageData(pixels, 0, 0);
            return { small, large: canvas.toDataURL('image/png').split(',')[1]! };
          },
          (await readFile(reference)).toString('base64'),
        );
        const large = Buffer.from(encoded.large, 'base64');
        expect(large.length).toBeGreaterThan(9_000_000);
        expect(large.length).toBeLessThanOrEqual(10_000_000);
        const files = await Promise.all(
          Array.from({ length: 8 }, async (_, i) => {
            const extension = ['png', 'jpg', 'webp'][i % 3]!;
            const file = path.join(directory, i === 7 ? 'large.png' : `view-${i}.${extension}`);
            await writeFile(file, i === 7 ? large : Buffer.from(encoded.small[i % 3]!, 'base64'));
            return file;
          }),
        );
        await page.getByLabel('选择参考图', { exact: true }).setInputFiles(files);
        await expect(page.locator('.image-input-modal .reference-remove')).toHaveCount(8);
        for (let i = 0; i < 8; i++)
          await page
            .getByRole('combobox', { name: `第 ${i + 1} 张图片视角`, exact: true })
            .selectOption(['front', 'back', 'left', 'right', 'top', 'top', 'front', 'left'][i]!);
        await page.getByLabel('选择参考图', { exact: true }).setInputFiles(reference);
        await expect(page.locator('.image-input-modal .ant-alert')).toContainText('最多 8 张');
        await expect(page.locator('.image-input-modal .reference-remove')).toHaveCount(8);
        await page.locator('.image-input-modal .reference-remove').last().click();
        const oversized = path.join(directory, 'too-large.png');
        await writeFile(oversized, Buffer.concat([large, Buffer.alloc(10_000_001 - large.length)]));
        await page.getByLabel('选择参考图', { exact: true }).setInputFiles(oversized);
        await expect(page.locator('.image-input-modal .ant-alert')).toContainText('10 MB');
        await expect(page.locator('.image-input-modal .reference-remove')).toHaveCount(7);
        await page.getByLabel('选择参考图', { exact: true }).setInputFiles(files[7]!);
        await page.getByRole('combobox', { name: '第 8 张图片视角', exact: true }).selectOption('left');
      }
      await expect(page.locator('.image-input-modal .reference-remove')).toHaveCount(
        mode === 'text' ? 0 : mode === 'eight-images' ? 8 : 1,
      );
      await shot(page, `image-${mode}-input`);
      await planAndStart(page, `M12-5 ${mode} 合成参考的小房子`);
      await finishImageFlow(
        session,
        `image-${mode}`,
        mode === 'text' ? 0 : mode === 'eight-images' ? 8 : 1,
        mode === 'folder-drop',
      );
    } catch (error) {
      console.error(error);
      await shot(session.page, `image-${mode}-failure`).catch(() => undefined);
      throw error;
    } finally {
      await closeUsage(session.app);
      await server.close();
      await cleanupUsage(session.directory);
    }
  });
}

for (const failure of ['truncated', 'http400', 'stop'] as const) {
  test(`M12-5 image ${failure}: concrete outcome and new conversation excludes prior request`, async () => {
    test.setTimeout(180000);
    const server = await imageModelServer();
    server.controls.failure = failure === 'stop' ? null : failure;
    server.controls.delay = failure === 'stop' ? 700 : 150;
    const session = await usageSession(server.endpoint);
    const { page } = session;
    try {
      // A successful earlier conversation provides context to clear; failed/stopped
      // workflows themselves are correctly excluded already.
      await page
        .getByRole('textbox', { name: '给 AI 助手的消息', exact: true })
        .fill('M12-5-OLD-CONTEXT 请记住先讨论小房子');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(() => server.requests.length).toBeGreaterThan(0);
      await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
      await expect(page.getByTestId('ai-context-bar')).toContainText('1 轮');
      await page.getByRole('button', { name: '按参考图生成', exact: true }).click();
      await page.getByLabel('选择参考图', { exact: true }).setInputFiles(reference);
      await planAndStart(page, `M12-5-OLD-${failure} 小房子`, failure !== 'http400');
      if (failure === 'stop') {
        await expect
          .poll(() => page.evaluate(() => window.brickloopEditorTest.previewCounts().parts), { timeout: 60000 })
          .toBeGreaterThan(0);
        await page.locator('.image-task-card').getByRole('button', { name: '停止', exact: true }).click();
      }
      const report = await completedReport(page);
      if (failure === 'truncated') {
        expect(report.reason).toBe('completed');
        expect(report.partCount).toBeGreaterThan(0);
        expect(JSON.stringify(server.requests)).toContain('that script was not executed');
        expect(report.rounds.some((r) => r.warnings.includes('output_truncated_retried'))).toBe(true);
      } else if (failure === 'http400') {
        expect(report.reason).toBe('error');
        expect(report.failure).toMatchObject({
          stage: 'round',
          round: 1,
          error: { status: 400, code: 'invalid_parameter' },
        });
        await expect(page.locator('.image-report .ai-failure')).toContainText('HTTP 400');
        await expect(page.locator('.image-report .ai-failure')).toContainText('Offline diagnostic');
        expect(await page.evaluate(() => window.brickloopEditorTest.expanded())).toEqual([]);
      } else {
        expect(report.reason).toBe('user_stopped');
        expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBeGreaterThan(0);
      }
      if (failure !== 'truncated') await expect(page.locator('.ai-context-excluded')).toHaveText('未计入上下文');
      await shot(page, `failure-${failure}`);
      if (failure !== 'http400') {
        await page.getByTestId('review-bar').getByRole('button', { name: '撤销整轮', exact: true }).click();
        expect(await page.evaluate(() => window.brickloopEditorTest.expanded())).toEqual([]);
      }
      await page.getByRole('button', { name: '新对话', exact: true }).click();
      await page.getByRole('button', { name: '开始新对话', exact: true }).click();
      await expect(page.getByTestId('ai-context-bar')).toContainText('0 轮');
      const start = server.requests.length;
      await page.getByRole('textbox', { name: '给 AI 助手的消息', exact: true }).fill('M12-5-NEW 现在有多少零件');
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(() => server.requests.length).toBeGreaterThan(start);
      expect(JSON.stringify(server.requests.slice(start))).not.toContain(`M12-5-OLD-${failure}`);
      expect(JSON.stringify(server.requests.slice(start))).not.toContain('M12-5-OLD-CONTEXT');
      await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
    } finally {
      await closeUsage(session.app);
      await server.close();
      await cleanupUsage(session.directory);
    }
  });
}
