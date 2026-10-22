import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import type { ElectronApplication, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { unzipSync } from 'fflate';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';
import type { DesktopApi } from '../src/shared/api';
import { fakeModel } from './ai-model-fixture';

declare global {
  interface Window {
    brickloop: DesktopApi;
    brickloopEditorTest: EditorTestApi;
  }
}
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
  root = path.resolve(desktop, '../..');
const shots = path.join(root, '.devdata/m9-3-shots'),
  results = path.join(root, '.devdata/e2e-results');
// Original, deterministic fixture: roughly 2,100 pieces, with a door, windows and pitched roof.
const cottage = `// Village cottage: floor, windowed walls and a stepped roof.
submodel('村舍', () => {
  for (let z=0; z<24; z+=2)
    for (let x=0; x<32; x+=4)
      part('3020', {x:x+2, z:z+1, y:1}, 'gray');
  for (let course=0; course<14; course++) {
    const y=4+course*3;
    for (let x=0; x<32; x++) {
      const window=(x>=5&&x<9||x>=23&&x<27)&&course>=4&&course<8;
      if (!window && !(x>=14&&x<18&&course<8))
        part('3005', {x:x+.5, z:.5, y}, 'tan');
      if (!window) part('3005', {x:x+.5, z:23.5, y}, 'tan');
    }
    for (let z=1; z<23; z++) {
      part('3005', {x:.5, z:z+.5, y}, 'tan');
      part('3005', {x:31.5, z:z+.5, y}, 'tan');
    }
  }
  for (let tier=0; tier<9; tier++)
    for (let z=-1; z<25; z+=2)
      for (let x=-2+tier*2; x<34-tier*2; x+=4)
        part('3020', {x:x+2, z:z+1, y:44+tier}, 'red');
});
instance('村舍', {x:0, z:0, y:0});`;

async function send(page: Page, text: string) {
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.brickloopEditorTest.tasks().at(-1)?.status), { timeout: 90_000 })
    .toBe('merged');
}
async function scriptMenu(page: Page) {
  await page.evaluate(() => {
    window.brickloopEditorTest.structure();
    window.brickloopEditorTest.select([]);
  });
  const row = page
    .locator('.definition-row')
    .filter({ hasText: '村舍', has: page.locator('.build-script-badge') })
    .first();
  await expect(row.locator('.build-script-badge')).toBeVisible();
  await row.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '查看脚本', exact: true })).toBeVisible();
}
function toolResults(page: Page) {
  return page.evaluate(() =>
    window.brickloopEditorTest
      .aiState()
      .turns.at(-1)
      ?.events.filter((e) => e.type === 'tool_result')
      .map((e) => (e.type === 'tool_result' ? e : null)),
  );
}
test('BS-04/06/07: Worker, AI review, deterministic replace, project IO, script UI and real MCP', async () => {
  test.setTimeout(360_000);
  await mkdir(shots, { recursive: true });
  await mkdir(results, { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/buildscript-e2e-')),
    model = await fakeModel();
  const pipe = `\\\\.\\pipe\\brickloop-mcp-buildscript-${randomUUID()}`;
  let app: ElectronApplication | undefined, client: Client | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    app = await launchElectron({
      args: [desktop],
      env: { ...env, BRICKLOOP_DATA_DIR: directory, BRICKLOOP_MCP_PIPE: pipe },
    });
    const page = await app.firstWindow(),
      errors: string[] = [];

    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.setContentSize(1440, 900);
      w.webContents.setBackgroundThrottling(false);
    });
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45_000,
    });
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
    const workerSmoke = await page.evaluate(async () => {
      const api = window.brickloopEditorTest;
      await api.mcpTool('beginTransaction', 'worker smoke');
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      const result = await api.mcpTool('run_build_script', {
        scriptId: 'smoke',
        code: 'let n=0; for(let i=0;i<1000000;i++)n+=i; part("3001",{x:50,z:0,y:3},"Red");',
      });
      clearInterval(timer);
      await api.mcpTool('commitTransaction', {});
      api.action('edit.undo');
      return { result, ticks };
    });
    expect(workerSmoke.result, JSON.stringify(workerSmoke)).toMatchObject({ ok: true });
    expect(workerSmoke.ticks).toBeGreaterThan(3);
    await page.evaluate(async (endpoint) => {
      await window.brickloop.aiSaveProvider(
        {
          id: crypto.randomUUID(),
          type: 'compatible',
          name: '本机脚本验收',
          endpoint,
          model: 'offline-model',
          models: ['offline-model'],
          proxy: 'system',
          proxyUrl: '',
        },
        'offline-key',
      );
      const snapshot = await window.brickloop.aiSnapshot();
      await window.brickloop.aiSaveSettings({ ...snapshot.settings, mcpEnabled: true });
    }, model.endpoint);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
    const history = await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length);
    model.frames.push(
      {
        calls: [
          { name: 'get_build_example', arguments: { id: 'cottage' } },
          { name: 'get_design_guide', arguments: { category: 'buildings' } },
        ],
      },
      {
        calls: [
          {
            name: 'run_build_script',
            arguments: { scriptId: 'cottage', name: '村舍搭建脚本', code: cottage, seed: 42 },
          },
        ],
      },
      { calls: [{ name: 'view_layers', arguments: { modelPath: [], fromLevel: 1, toLevel: 2 } }] },
      { text: '小屋已搭好，已查看层图。连通性和薄弱连接警告留在结果中供继续修整。' },
    );
    await send(page, '用脚本搭建约两千件的村舍');
    await expect(page.locator('.ai-tool summary').filter({ hasText: '运行搭建脚本' })).toHaveCount(1);
    const events = await toolResults(page);
    await writeFile(path.join(results, 'm9-3-tool-results.json'), JSON.stringify(events, null, 2));
    const state = await page.evaluate(() => window.brickloopEditorTest.snapshot());
    const outputs = state.document.models[state.document.rootModelId]!.extensions['brickloop.buildScripts'] as Record<
      string,
      { hash: string; instanceIds: string[]; script: { stats: { parts: number; ms: number } } }
    >;
    expect(outputs.cottage, JSON.stringify(events)).toBeDefined();
    expect(outputs.cottage!.script.stats.parts).toBeGreaterThan(1900);
    expect(outputs.cottage!.script.stats.parts).toBeLessThan(2200);
    expect(state.history).toHaveLength(history + 1);
    await expect(page.getByTestId('review-bar')).toBeVisible();
    const eventsText = JSON.stringify(events);
    const writeMs = Number(/"writeMs":([\d.]+)/.exec(eventsText)?.[1]);
    expect(writeMs).toBeLessThan(1000);
    await page.evaluate(async () => {
      const api = window.brickloopEditorTest;
      api.reviewEnd();
      await api.meshesReady();
      api.action('view.fitAll');
      api.structure();
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await scriptMenu(page);
    await page.screenshot({ path: path.join(shots, '01-script-badge-menu.png'), animations: 'disabled' });
    await page.getByRole('menuitem', { name: '查看脚本', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '搭建脚本代码（只读）' })).toHaveValue(cottage);
    await page.screenshot({ path: path.join(shots, '02-view-script.png'), animations: 'disabled' });
    await page
      .locator('.build-script-dialog .ant-modal-footer')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    client = new Client({ name: '脚本 MCP 验收', version: '1.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(root, 'packages/mcp/bin/brickloop-mcp.mjs'), '--pipe', pipe],
        env,
        stderr: 'pipe',
      }),
    );
    const mcpCall = client.callTool({ name: 'run_build_script', arguments: { scriptId: 'cottage' } });
    await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '允许', exact: true }).click();
    const repeated = await mcpCall;
    expect(repeated.isError, JSON.stringify(repeated)).not.toBe(true);
    expect(JSON.stringify(repeated)).toContain(outputs.cottage!.hash);
    const hash = outputs.cottage!.hash;
    await page.evaluate(() =>
      window.brickloopEditorTest.command({
        type: 'part.add',
        partId: 'ld:3001',
        colorId: 'c:bright-red',
        transform: [900, -24, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      }),
    );
    const sentinel = await page.evaluate(() => window.brickloopEditorTest.expanded().at(-1)!.path.at(-1)!);
    const recolored = await client.callTool({
      name: 'run_build_script',
      arguments: { scriptId: 'cottage', code: cottage.replace("'red'", "'blue'") },
    });
    expect(recolored.isError, JSON.stringify(recolored)).not.toBe(true);
    expect(JSON.stringify(recolored)).not.toContain(hash);
    expect(
      await page.evaluate((id) => window.brickloopEditorTest.expanded().some((r) => r.path.at(-1) === id), sentinel),
    ).toBe(true);
    // Save/open real ZIP members and ensure .io carries geometry only.
    const saved = path.join(directory, 'cottage.brkl');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, saved);
    await page.evaluate(() => window.brickloopEditorTest.save(true));
    const members = unzipSync(await readFile(saved));
    expect(new TextDecoder().decode(members['ai/scripts/cottage.js'])).toContain("'blue'");
    expect(JSON.parse(new TextDecoder().decode(members['ai/scripts/index.json']))).toMatchObject([
      { scriptId: 'cottage', seed: 42 },
    ]);
    const io = path.join(directory, 'cottage.io');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, io);
    expect((await client.callTool({ name: 'export_io', arguments: { destination: 'ask_host' } })).isError).not.toBe(
      true,
    );
    expect(Object.keys(unzipSync(await readFile(io))).some((name) => name.startsWith('ai/'))).toBe(false);
    // BS-07: manual change opens the choice. Preserve old identities, then detach through the menu.
    await page.evaluate(() => {
      const api = window.brickloopEditorTest,
        row = api.expanded().find((r) => r.path.length > 1)!;
      api.enter(row.path.slice(0, -1));
      api.command({ type: 'color.set', paths: [row.path], colorId: 'c:bright-red' });
      api.enter([]);
    });
    await scriptMenu(page);
    await page.getByRole('menuitem', { name: '重新运行', exact: true }).click();
    await expect(page.getByText('这些修改会被覆盖', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '仍然覆盖', exact: true }).click();
    await expect(page.getByRole('button', { name: '复制代码', exact: true })).toBeVisible({ timeout: 45_000 });
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(2098);
    await page
      .locator('.build-script-dialog .ant-modal-footer')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await page.evaluate(() => {
      const api = window.brickloopEditorTest,
        row = api.expanded().find((r) => r.path.length > 1)!;
      api.enter(row.path.slice(0, -1));
      api.command({ type: 'color.set', paths: [row.path], colorId: 'c:bright-red' });
      api.enter([]);
    });
    await scriptMenu(page);
    await page.getByRole('menuitem', { name: '重新运行', exact: true }).click();
    await expect(page.getByText('这些修改会被覆盖', { exact: true })).toBeVisible();
    const oldIds = await page.evaluate(() =>
      Object.values(window.brickloopEditorTest.snapshot().document.models).flatMap((m) => Object.keys(m.instances)),
    );
    await page.getByRole('button', { name: '转为普通零件后运行', exact: true }).click();
    await expect(page.getByRole('button', { name: '复制代码', exact: true })).toBeVisible({ timeout: 45_000 });
    expect(
      await page.evaluate((ids) => {
        const current = new Set(
          Object.values(window.brickloopEditorTest.snapshot().document.models).flatMap((m) => Object.keys(m.instances)),
        );
        return ids.every((id) => current.has(id));
      }, oldIds),
    ).toBe(true);
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(2097 * 2 + 1);
    await page
      .locator('.build-script-dialog .ant-modal-footer')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await scriptMenu(page);
    await page.getByRole('menuitem', { name: '转为普通零件', exact: true }).click();
    await expect(page.locator('.build-script-badge')).toHaveCount(0);
    const invalid = await client.callTool({
      name: 'run_build_script',
      arguments: { scriptId: 'bad', code: '\nthrow new Error("fixture error")' },
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).toContain('line');
    const reopened = path.join(directory, 'reopened.brkl');
    await writeFile(reopened, await readFile(saved));
    await page.evaluate((file) => window.brickloopEditorTest.open(file), reopened);
    const readBack = await client.callTool({ name: 'get_build_script', arguments: { scriptId: 'cottage' } });
    expect(readBack.isError, JSON.stringify(readBack)).not.toBe(true);
    expect(JSON.stringify(readBack)).toContain("'blue'");
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(2098);
    await scriptMenu(page);
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
    await writeFile(
      path.join(results, 'm9-3-metrics.json'),
      JSON.stringify(
        {
          pieces: outputs.cottage!.script.stats.parts,
          engineMs: outputs.cottage!.script.stats.ms,
          writeMs,
          workerHeartbeat: workerSmoke.ticks,
        },
        null,
        2,
      ),
    );
  } finally {
    await client?.close();
    if (app) {
      await app
        .windows()[0]
        ?.evaluate(() => window.brickloopEditorTest?.prepareClose())
        .catch(() => undefined);
      await app.close();
    }
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});
