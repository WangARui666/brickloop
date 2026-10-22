import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import type { ElectronApplication, Page } from '@playwright/test';
import { fakeOAuth } from '../../../packages/ai/test/oauth-fixture';
import type { AiProvider } from '../src/shared/ai-api';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
  root = path.resolve(desktop, '../..');
const evidence = path.join(root, '.devdata/m11-1-shots');
async function fixture() {
  const requests: { path: string; key: string; body?: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const route = req.url ?? '';
    const record = { path: route, key: req.headers.authorization ?? '' } as (typeof requests)[number];
    requests.push(record);
    if (route.includes('/timeout')) return;
    if (route.includes('/reset')) {
      req.socket.destroy();
      return;
    }
    const status = /^\/(401|402|403|404|429)\//.exec(route)?.[1];
    if (status) {
      res.writeHead(Number(status), { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: { message: `Fixture status ${status}; credential ${record.key}`, code: 'fixture_error' },
        }),
      );
      return;
    }
    if (route.endsWith('/models')) {
      if (route.includes('/manual')) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          data: ['deepseek-chat', 'deepseek-vision', 'deepseek-flash', 'deepseek-v4-pro'].map((id) => ({
            id,
            object: 'model',
            created: 1,
            owned_by: 'offline-fixture',
          })),
        }),
      );
      return;
    }
    if (!route.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      record.body = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ id: 'offline', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: 'offline', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ id: 'offline', choices: [], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function screenshot(page: Page, name: string) {
  await page.mouse.move(12, 12);
  await page.screenshot({ path: path.join(evidence, `${name}.png`), animations: 'disabled', scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function assertNoPlaintext(directory: string, key: string) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await assertNoPlaintext(file, key);
    else expect((await readFile(file)).includes(Buffer.from(key)), file).toBe(false);
  }
}
async function cleanup(directory: string) {
  if (path.dirname(path.resolve(directory)) !== path.join(root, '.devdata/e2e')) throw new Error('Unsafe cleanup');
  await rm(directory, { recursive: true, force: true });
}
test('AIS-01–AIS-08: two setup modes, draft probes, presets, errors, migration and encrypted credentials', async () => {
  test.setTimeout(240000);
  await mkdir(evidence, { recursive: true });
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/ai-setup-'));
  const server = await fixture(),
    oauth = await fakeOAuth(),
    key = `offline-setup-${randomUUID()}`;
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BRICKLOOP_EVAL_API_KEY;
  delete env.BRICKLOOP_AI_EVAL;
  async function launch() {
    app = await launchElectron({
      args: [desktop, '--host-resolver-rules=MAP *.invalid ~NOTFOUND'],
      env: {
        ...env,
        BRICKLOOP_DATA_DIR: directory,
        BRICKLOOP_TEST_AI_ORIGIN: server.origin,
        BRICKLOOP_TEST_OAUTH: oauth.origin,
        BRICKLOOP_TEST_CONNECTION_TIMEOUT: '2000',
      },
    });
    const page = await app.firstWindow();

    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45000,
    });
    await page.waitForFunction(() => !!window.brickloopEditorTest);
    await page.evaluate(() => window.brickloopEditorTest.settings('ai'));
    return page;
  }
  try {
    let page = await launch();
    await expect(page.getByRole('button', { name: '用账号登录', exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: '使用 API Key', exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with ChatGPT', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '添加', exact: true })).toHaveCount(0);
    await expect(page.getByRole('spinbutton', { name: '每轮操作上限', exact: true })).toBeHidden();
    await expect(page.getByRole('spinbutton', { name: '每轮时长（分钟）', exact: true })).toBeHidden();
    const advanced = page.locator('.ai-settings-page > details.ai-page-advanced');
    await advanced.locator('summary').click();
    const toolLimit = page.getByRole('spinbutton', { name: '每轮操作上限', exact: true });
    const duration = page.getByRole('spinbutton', { name: '每轮时长（分钟）', exact: true });
    for (const field of [toolLimit, duration]) {
      await expect(field).toHaveValue('');
      await expect(field).toHaveAttribute('placeholder', '不限');
    }
    await toolLimit.fill('120');
    await expect
      .poll(async () => (await page.evaluate(() => window.brickloop.aiSnapshot())).settings.toolLimit)
      .toBe(120);
    await toolLimit.fill('');
    await expect
      .poll(async () => (await page.evaluate(() => window.brickloop.aiSnapshot())).settings.toolLimit)
      .toBeNull();
    await advanced.locator('summary').click();
    await screenshot(page, '01-empty');
    await page.getByRole('button', { name: '使用 API Key', exact: false }).click();
    const modal = page.locator('.ai-provider-modal');
    await modal.getByRole('button', { name: '返回上一步', exact: true }).click();
    await screenshot(page, '02-modes');
    await modal.getByRole('button', { name: '使用 API Key', exact: false }).click();
    await expect(modal.locator('.ai-preset')).toHaveCount(17);
    await expect(modal.getByText('含看图模型 · 含工具调用模型', { exact: true })).toHaveCount(0);
    await screenshot(page, '03-presets');
    await modal.getByRole('searchbox').fill('DeepSeek');
    await expect(modal.locator('.ai-preset')).toHaveCount(1);
    await modal.locator('.ai-preset').click();
    await expect(modal.getByRole('textbox', { name: '服务地址', exact: true })).toBeHidden();
    await expect(modal.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await modal.getByLabel('API 密钥', { exact: true }).fill(key);
    await screenshot(page, '04-deepseek-key');
    await modal.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('连接成功');
    await expect(modal.getByRole('status')).toContainText('4 个模型');
    expect((await page.evaluate(() => window.brickloop.aiSnapshot())).settings.providers).toHaveLength(0);
    await expect(modal.getByRole('combobox', { name: '模型', exact: true })).toBeVisible();
    await expect(modal.getByText('deepseek-flash', { exact: true })).toBeVisible();
    await modal.getByRole('combobox', { name: '模型', exact: true }).click();
    await page.locator('.ant-select-item-option-content', { hasText: /^deepseek-flash$/ }).click();
    await expect(modal.locator('.ai-model-capabilities')).toContainText('可以看图');
    await expect(modal.locator('.ai-model-capabilities')).toContainText('可以调用工具');
    await modal.getByRole('combobox', { name: '模型', exact: true }).click();
    await expect(page.locator('.ant-select-item-option-content', { hasText: /^deepseek-v4-pro$/ })).toBeVisible();
    await page.locator('.ant-select-item-option-content', { hasText: /^deepseek-flash$/ }).click();
    await screenshot(page, '05-connected-models');
    await modal.getByRole('button', { name: '保存', exact: true }).click();
    await expect(modal).toHaveCount(0);
    const saved = await page.evaluate(() => window.brickloop.aiSnapshot());
    const deepseek = saved.settings.providers[0]!;
    expect(deepseek.presetId).toBe('deepseek');
    expect(saved.settings.defaultProviderId).toBe(deepseek.id);
    expect(saved.settings.defaults).toEqual({
      chat: `${deepseek.id}/deepseek-flash`,
      vision: `${deepseek.id}/deepseek-flash`,
      quick: `${deepseek.id}/deepseek-flash`,
    });
    const deepseekCard = page.locator('.ai-provider-item').filter({ hasText: 'DeepSeek' });
    await expect(deepseekCard.getByText('DeepSeek', { exact: true })).toHaveCount(1);
    await expect(deepseekCard.getByTitle('当前默认服务')).toContainText('默认');
    expect(server.requests[0]?.path).toBe('/models');
    expect(server.requests[1]?.body?.max_tokens).toBe(16);
    await assertNoPlaintext(path.join(directory, 'config/ai'), key);

    // AIS-04: blank key uses the encrypted key; changes and cancelled drafts stay in memory.
    await page.getByRole('button', { name: '编辑 DeepSeek', exact: true }).click();
    await expect(modal.getByLabel('API 密钥', { exact: true })).toHaveValue('');
    await modal.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('连接成功');
    expect(server.requests.at(-1)?.key).toBe(`Bearer ${key}`);
    await modal.locator('summary', { hasText: '高级设置' }).click();
    await modal.getByRole('textbox', { name: '服务地址', exact: true }).fill(`${server.origin}/edited`);
    await expect(modal.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await modal.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('连接成功');
    expect(server.requests.at(-1)?.path).toBe('/edited/chat/completions');
    await screenshot(page, '09-advanced');
    // AIS-03: real local HTTP failures, a stalled socket and DNS failure; all diagnostics are scrubbed.
    for (const [route, message] of [
      ['401', 'Key 无效或没有权限'],
      ['403', 'Key 无效或没有权限'],
      ['402', '余额不足'],
      ['404', '服务地址或模型不对'],
      ['429', '请求太频繁或额度用尽'],
      ['timeout', '网络不通'],
      ['reset', '网络不通'],
      ['dns', '网络不通'],
    ]) {
      await modal
        .getByRole('textbox', { name: '服务地址', exact: true })
        .fill(route === 'dns' ? 'http://ai-setup.invalid/v1' : `${server.origin}/${route}`);
      await modal.getByRole('button', { name: '测试连接', exact: true }).click();
      await expect(modal.getByRole('status')).toContainText(message!, { timeout: 15000 });
      const details = modal.getByRole('status').locator('summary');
      if (await details.count()) await details.click();
      if (/^\d/.test(route!)) await expect(modal.getByRole('status')).toContainText(route!);
      expect(await modal.innerText()).not.toContain(key);
      if (route === '401') await screenshot(page, '06-invalid-key');
    }
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    expect((await page.evaluate(() => window.brickloop.aiSnapshot())).settings.providers[0]).toEqual(deepseek);
    await assertNoPlaintext(path.join(directory, 'config/ai'), key);

    // AIS-05 and AIS-08: no model list, explicit manual name; separate confirmed untested save.
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await modal.getByRole('button', { name: '使用 API Key', exact: false }).click();
    await modal.getByRole('searchbox').fill('自定义');
    await modal.locator('.ai-preset').click();
    await modal.getByRole('textbox', { name: '服务地址', exact: true }).fill(`${server.origin}/manual`);
    await modal.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('手动输入模型名');
    await modal.getByRole('textbox', { name: '自定义模型名', exact: true }).fill('manual-model');
    await modal.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('连接成功');
    await modal.getByRole('textbox', { name: '显示名称', exact: true }).fill('本机手动模型');
    await modal.getByRole('button', { name: '不测试直接保存', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '保存为未测试的服务？' })).toBeVisible();
    await page
      .getByRole('dialog', { name: '保存为未测试的服务？' })
      .getByRole('button', { name: '取消', exact: true })
      .click();
    expect((await page.evaluate(() => window.brickloop.aiSnapshot())).settings.providers).toHaveLength(1);
    await modal.getByRole('button', { name: '不测试直接保存', exact: true }).click();
    await page
      .getByRole('dialog', { name: '保存为未测试的服务？' })
      .getByRole('button', { name: '不测试直接保存', exact: true })
      .click();
    const manualCard = page.locator('.ai-provider-item').filter({ hasText: '本机手动模型' });
    await expect(manualCard).toContainText('未测试');
    await manualCard.getByRole('button', { name: '测试 本机手动模型 的连接', exact: true }).click();
    await expect(manualCard).toContainText('可用');
    await expect(manualCard.getByRole('status')).toHaveText(/连接成功 · 用时 \d+ ms/);
    await expect(deepseekCard.getByRole('status')).toHaveCount(0);
    await deepseekCard.getByRole('button', { name: '测试 DeepSeek 的连接', exact: true }).click();
    await expect(deepseekCard.getByRole('status')).toHaveText(/连接成功 · 用时 \d+ ms/);
    await expect(manualCard.getByRole('status')).toHaveText(/连接成功 · 用时 \d+ ms/);
    await expect(page.locator('.ai-provider-list + .ai-connection-feedback')).toHaveCount(0);

    // AIS-06: actual local fake OAuth, automatic minimal request, deferred save and API-key guidance.
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await modal.getByRole('button', { name: '用账号登录', exact: false }).click();
    await expect(modal).toContainText('Kimi');
    await expect(modal).toContainText('官方 CLI');
    await screenshot(page, '07-account');
    await modal.getByRole('button', { name: '改用 API Key', exact: true }).click();
    await expect(modal.locator('.ai-preset')).toHaveCount(17);
    await modal.getByRole('button', { name: '返回上一步', exact: true }).click();
    await modal.getByRole('button', { name: '用账号登录', exact: false }).click();
    await modal.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
    await expect(modal.getByRole('status')).toContainText('连接成功');
    expect(oauth.requests).toHaveLength(1);
    expect(oauth.requests[0]).toMatchObject({ store: false, stream: true });
    expect(oauth.requests[0]).not.toHaveProperty('max_output_tokens');
    expect((await page.evaluate(() => window.brickloop.aiSnapshot())).settings.providers).toHaveLength(2);
    await modal.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '知道了', exact: true }).click();
    await expect(page.locator('.ai-provider-item')).toHaveCount(3);
    await expect(
      page.locator('.ai-provider-item').getByRole('button', { name: '管理套餐用量', exact: true }),
    ).toBeInViewport();
    await screenshot(page, '08-three-services');

    // A-52: draft tests account for usage, enforce limits and never store unsaved credentials.
    const budget = await page.evaluate(
      async ({ origin }) => {
        const snapshot = await window.brickloop.aiSnapshot();
        const p: AiProvider = {
          ...snapshot.settings.providers[0]!,
          id: crypto.randomUUID(),
          presetId: 'custom',
          endpoint: `${origin}/v1`,
          prices: { input: 1, output: 2, cacheRead: 0.1 },
        };
        const result = await window.brickloop.aiTestProviderDraft(p, 'offline-budget-key');
        const charged = await window.brickloop.aiSnapshot();
        await window.brickloop.aiSaveSettings({ ...charged.settings, dailyLimit: charged.spent });
        const blocked = await window.brickloop.aiTestProviderDraft(p, 'offline-budget-key');
        await window.brickloop.aiSaveSettings({ ...charged.settings, dailyLimit: null });
        return { result, spent: charged.spent, blocked };
      },
      { origin: server.origin },
    );
    expect(budget.result.error).toBeUndefined();
    expect(budget.spent).toBeGreaterThan(0);
    expect(budget.blocked.error).toBe('aiUi.dailyLimitReached');

    // AIS-07: restart with legacy records; IDs bind the existing encrypted key and OAuth account.
    const before = await page.evaluate(() => window.brickloop.aiSnapshot());
    await page.evaluate(() => window.brickloopEditorTest.prepareClose());
    await app!.close();
    app = undefined;
    const settingsFile = path.join(directory, 'config/settings.json');
    const document = JSON.parse(await readFile(settingsFile, 'utf8'));
    document.ai.providers[1] = {
      ...document.ai.providers[1],
      name: 'OpenAI',
      type: 'openai',
      endpoint: 'https://api.openai.com/v1',
    };
    for (const p of document.ai.providers) {
      delete p.mode;
      delete p.presetId;
      delete p.connectionStatus;
    }
    await writeFile(settingsFile, JSON.stringify(document));
    page = await launch();
    const after = await page.evaluate(() => window.brickloop.aiSnapshot());
    expect(after.settings.providers.map((p) => [p.mode, p.presetId])).toEqual([
      ['apiKey', 'deepseek'],
      ['apiKey', 'openai'],
      ['account', 'chatgpt'],
    ]);
    expect(after.settings.defaults).toEqual(before.settings.defaults);
    expect(after.settings.defaultProviderId).toBe(before.settings.defaultProviderId);
    expect(after.masks[deepseek.id]).toBe(before.masks[deepseek.id]);
    expect(after.accounts).toEqual(before.accounts);
    await page.getByRole('button', { name: '测试 DeepSeek 的连接', exact: true }).click();
    await expect(page.locator('.ai-provider-item').first()).toContainText('可用');
    const accountCard = page.locator('.ai-provider-item').filter({ hasText: 'ChatGPT' });
    await expect(accountCard.getByRole('button', { name: '切换账号', exact: true })).toBeVisible();
    await accountCard.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(accountCard).toContainText('需要重新登录');
    expect(errors).toEqual([]);
    await writeFile(path.join(evidence, 'renderer-errors.json'), JSON.stringify(errors));
  } finally {
    if (app) {
      await app
        .firstWindow()
        .then((page) => page.evaluate(() => window.brickloopEditorTest.prepareClose()))
        .catch(() => undefined);
      await app.close();
    }
    await server.close();
    await oauth.close();
    await cleanup(directory);
  }
});

for (const scenario of ['AIS-09 cache deletion', 'AIS-09 legacy session migration', 'AIS-10 session loss'] as const) {
  test(`${scenario}: preserves or recovers encrypted API keys and ChatGPT accounts`, async () => {
    test.setTimeout(180000);
    await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
    const directory = await mkdtemp(path.join(root, '.devdata/e2e/ai-session-'));
    if (path.dirname(path.resolve(directory)) !== path.join(root, '.devdata/e2e'))
      throw new Error('Unsafe test directory');
    const server = await fixture(),
      oauth = await fakeOAuth();
    const key = `sk-test-${randomUUID()}`;
    const replacement = `sk-test-${randomUUID()}`;
    const errors: string[] = [];
    let app: ElectronApplication | undefined;
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.BRICKLOOP_EVAL_API_KEY;
    delete env.BRICKLOOP_AI_EVAL;
    async function launch() {
      app = await launchElectron({
        args: [desktop],
        env: {
          ...env,
          BRICKLOOP_DATA_DIR: directory,
          BRICKLOOP_TEST_AI_ORIGIN: server.origin,
          BRICKLOOP_TEST_OAUTH: oauth.origin,
        },
      });
      const page = await app.firstWindow();

      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
        timeout: 45000,
      });
      await page.waitForFunction(() => !!window.brickloopEditorTest);
      await page.evaluate(() => window.brickloopEditorTest.settings('ai'));
      return page;
    }
    async function close() {
      if (!app) return;
      await app
        .firstWindow()
        .then((page) => page.evaluate(() => window.brickloopEditorTest.prepareClose()))
        .catch(() => undefined);
      await app.close();
      app = undefined;
    }
    const ciphertext = async () =>
      Promise.all(
        (await readdir(path.join(directory, 'config/ai/secrets')))
          .sort()
          .map(async (name) => ({ name, bytes: await readFile(path.join(directory, 'config/ai/secrets', name)) })),
      );
    try {
      let page = await launch();
      await page.getByRole('button', { name: '使用 API Key', exact: false }).click();
      let modal = page.locator('.ai-provider-modal');
      await modal.getByRole('searchbox').fill('DeepSeek');
      await modal.locator('.ai-preset').click();
      await modal.getByLabel('API 密钥', { exact: true }).fill(key);
      await modal.getByRole('button', { name: '测试连接', exact: true }).click();
      await expect(modal.getByRole('status')).toContainText('连接成功');
      await modal.getByRole('button', { name: '保存', exact: true }).click();
      await expect(modal).toHaveCount(0);
      await page.getByRole('button', { name: '添加', exact: true }).click();
      await modal.getByRole('button', { name: '用账号登录', exact: false }).click();
      await modal.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
      await expect(modal.getByRole('status')).toContainText('连接成功');
      await modal.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('button', { name: '知道了', exact: true }).click();
      const before = await page.evaluate(() => window.brickloop.aiSnapshot());
      const provider = before.settings.providers.find((p) => p.type !== 'chatgpt')!;
      const chatgpt = before.settings.providers.find((p) => p.type === 'chatgpt')!;
      expect(before.accounts).toHaveLength(1);
      expect(before.masks[provider.id]).toBe(`****${key.slice(-4)}`);
      await close();
      const original = await ciphertext();
      if (scenario === 'AIS-09 cache deletion') await rm(path.join(directory, 'cache'), { recursive: true });
      else if (scenario === 'AIS-09 legacy session migration') {
        await mkdir(path.join(directory, 'cache'), { recursive: true });
        await rename(path.join(directory, 'session'), path.join(directory, 'cache/session'));
      } else await rm(path.join(directory, 'session'), { recursive: true });
      page = await launch();
      modal = page.locator('.ai-provider-modal');
      const after = await page.evaluate(() => window.brickloop.aiSnapshot());
      await expect
        .poll(() =>
          stat(path.join(directory, 'session/Local State')).then(
            (s) => s.isFile(),
            () => false,
          ),
        )
        .toBe(true);
      await expect(stat(path.join(directory, 'cache/session'))).rejects.toMatchObject({ code: 'ENOENT' });
      const apiCard = page.locator('.ai-provider-item').filter({ hasText: 'DeepSeek' });
      const accountCard = page.locator('.ai-provider-item').filter({ hasText: 'ChatGPT' });
      if (scenario !== 'AIS-10 session loss') {
        expect(after.masks).toEqual(before.masks);
        expect(after.accounts).toEqual(before.accounts);
        expect(after.unreadableKeys).toEqual([]);
        await expect(apiCard).toContainText(before.masks[provider.id]!);
        await expect(accountCard).toContainText(before.accounts[0]!.email!);
        await apiCard.getByRole('button', { name: '测试 DeepSeek 的连接', exact: true }).click();
        await expect(apiCard).toContainText('连接成功');
        expect(server.requests.at(-1)?.key === `Bearer ${key}`).toBe(true);
        expect((await page.evaluate((id) => window.brickloop.aiTestProvider(id), chatgpt.id)).error).toBeUndefined();
        expect(await ciphertext()).toEqual(original);
      } else {
        const hint = '已保存的 Key 无法读取，请在"设置 → AI 助手"中重新填写';
        expect(after.masks).toEqual({});
        expect(after.unreadableKeys).toEqual([provider.id]);
        expect(after.accounts).toEqual([]);
        await expect(apiCard).toContainText('需要重新填写');
        await expect(accountCard).toContainText('需要重新登录');
        const requestCount = server.requests.length,
          oauthCount = oauth.requests.length;
        const settingsFile = path.join(directory, 'config/settings.json');
        const savedSettings = await readFile(settingsFile, 'utf8');
        await apiCard.getByRole('button', { name: '测试 DeepSeek 的连接', exact: true }).click();
        await expect(apiCard).toContainText(hint);
        expect((await page.evaluate((id) => window.brickloop.aiTestProvider(id), chatgpt.id)).error).toBe(
          'aiSetup.accountUnreadable',
        );
        await page.evaluate(
          async ({ api, account }) => {
            await window.brickloop.aiRefreshModels(api);
            await window.brickloop.aiRefreshModels(account);
          },
          { api: provider.id, account: chatgpt.id },
        );
        await page
          .locator('.settings-dialog .ant-modal-footer')
          .getByRole('button', { name: '关闭', exact: true })
          .click();
        await page.locator('.inspector-heading').getByText('AI 助手', { exact: true }).click();
        await page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill('offline test');
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await expect(page.locator('.ai-panel')).toContainText(hint);
        await expect
          .poll(async () => (await page.evaluate(() => window.brickloop.aiSnapshot())).tasks.at(-1)?.status)
          .toBe('failed');
        expect(server.requests).toHaveLength(requestCount);
        expect(oauth.requests).toHaveLength(oauthCount);
        expect(await ciphertext()).toEqual(original);
        expect(await readFile(settingsFile, 'utf8')).toBe(savedSettings);
        await page.evaluate(() => window.brickloopEditorTest.settings('ai'));
        await page.getByRole('button', { name: '编辑 DeepSeek', exact: true }).click();
        await expect(modal.getByLabel('API 密钥', { exact: true })).toHaveValue('');
        await expect(modal.getByLabel('API 密钥', { exact: true })).toHaveAttribute(
          'placeholder',
          '已保存的 Key 无法读取，请重新粘贴 Key',
        );
        for (const name of ['测试连接', '保存', '不测试直接保存'])
          await expect(modal.getByRole('button', { name, exact: true })).toBeDisabled();
        await modal.getByLabel('API 密钥', { exact: true }).fill('   ');
        for (const name of ['测试连接', '保存', '不测试直接保存'])
          await expect(modal.getByRole('button', { name, exact: true })).toBeDisabled();
        await modal.getByLabel('API 密钥', { exact: true }).fill(replacement);
        await modal.getByRole('button', { name: '测试连接', exact: true }).click();
        await expect(modal.getByRole('status')).toContainText('连接成功');
        expect(await ciphertext()).toEqual(original);
        await modal.getByRole('button', { name: '保存', exact: true }).click();
        await expect(modal).toHaveCount(0);
        await expect(apiCard).toContainText('可用');
        const recovered = await page.evaluate(() => window.brickloop.aiSnapshot());
        expect(recovered.masks[provider.id]).toBe(`****${replacement.slice(-4)}`);
        expect(recovered.unreadableKeys).toEqual([]);
        await apiCard.getByRole('button', { name: '测试 DeepSeek 的连接', exact: true }).click();
        await expect(apiCard).toContainText('连接成功');
        expect(server.requests.at(-1)?.key === `Bearer ${replacement}`).toBe(true);
        await expect(accountCard).toContainText('需要重新登录');
        expect(await apiCard.innerText()).not.toContain('SECURE_STORAGE');
        await assertNoPlaintext(path.join(directory, 'config/ai'), replacement);
      }
      expect(errors).toEqual([]);
      await assertNoPlaintext(path.join(directory, 'config/ai'), key);
    } finally {
      await close();
      await server.close();
      await oauth.close();
      await cleanup(directory);
    }
  });
}
