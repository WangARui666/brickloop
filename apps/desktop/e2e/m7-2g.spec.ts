import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import { setStableContentSize } from './window-size';
import type { ElectronApplication, Page } from '@playwright/test';
import type { ToolResult, ImageBlock } from '@brickloop/ai';
import { fakeOAuth } from '../../../packages/ai/test/oauth-fixture';
import { imageModelServer } from './image-model-fixture';
import { fakeModel } from './ai-model-fixture';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(desktop, '../..');
const evidence = path.join(desktop, '../../.devdata/e2e-evidence/m7-2g');
async function launch(oauth?: string) {
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/m7-2g-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BRICKLOOP_EVAL_API_KEY;
  const app = await launchElectron({
    args: [desktop],
    env: { ...env, BRICKLOOP_DATA_DIR: directory, ...(oauth ? { BRICKLOOP_TEST_OAUTH: oauth } : {}) },
    timeout: 45000,
  });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', { timeout: 45000 });
  await page.waitForFunction(() => !!window.brickloopEditorTest);
  const errors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return {
    app,
    page,
    close: async () => {
      await page.evaluate(() => window.brickloopEditorTest.prepareClose());
      await app.close();
      if (path.dirname(directory) !== path.join(root, '.devdata/e2e')) throw new Error('Unsafe cleanup');
      await rm(directory, { recursive: true, force: true });
      expect(errors).toEqual([]);
    },
  };
}
async function capture(app: ElectronApplication, page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  for (const size of [
    [1440, 900],
    [1100, 700],
  ]) {
    await setStableContentSize(app, page, size[0]!, size[1]!);
    await page.mouse.move(12, 12);
    await page.screenshot({
      path: path.join(evidence, `${name}-${size.join('x')}.png`),
      animations: 'disabled',
      scale: 'css',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
}

test('M7-2g login creates providers, searchable models, retries, reauthorization and account list', async () => {
  test.setTimeout(180000);
  const oauth = await fakeOAuth();
  const modelServer = await fakeModel();
  const { app, page, close } = await launch(oauth.origin);
  try {
    await page.evaluate(() => window.brickloopEditorTest.settings('ai'));
    await page.getByRole('button', { name: '用账号登录', exact: false }).click();
    const modal = page.locator('.ai-provider-modal');
    oauth.controls.modelsFail = true;
    await modal.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('Key 无效或没有权限');
    await expect(modal.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '知道了', exact: true })).toHaveCount(0);
    oauth.controls.modelsFail = false;
    await modal.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('连接成功');
    await modal.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '知道了', exact: true }).click();
    await expect(page.locator('.ai-provider-item')).toHaveCount(1);
    await expect(page.locator('.ai-provider-item')).toContainText('gpt-6-astra');
    await expect(page.locator('.ai-account-row')).toContainText('builder1@example.test');
    await expect(page.getByRole('button', { name: 'Continue with ChatGPT', exact: true })).toHaveCount(0);
    const initial = await page.evaluate(() => window.brickloop.aiSnapshot());
    expect(initial.settings.defaultProviderId).toBe(initial.settings.providers[0]!.id);
    expect(initial.settings.providers[0]!.accountId).toBe(initial.accounts[0]!.id);
    await capture(app, page, 'settings-ai');
    await page.getByRole('button', { name: '编辑 ChatGPT', exact: true }).click();
    const model = page.getByRole('combobox', { name: '模型', exact: true });
    await model.click();
    await expect(page.locator('.ant-select-dropdown:visible')).toContainText('gpt-6-luna');
    await capture(app, page, 'provider-models');
    await model.fill('astra');
    await expect(page.locator('.ant-select-dropdown:visible')).not.toContainText('gpt-6-luna');
    await page.keyboard.press('Escape');
    await modal.locator('summary', { hasText: '高级设置' }).click();
    await modal.getByRole('textbox', { name: '自定义模型名', exact: true }).fill('my-model');
    await modal.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('连接成功');
    await modal.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '切换账号', exact: true }).click();
    await modal.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('连接成功');
    await modal.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.ai-provider-item')).toHaveCount(1);
    await expect(page.locator('.ai-provider-item')).toContainText('my-model');
    oauth.controls.account = 2;
    oauth.controls.modelsFail = true;
    await page.getByRole('button', { name: '添加账号', exact: true }).click();
    await modal.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('Key 无效或没有权限');
    oauth.controls.modelsFail = false;
    oauth.controls.models = ['available-first', 'available-second'];
    await modal.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('连接成功');
    await modal.getByRole('button', { name: '保存', exact: true }).click();
    const second = page.locator('.ai-provider-item').last();
    await expect(second).toContainText('available-first');
    await expect(page.locator('.ai-provider-item')).toHaveCount(2);
    await page.locator('.ai-provider-item').first().getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.locator('.ai-provider-item').first()).toContainText('需要重新登录');
    await second.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(second).toContainText('需要重新登录');
    await expect(page.getByRole('button', { name: 'Continue with ChatGPT', exact: true })).toHaveCount(0);
    oauth.controls.account = 1;
    await page.locator('.ai-provider-item').first().getByRole('button', { name: '重新登录', exact: true }).click();
    await modal.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('连接成功');
    await modal.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.ai-provider-item')).toHaveCount(2);
    await expect(page.locator('.ai-provider-item').filter({ hasText: 'my-model' })).not.toContainText('需要重新登录');
    const providerId = randomUUID();
    await page.evaluate(
      async ({ id, endpoint }) => {
        await window.brickloop.aiSaveProvider({
          id,
          endpoint,
          name: '本机模型',
          type: 'compatible',
          model: '',
          models: [],
          proxy: 'system',
          proxyUrl: '',
        });
      },
      { id: providerId, endpoint: modelServer.endpoint },
    );
    await page.reload();
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.evaluate(() => window.brickloopEditorTest.settings('ai'));
    await page.getByRole('button', { name: '编辑 本机模型', exact: true }).click();
    await expect(modal.getByRole('combobox', { name: '模型', exact: true })).toHaveCount(0);
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '测试 本机模型 的连接', exact: true }).click();
    await expect(page.locator('.ai-provider-item').last()).toContainText('offline-model');
    await page.getByRole('button', { name: '编辑 本机模型', exact: true }).click();
    await page.getByRole('combobox', { name: '模型', exact: true }).click();
    await expect(page.locator('.ant-select-dropdown:visible')).toContainText('offline-model');
    await expect(page.locator('.ant-select-dropdown:visible')).not.toContainText('gpt-6-astra');
  } finally {
    await close();
    await oauth.close();
    await modelServer.close();
  }
});

test('M7-2g comparisons handle a plate and empty component and show the whole scripted model', async () => {
  test.setTimeout(240000);
  const server = await imageModelServer();
  const { app, page, close } = await launch();
  try {
    const image: ImageBlock = {
      type: 'image',
      mime: 'image/png',
      base64: (await readFile(path.join(root, 'packages/ai/test/ai-eval/references/01-front.png'))).toString('base64'),
    };
    const boundaries = await page.evaluate(async (image) => {
      const tool = async (name: string, input: unknown = {}) =>
        window.brickloopEditorTest.aiTool(name, input) as Promise<ToolResult>;
      const data = (r: ToolResult) => {
        if (!r.ok || !r.data || typeof r.data !== 'object' || Array.isArray(r.data)) throw new Error(JSON.stringify(r));
        return r.data;
      };
      await tool('beginTransaction', '比较边界');
      const referenceId = data(await tool('add_reference_image', { image, name: '小房子', view: 'front' })).referenceId;
      const created = data(
        await tool('place_part', {
          partId: 'ld:3020',
          colorId: 'c:bright-red',
          pose: { kind: 'grid', x: 0, z: 0, level: 1 },
        }),
      ).created;
      const sub = data(await tool('create_submodel', { instanceIds: created, name: '板' }));
      const plate = await tool('compare_to_reference', { referenceId, view: 'front', modelPath: [sub.instanceId] });
      data(await tool('delete', { instanceIds: created }));
      const empty = await tool('compare_to_reference', { referenceId, view: 'front', modelPath: [sub.instanceId] });
      const mismatch = await tool('compare_to_reference', { referenceId, view: 'left' });
      await tool('commitTransaction');
      return { plate, empty, mismatch };
    }, image);
    expect(boundaries.plate).toMatchObject({ ok: true, data: { emptyModel: false } });
    expect(boundaries.empty).toMatchObject({ ok: true, data: { emptyModel: true, iou: 0, colorDifference: null } });
    expect(boundaries.mismatch).toMatchObject({ ok: false, code: 'VIEW_MISMATCH' });
    await page.evaluate(() => window.brickloopEditorTest.action('file.new'));
    await page.evaluate(
      async ({ endpoint, id }) => {
        const snapshot = await window.brickloop.aiSaveProvider({
          id,
          name: '本机测试模型',
          type: 'compatible',
          endpoint,
          model: 'offline-model',
          models: ['offline-model'],
          proxy: 'system',
          proxyUrl: '',
        });
        await window.brickloop.aiSaveSettings({ ...snapshot.settings, localOnly: true });
      },
      { endpoint: server.endpoint, id: randomUUID() },
    );
    await page.reload();
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.keyboard.press('Control+k');
    await page.getByRole('button', { name: '按参考图生成', exact: true }).click();
    await page.getByRole('textbox', { name: '描述', exact: true }).fill('黄色墙体、红色屋顶的小房子');
    await page
      .getByLabel('选择参考图', { exact: true })
      .setInputFiles(path.join(root, 'packages/ai/test/ai-eval/references/01-front.png'));
    await page.getByRole('combobox', { name: '第 1 张图片视角' }).selectOption({ label: '前视图' });
    server.controls.wallRoof = true;
    server.controls.delay = 600;
    server.controls.failedCompare = true;
    await page.getByRole('checkbox', { name: '跳过计划确认，直接开始', exact: true }).check();
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    await expect(page.locator('.image-task-card .image-comparison[data-component="whole"]')).toBeVisible({
      timeout: 90000,
    });
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible();
    await page.evaluate(() => window.brickloopEditorTest.preset('front'));
    const pixels = await page.evaluate(async () => {
      const comparison = window.brickloopEditorTest.aiState().workflow!.comparison!;
      const block = comparison.images[1]!;
      const image = new Image();
      image.src = `data:${block.mime};base64,${block.base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let yellow = 0,
        red = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]! < 128) continue;
        if (data[i]! > 120 && data[i + 1]! > 100 && data[i + 2]! < data[i + 1]! * 0.65) yellow++;
        if (data[i]! > 100 && data[i]! > data[i + 1]! * 1.5) red++;
      }
      return { yellow, red, componentId: comparison.componentId };
    });
    expect(pixels.componentId).toBeNull();
    expect(pixels.yellow).toBeGreaterThan(100);
    expect(pixels.red).toBeGreaterThan(100);
    await capture(app, page, 'component-check');
    server.controls.delay = 0;
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running), { timeout: 90000 })
      .toBe(false);
    const report = await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)!.report!);
    expect(report.reason).toBe('completed');
    expect(report.summaryZh).toContain('整体第 1 轮');
    expect(report.summaryZh).toContain('整体第 1 轮');
    const failed = page
      .locator('.ai-tool')
      .filter({ has: page.locator('summary', { hasText: '对比参考图 · 操作未完成' }) })
      .first();
    await failed.locator('summary').click();
    await expect(failed).toContainText('参考图已不存在。请重新添加图片后重试。');
    await expect(failed).not.toContainText('REFERENCE_NOT_FOUND');
    await page.locator('.image-comparison-history summary').click();
    await expect(page.locator('.image-report .image-comparison[data-component="whole"]').first()).toContainText(
      '整体第 1 轮',
    );
  } finally {
    await close();
    await server.close();
  }
});
