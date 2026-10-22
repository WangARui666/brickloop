import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fakeModel } from './ai-model-fixture';
import { launchElectron } from './electron-launch';
import { guidePng } from './guide-png-fixture';
import { setStableContentSize } from './window-size';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(desktop, '../..');
const temporary = path.join(root, '.devdata/tmp');
const evidence = path.join(root, '.devdata/m12-26');
const copy = {
  'zh-CN': {
    depth: '深度',
    provider: '服务商',
    model: '模型',
    labels: ['快速', '均衡', '深入'],
    descriptions: ['关闭思考，回复最快', '服务商默认', '开启最大强度思考'],
  },
  en: {
    depth: 'Depth',
    provider: 'Provider',
    model: 'Model',
    labels: ['Fast', 'Balanced', 'Deep'],
    descriptions: ['Thinking off, fastest replies', 'Provider default', 'Maximum thinking effort'],
  },
};

async function capture(app: ElectronApplication, page: Page, scheme: string, name: string) {
  await page.mouse.move(16, 16);
  await expect(page.locator('.thumbnail-skeleton')).toHaveCount(0, { timeout: 120000 });
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length === 0,
  );
  const raw = await page.screenshot({ scale: 'css', animations: 'disabled' });
  // Match the user guide: a 1440×900 main window, resized to a lossless 1280×800 PNG.
  const scaled = await app.evaluate(({ nativeImage }, data) => {
    const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64')).resize({ width: 1280, quality: 'best' });
    return { bitmap: image.toBitmap().toString('base64'), size: image.getSize() };
  }, raw.toString('base64'));
  expect(scaled.size).toEqual({ width: 1280, height: 800 });
  await mkdir(path.join(evidence, scheme), { recursive: true });
  await writeFile(
    path.join(evidence, scheme, `${name}.png`),
    guidePng(Buffer.from(scaled.bitmap, 'base64'), 1280, 800),
  );
}

for (const language of ['zh-CN', 'en'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`M12-26 effort descriptions: ${language}, ${scheme} system preference`, async () => {
      test.setTimeout(120000);
      await mkdir(temporary, { recursive: true });
      const directory = await mkdtemp(path.join(temporary, 'm12-26-effort-'));
      const model = await fakeModel();
      let app: ElectronApplication | undefined;
      try {
        const env = Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        );
        for (const key of [
          'ELECTRON_RUN_AS_NODE',
          'ELECTRON_RENDERER_URL',
          'BRICKLOOP_EVAL_API_KEY',
          'BRICKLOOP_AI_EVAL',
        ])
          delete env[key];
        app = await launchElectron({
          args: [desktop],
          env: { ...env, BRICKLOOP_DATA_DIR: directory },
        });
        const page = await app.firstWindow();
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
          timeout: 60000,
        });
        await page.waitForFunction(() => !!window.brickloopEditorTest);
        await page.evaluate(
          async ({ endpoint, language }) => {
            const deepseekId = crypto.randomUUID();
            await window.brickloop.aiSaveProvider({
              id: deepseekId,
              type: 'compatible',
              presetId: 'deepseek',
              name: 'DeepSeek',
              endpoint,
              model: 'deepseek-flash',
              models: ['deepseek-flash', 'deepseek-chat'],
              proxy: 'system',
              proxyUrl: '',
            });
            const snapshot = await window.brickloop.aiSaveProvider({
              id: crypto.randomUUID(),
              type: 'compatible',
              name: 'Offline',
              endpoint,
              model: 'offline-model',
              models: ['offline-model'],
              proxy: 'system',
              proxyUrl: '',
            });
            await window.brickloop.aiSaveSettings({
              ...snapshot.settings,
              defaultProviderId: deepseekId,
              defaults: { ...snapshot.settings.defaults, chat: deepseekId },
              localOnly: true,
            });
            await window.brickloop.setLanguage(language);
          },
          { endpoint: model.endpoint, language },
        );
        await page.reload();
        await page.waitForFunction(() => !!window.brickloopEditorTest);
        await page.keyboard.press('Control+k');
        await setStableContentSize(app, page, 1440, 900);
        await page.setViewportSize({ width: 1440, height: 900 });

        const text = copy[language];
        const header = page.locator('.ai-panel-header');
        const select = page.locator('.ai-model-row > .ant-select').last();
        const depth = page.getByRole('combobox', { name: text.depth, exact: true });
        const popup = page.locator('.ant-select-dropdown:visible');
        await expect(header).toContainText('deepseek-flash');
        await expect(header.locator('p')).toHaveCount(0);
        for (const description of text.descriptions) await expect(header).not.toContainText(description);
        expect((await select.boundingBox())!.width).toBe(84);
        const deepseekHeight = (await header.boundingBox())!.height;
        if (language === 'zh-CN') await capture(app, page, scheme, 'after-header');

        await depth.click();
        await expect(popup).toHaveClass(/ai-effort-popup/);
        await expect.poll(async () => (await popup.boundingBox())?.width).toBe(260);
        const options = popup.locator('.ant-select-item-option');
        await expect(options).toHaveCount(3);
        for (let i = 0; i < text.labels.length; i++) {
          await expect(options.nth(i).locator('.ai-effort-option > span').first()).toHaveText(text.labels[i]!);
          await expect(options.nth(i).locator('.ai-effort-description')).toHaveText(text.descriptions[i]!);
          await expect(options.nth(i)).toHaveAttribute('title', `${text.labels[i]}：${text.descriptions[i]}`);
        }
        await expect(popup.locator('.ant-select-item-option-selected .ai-effort-description')).toHaveCSS(
          'font-weight',
          '400',
        );
        if (language === 'zh-CN') await capture(app, page, scheme, 'after-dropdown');
        const contrast = await popup.locator('.ai-effort-description').evaluateAll((descriptions) => {
          const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
          const luminance = (values: number[]) =>
            values
              .slice(0, 3)
              .map((value) => value / 255)
              .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
              .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
          return descriptions.map((description) => {
            const style = getComputedStyle(description);
            const backgrounds: number[][] = [];
            for (let node: Element | null = description; node; node = node.parentElement) {
              const color = rgb(getComputedStyle(node).backgroundColor);
              backgrounds.push(color);
              if ((color[3] ?? 1) === 1) break;
            }
            const background = backgrounds
              .reverse()
              .reduce(
                (base, color) =>
                  color.slice(0, 3).map((value, i) => value * (color[3] ?? 1) + base[i]! * (1 - (color[3] ?? 1))),
                [0, 0, 0],
              );
            const foreground = luminance(rgb(style.color));
            const backdrop = luminance(background);
            return {
              ratio: (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05),
              fontSize: parseFloat(style.fontSize),
              labelFontSize: parseFloat(getComputedStyle(description.previousElementSibling!).fontSize),
            };
          });
        });
        for (const item of contrast) {
          expect(item.ratio).toBeGreaterThanOrEqual(4.5);
          expect(item.fontSize).toBeLessThan(item.labelFontSize);
        }
        for (const label of text.labels) {
          if (!(await popup.isVisible())) await depth.click();
          await popup.locator('.ant-select-item-option').filter({ hasText: label }).click();
          await expect(popup).toHaveCount(0);
          await expect(select).toHaveText(label);
          expect((await select.boundingBox())!.width).toBe(84);
        }

        // A DeepSeek preset alone is insufficient: non-Flash models keep the original dropdown.
        await page.getByRole('combobox', { name: text.model, exact: true }).click();
        await popup.locator('.ant-select-item-option').filter({ hasText: 'deepseek-chat' }).click();
        await depth.click();
        await expect(popup.locator('.ai-effort-description')).toHaveCount(0);
        await expect(popup).not.toHaveClass(/ai-effort-popup/);
        await expect.poll(async () => (await popup.boundingBox())?.width).toBe(84);
        await page.keyboard.press('Escape');

        await page.getByRole('combobox', { name: text.provider, exact: true }).click();
        await popup.locator('.ant-select-item-option').filter({ hasText: 'Offline' }).click();
        await expect(header).toContainText('offline-model');
        const otherHeight = (await header.boundingBox())!.height;
        expect(Math.abs(deepseekHeight - otherHeight)).toBeLessThanOrEqual(1);
        await depth.click();
        await expect(popup.locator('.ai-effort-description')).toHaveCount(0);
        await expect(popup.locator('.ant-select-item-option-content')).toHaveText(text.labels);
        await expect.poll(async () => (await popup.boundingBox())?.width).toBe(84);
        if (language === 'zh-CN') await capture(app, page, scheme, 'other-provider-dropdown');
        expect(model.requests).toHaveLength(0);
        await mkdir(evidence, { recursive: true });
        await writeFile(
          path.join(evidence, `metrics-${language}-${scheme}.json`),
          JSON.stringify(
            {
              language,
              systemColorScheme: scheme,
              applicationColorScheme: await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
              deepseekHeight,
              otherHeight,
              contrast,
              requests: model.requests.length,
            },
            null,
            2,
          ),
        );
      } finally {
        if (app) {
          await app
            .windows()[0]
            ?.evaluate(() => window.brickloopEditorTest.prepareClose())
            .catch(() => undefined);
          await app.close();
        }
        await model.close();
        expect(path.dirname(path.resolve(directory))).toBe(temporary);
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    });
  }
}
