import { fakeModel } from './ai-model-fixture';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import { setStableContentSize } from './window-size';
import type { ElectronApplication, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';
import type { DesktopApi } from '../src/shared/api';
import type { ToolResult } from '@brickloop/ai';
import { unzipSync } from 'fflate';
import { writePack } from '../../../packages/catalog/src/pack-workbooks';

declare global {
  interface Window {
    brickloop: DesktopApi;
    brickloopEditorTest: EditorTestApi;
  }
}
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
  root = path.resolve(desktop, '../..');
const evidence = path.join(root, '.devdata/m8-2-regression-shots/ai');
async function capture(app: ElectronApplication, page: Page, name: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const [width, height] of [
    [1440, 900],
    [1100, 700],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await setStableContentSize(app, page, width!, height!);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
    await page.locator('.ai-message-list').evaluateAll((lists) => {
      for (const list of lists) list.scrollTop = list.scrollHeight;
    });
    if (name === 'ai-review' || name === 'ai-streaming')
      await page
        .locator('.ai-tool')
        .last()
        .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.mouse.move(16, 16);
    await page.waitForFunction(
      () =>
        document
          .getAnimations()
          .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length ===
        0,
    );
    await page.screenshot({
      path: path.join(evidence, `${name}-${width}x${height}.png`),
      scale: 'css',
      animations: 'disabled',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
}
async function seed(page: Page, positions: number[][]) {
  await page.evaluate(async (positions) => {
    const api = window.brickloopEditorTest;
    api.enter([]);
    if (api.expanded().length) {
      api.action('select.all');
      api.command({ type: 'edit.delete' });
    }
    for (const [x, y, z] of positions)
      api.command({
        type: 'part.add',
        partId: 'ld:3001',
        colorId: 'c:bright-red',
        transform: [x!, y!, z!, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      });
    await api.meshesReady();
    await api.assemblyReady();
    api.preset('iso');
    api.action('view.fitAll');
  }, positions);
}
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}
async function done(page: Page) {
  await expect(page.getByRole('region', { name: '本轮修改审阅' })).toBeVisible({ timeout: 45000 });
}

test('M5-2 AI-03–AI-08: offline model, real editor IPC, encrypted secrets, MCP stdio and evidence', async () => {
  test.setTimeout(240000);
  await mkdir(evidence, { recursive: true });
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/ai-')),
    model = await fakeModel(),
    pipe = `\\\\.\\pipe\\brickloop-mcp-test-${randomUUID()}`;
  const key = `offline-credential-${randomUUID()}`;
  let app: ElectronApplication | undefined, client: Client | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    app = await launchElectron({
      args: [desktop],
      env: { ...env, BRICKLOOP_DATA_DIR: directory, BRICKLOOP_MCP_PIPE: pipe },
      timeout: 30000,
    });
    const page = await app.firstWindow(),
      errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45000,
    });
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
    const providerId = randomUUID();
    const library = await page.evaluate(async () => ({
      colors: (await window.brickloop.catalogColors()).factory,
      parts: await window.brickloop.catalogSearch('', { includeAll: false }),
      catalog: await window.brickloop.assemblyCatalog(),
      categories: await window.brickloop.catalogCategories(),
    }));
    if (!library.colors.some((c) => c.factoryCode === 'S031')) {
      const factory = library.catalog.parts.find((p) => p.id === 'ld:3001')!;
      const target = library.colors.find(
        (c) => c.id !== 'c:bright-red' && c.rgb !== '#05131D' && factory.colors.includes(c.id),
      )!;
      const packPath = path.join(directory, 'offline-factory.brklpack');
      await writePack(packPath, {
        manifest: {
          id: 'offline-ai-factory',
          name: '验收工厂色板',
          version: '1.0.0',
          source: 'Original offline test fixture',
          createdAt: '2026-10-16T00:00:00Z',
          templateVersion: 1,
          contentHash: '',
        },
        parts: library.parts.map((p) => ({
          partId: p.id,
          factoryNo: p.factoryNo ?? p.id,
          factoryName: p.nameZh,
          legoNo: p.legoNo,
          ldrawFile: p.ldrawFile,
          status: 'active',
          categoryId: p.categoryId,
          colors: (library.catalog.parts.find((v) => v.id === p.id)?.colors ?? []) as (typeof target.id)[],
        })),
        colors: library.colors.map((c) => ({
          colorId: c.id,
          factoryCode: c.id === target.id ? 'S031' : c.factoryCode!,
          measuredRgb: c.rgb,
          definition: c,
        })),
        categories: [],
        assets: {},
      });
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, packPath);
      await page.evaluate(async () => {
        const review = await window.brickloop.packsImport({ action: 'choose', kind: 'file' });
        if (!review?.token || review.report.errors.length)
          throw new Error(`Invalid factory fixture: ${JSON.stringify(review?.report.errors)}`);
        await window.brickloop.packsImport({ action: 'commit', token: review.token, activate: true });
      });
    }
    await page.evaluate(
      async ({ endpoint, key, providerId }) => {
        const snapshot = await window.brickloop.aiSaveProvider(
          {
            id: providerId,
            type: 'compatible',
            name: '本机测试模型',
            endpoint,
            model: 'offline-model',
            models: ['offline-model'],
            proxy: 'system',
            proxyUrl: '',
            prices: { input: 1, output: 2, cacheRead: 0.1 },
          },
          key,
        );
        await window.brickloop.aiSaveSettings({ ...snapshot.settings, debug: true, dailyLimit: 10 });
      },
      { endpoint: model.endpoint, key, providerId },
    );
    // Refresh UI via its settings notification path, then test the actual model-list and minimal streaming request.
    model.frames.push({ text: 'OK' });
    expect(await page.evaluate((id) => window.brickloop.aiTestProvider(id), providerId)).toMatchObject({
      models: [{ id: 'offline-model' }],
    });
    const testedUsage = await page.evaluate(() => window.brickloop.aiSnapshot());
    expect(testedUsage.spent).toBeGreaterThan(0);
    await page.evaluate(async () => {
      const state = await window.brickloop.aiSnapshot();
      await window.brickloop.aiSaveSettings({ ...state.settings, dailyLimit: state.spent });
    });
    expect(await page.evaluate((id) => window.brickloop.aiTestProvider(id), providerId)).toMatchObject({
      error: 'aiUi.dailyLimitReached',
    });
    await page.evaluate(async () => {
      const state = await window.brickloop.aiSnapshot();
      await window.brickloop.aiSaveSettings({ ...state.settings, dailyLimit: 10 });
    });
    await page.reload();
    await expect
      .poll(
        async () => {
          if (errors.length) throw new Error(errors.join('\n'));
          return page
            .locator('[data-library-ready]')
            .getAttribute('data-library-ready', { timeout: 1000 })
            .catch(() => null);
        },
        { timeout: 15000 },
      )
      .toBe('true');
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
    await page.keyboard.press('Control+k');
    await seed(page, [
      [0, -24, 0],
      [100, -24, 0],
      [200, -24, 0],
    ]);
    const targetColor = await page.evaluate(async () => {
      const colors = await window.brickloop.catalogColors();
      return colors.factory.find((c) => c.factoryCode === 'S031')!.id;
    });
    const before = await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length);
    model.frames.push(
      { text: '先查询颜色，再统一模型配色。', calls: [{ name: 'list_colors', arguments: {} }] },
      { calls: [{ name: 'replace_color', arguments: { fromColorId: 'c:bright-red', toColorId: targetColor } }] },
      {
        calls: [
          { name: 'validate', arguments: {} },
          {
            name: 'render_views',
            arguments: { views: ['front', 'isometric'], width: 256, height: 256, transparent: true },
          },
        ],
      },
      { text: '**配色已统一**\n已检查零件连接和工厂配色，模型可继续编辑。', delay: 4500 },
    );
    await send(page, '把所有红色换成 S031');
    await expect(page.locator('.ai-images .ant-image img').first()).toBeVisible({ timeout: 45000 });
    await capture(app, page, 'ai-streaming');
    await done(page);
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length)).toBe(before + 1);
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().map((r) => r.colorId))).toEqual([
      targetColor,
      targetColor,
      targetColor,
    ]);
    await capture(app, page, 'ai-review');
    await page.getByTestId('review-bar').getByRole('button', { name: '撤销整轮', exact: true }).click();
    expect(
      await page.evaluate(() => window.brickloopEditorTest.expanded().every((r) => r.colorId === 'c:bright-red')),
    ).toBe(true);

    // AI-04: two independent collision pairs and one floating part.
    await seed(page, [
      [0, -24, 0],
      [10, -24, 0],
      [200, -24, 0],
      [210, -24, 0],
      [0, -160, 200],
    ]);
    const ids = await page.evaluate(() => window.brickloopEditorTest.expanded().map((r) => r.path.at(-1)!));
    await page.keyboard.press('F7');
    await page.evaluate(() => window.brickloopEditorTest.assemblyReady());
    await expect(page.locator('.check-part-name').first()).toContainText('砖 2×4');
    await page.locator('.check-item').first().click();
    await expect(page.locator('.check-instance').first()).toBeVisible();
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().workspace.selection.length)).toBeGreaterThan(
      1,
    );
    await page.locator('.check-instance').first().click();
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().workspace.selection.length)).toBe(1);
    await capture(app, page, 'checks-grouped');
    await page.keyboard.press('Control+k');
    model.frames.push(
      { calls: [{ name: 'validate', arguments: {} }] },
      { calls: [{ name: 'delete', arguments: { instanceIds: [ids[1], ids[3], ids[4]] } }] },
      { calls: [{ name: 'validate', arguments: {} }] },
      { text: '已移除两处重叠零件和悬空件，校验无错误。' },
    );
    await send(page, '检查并修复问题');
    await done(page);
    const lastRequest = model.requests.at(-1) as { messages: { role: string; content: unknown }[] };
    const validations = lastRequest.messages
      .filter((r) => r.role === 'tool' && typeof r.content === 'string')
      .map((r) => JSON.parse(r.content as string) as ToolResult)
      .filter((r) => r.ok && typeof r.data === 'object' && r.data && 'issues' in r.data);
    expect(validations.at(-1)).toMatchObject({ data: { issues: [] } });
    const firstValidation = validations.at(-2);
    if (
      !firstValidation?.ok ||
      !firstValidation.data ||
      typeof firstValidation.data !== 'object' ||
      Array.isArray(firstValidation.data)
    )
      throw new Error('Missing validate');
    const issues = firstValidation.data.issues as { kind: string }[];
    expect(issues.filter((i) => i.kind === 'collision')).toHaveLength(2);
    expect(issues.filter((i) => i.kind === 'floating')).toHaveLength(1);

    // AI-05: stop preserves completed copy edits; a concurrent manual addition survives merging and undo.
    model.frames.push(
      { calls: [{ name: 'replace_color', arguments: { fromColorId: 'c:bright-red', toColorId: targetColor } }] },
      { text: '颜色已修改，正在进一步检查…', hold: true },
    );
    await send(page, '修改颜色，稍后停止');
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)?.text))
      .toContain('颜色已修改');
    expect(
      await page.evaluate(() => window.brickloopEditorTest.expanded().every((r) => r.colorId === 'c:bright-red')),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        window.brickloopEditorTest.command({
          type: 'part.add',
          partId: 'ld:3001',
          colorId: 'c:bright-red',
          transform: [1000, -24, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        }),
      ),
    ).toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().previewing)).toBe(false);
    await page.locator('.ai-task-heading').last().getByRole('button', { name: '停止', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.tasks().at(-1)?.status))
      .toBe('pending_merge');
    await page.evaluate(() => window.brickloopEditorTest.taskMerge(window.brickloopEditorTest.tasks().at(-1)!.taskId));
    await done(page);
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().state.locked)).toBeNull();
    await page.getByTestId('review-bar').getByRole('button', { name: '撤销整轮', exact: true }).click();
    expect(
      await page.evaluate(() => window.brickloopEditorTest.expanded().every((r) => r.colorId === 'c:bright-red')),
    ).toBe(true);

    // AI-06: invalid parts produce structured failures and the conversation continues.
    model.frames.push(
      {
        calls: [
          {
            name: 'place_part',
            arguments: {
              partId: 'ld:does-not-exist',
              colorId: 'c:bright-red',
              pose: { kind: 'grid', x: 0, z: 0, level: 3 },
            },
          },
        ],
      },
      { text: '目录中没有这个零件，未修改模型。' },
    );
    await send(page, '放置不存在的零件');
    await expect.poll(() => page.evaluate(async () => (await window.brickloop.aiSnapshot()).running)).toBe(false);
    await expect(page.getByRole('region', { name: '本轮修改审阅' })).toHaveCount(0);
    expect(JSON.stringify(model.requests.at(-1))).toContain('PART_NOT_FOUND');

    await page.getByRole('button', { name: 'AI 设置', exact: true }).click();
    await capture(app, page, 'settings-ai');
    await page.getByRole('button', { name: '添加', exact: true }).click();
    await capture(app, page, 'settings-provider');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('tab', { name: '外部智能体', exact: true }).click();
    await page.getByRole('checkbox', { name: '允许外部智能体连接', exact: true }).click();
    await expect
      .poll(() => page.evaluate(async () => (await window.brickloop.aiSnapshot()).settings.mcpEnabled))
      .toBe(true);
    await page
      .locator('.ai-settings-modal .ant-modal-footer')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    // AI-08 uses the shipped development shim and official SDK, never a direct bridge shortcut.
    client = new Client({ name: '离线验收客户端', version: '1.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(root, 'packages/mcp/bin/brickloop-mcp.mjs'), '--pipe', pipe],
        env,
        stderr: 'pipe',
      }),
    );
    const call = client.callTool({
      name: 'place_part',
      arguments: { partId: 'ld:3001', colorId: 'c:bright-red', pose: { kind: 'grid', x: 20, z: 0, level: 3 } },
    });
    await expect(page.getByText('允许“离线验收客户端”连接？', { exact: true })).toBeVisible();
    await capture(app, page, 'mcp-confirm');
    await page.getByRole('button', { name: '允许', exact: true }).click();
    const mcpResult = await call;
    expect(mcpResult.isError).not.toBe(true);
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().history.at(-1))).toMatchObject({
      source: 'mcp',
      label: '外部智能体：place_part',
    });
    await expect(page.getByTestId('external-agent-status')).toBeVisible();
    await capture(app, page, 'mcp-status');
    await page.getByRole('button', { name: '断开', exact: true }).click();
    await expect(page.getByTestId('external-agent-status')).not.toBeVisible();
    await client.close();
    client = undefined;
    await page.evaluate(async () => {
      const snapshot = await window.brickloop.aiSnapshot();
      await window.brickloop.aiSaveSettings({ ...snapshot.settings, mcpEnabled: false });
      await window.brickloopEditorTest.flush();
    });
    // AI-07: a synthetic non-sk key cannot occur in the profile, logs or recovery project packages.
    const savedFile = path.join(directory, 'ai-review.brkl');
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, savedFile);
    await page.evaluate(() => window.brickloopEditorTest.save(true));
    const savedProject = unzipSync(await readFile(savedFile));
    expect(savedProject['document.json']).toBeDefined();
    const historyText = new TextDecoder().decode(savedProject['ai/history.jsonl']);
    expect(historyText).toContain('把所有红色换成 S031');
    expect(historyText).toContain('"resource"');
    expect(historyText).not.toContain('"base64"');
    for (const bytes of Object.values(savedProject)) expect(Buffer.from(bytes).includes(Buffer.from(key))).toBe(false);
    const files = await readdir(directory, { recursive: true, withFileTypes: true });
    for (const file of files.filter((f) => f.isFile())) {
      const location = path.join(file.parentPath, file.name);
      try {
        expect((await readFile(location)).includes(Buffer.from(key)), location).toBe(false);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EBUSY') throw err;
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await client?.close();
    if (app) {
      const windows = app.windows();
      if (windows[0])
        await windows[0].evaluate(() => window.brickloopEditorTest?.prepareClose()).catch(() => undefined);
      await app.close();
    }
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});
