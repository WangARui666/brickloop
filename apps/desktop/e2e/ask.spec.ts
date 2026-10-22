import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import type { ElectronApplication, Page } from '@playwright/test';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';
import type { DesktopApi } from '../src/shared/api';
import { fakeModel } from './ai-model-fixture';
declare global {
  interface Window {
    brickloopEditorTest: EditorTestApi;
    brickloop: DesktopApi;
  }
}
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
  root = path.resolve(desktop, '../..');
const shots = path.join(root, '.devdata/m8-2-shots');
const move = (id: string, x: number) => ({
  name: 'move',
  arguments: { instanceIds: [id], delta: { x_ldu: x, y_ldu: 0, z_ldu: 0 } },
});
async function openAsk(page: Page, ids: string[]) {
  await page.evaluate((ids) => window.brickloopEditorTest.select(ids.map((id) => [id])), ids);
  await page.locator('.viewport-surface').focus();
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('selection-ask-input')).toBeVisible();
}
async function done(page: Page, status = 'merged') {
  await expect
    .poll(() => page.evaluate(() => window.brickloopEditorTest.tasks().at(-1)?.status), { timeout: 45000 })
    .toBe(status);
}
test('ASK-01–ASK-04: contextual entry, scope recovery, references, background editing and review', async () => {
  test.setTimeout(240000);
  await mkdir(shots, { recursive: true });
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/ask-')),
    model = await fakeModel();
  let app: ElectronApplication | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    app = await launchElectron({ args: [desktop], env: { ...env, BRICKLOOP_DATA_DIR: directory } });
    const page = await app.firstWindow();

    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.setContentSize(1440, 900);
      w.webContents.setBackgroundThrottling(false);
    });
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45000,
    });
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
    await page.evaluate(async (endpoint) => {
      await window.brickloop.aiSaveProvider(
        {
          id: crypto.randomUUID(),
          type: 'compatible',
          name: '本机选区验收',
          endpoint,
          model: 'offline-model',
          models: ['offline-model'],
          proxy: 'system',
          proxyUrl: '',
        },
        'offline-key',
      );
    }, model.endpoint);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
    const ids = await page.evaluate(async () => {
      const api = window.brickloopEditorTest;
      for (const [x, z] of [
        [-100, -40],
        [0, -40],
        [100, -40],
        [0, 80],
      ])
        api.command({
          type: 'part.add',
          partId: 'ld:3001',
          colorId: 'c:bright-red',
          transform: [x!, -24, z!, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        });
      await api.meshesReady();
      api.action('view.fitAll');
      const ids = api.expanded().map((r) => r.path.at(-1)!);
      api.select(ids.slice(0, 3).map((id) => [id]));
      return ids;
    });
    await expect(page.getByTestId('selection-ask-button')).toBeVisible();
    await page.screenshot({
      path: path.join(shots, 'm8-3-01-selection-button.png'),
      animations: 'disabled',
      scale: 'css',
    });
    const initial = await page.getByTestId('selection-ask-button').boundingBox();
    await page.evaluate(() => window.brickloopEditorTest.orbit(0.7));
    await expect
      .poll(async () => JSON.stringify(await page.getByTestId('selection-ask-button').boundingBox()))
      .not.toBe(JSON.stringify(initial));
    await openAsk(page, ids.slice(0, 3));
    const input = page.getByRole('textbox', { name: '让 AI 修改选中部分', exact: true });
    await expect(input).toBeFocused();
    await input.fill('把 @');
    await expect(page.getByRole('listbox', { name: '引用候选' })).toBeVisible();
    await page.screenshot({
      path: path.join(shots, 'm8-3-02-input-mentions.png'),
      animations: 'disabled',
      scale: 'css',
    });
    await input.dispatchEvent('compositionstart');
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
    await expect(input).toHaveValue('把 @');
    await expect(page.getByTestId('selection-ask-input')).toBeVisible();
    await input.dispatchEvent('compositionend');
    await input.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await input.fill('范围测试');
    model.frames.push(
      { gate: 'scope', calls: [move(ids[3]!, 40)] },
      { calls: [move(ids[0]!, 20)] },
      { text: '已修改选中部分。' },
    );
    await input.press('Enter');
    await expect.poll(() => model.waiting('scope')).toBe(true);
    await expect(page.getByTestId('selection-ask-status')).toBeVisible();
    await expect(page.locator('.ai-panel')).toHaveCount(0);
    await expect(page.locator('.ai-unread')).toBeVisible();
    expect(await page.evaluate(() => window.brickloopEditorTest.ask().scopes[0]?.scope?.paths)).toEqual(
      ids.slice(0, 3).map((id) => [id]),
    );
    await page.screenshot({
      path: path.join(shots, 'm8-3-03-running-status.png'),
      animations: 'disabled',
      scale: 'css',
    });
    model.release('scope');
    await done(page);
    await expect(page.getByTestId('review-bar')).toBeVisible();
    await expect(page.getByTestId('selection-ask-status')).toHaveCount(0);
    expect(JSON.stringify(model.requests)).toContain('OUT_OF_SCOPE');
    const positions = await page.evaluate(() => window.brickloopEditorTest.expanded());
    expect(positions.find((r) => r.path.at(-1) === ids[3])?.matrix[12]).toBe(0);
    expect(positions.find((r) => r.path.at(-1) === ids[0])?.matrix[12]).toBe(-80);
    await page.evaluate(() => {
      window.brickloopEditorTest.select([]);
    });
    await page.locator('.viewport-surface').focus();
    await page.keyboard.press('Control+k');
    const panelInput = page.getByRole('textbox', { name: '给 AI 助手的消息' });
    await expect(panelInput).toBeFocused();
    await expect(page.locator('.ai-user').first()).toContainText('选中 3 件');
    await expect(page.locator('.ai-unread')).toHaveCount(0);

    // ASK-03 uses the real suggestion UI and asserts the server's actual request body.
    const sub = await page.evaluate(async (id) => {
      const api = window.brickloopEditorTest;
      api.reviewEnd();
      api.command({ type: 'submodel.create', paths: [[id]], name: '车身' });
      return Object.values(api.snapshot().document.models).find((m) => m.name === '车身')!;
    }, ids[2]!);
    await panelInput.fill('查看 @车');
    await page.getByRole('option').filter({ hasText: '@车身' }).click();
    await expect(panelInput).toHaveValue('查看 @车身 ');
    await panelInput.press('Enter');
    await done(page);
    const referenced = JSON.stringify(model.requests.at(-1));
    expect(referenced).toContain(sub.id);
    expect(referenced).toContain('车身');
    expect(referenced).toContain('由软件提供的引用数据');

    // Current provider/model/depth persists when the panel unmounts.
    await page.getByRole('combobox', { name: '深度' }).click();
    await page.getByTitle('深入', { exact: true }).click();
    await page.evaluate(() => window.brickloopEditorTest.structure());
    await openAsk(page, [ids[0]!]);
    await expect(page.getByTestId('selection-ask-input')).toContainText('深入');
    model.frames.push({ gate: 'parallel', calls: [move(ids[0]!, 20)] }, { text: '完成。' });
    await input.fill('后台编辑测试');
    await input.press('Enter');
    await expect.poll(() => model.waiting('parallel')).toBe(true);
    const task = await page.evaluate(() => window.brickloopEditorTest.tasks().at(-1)!);
    await page.evaluate((id) => {
      const api = window.brickloopEditorTest;
      api.command({ type: 'transform.translate', paths: [[id]], delta: [0, 0, 40], space: 'world' });
      api.select([[id]]);
    }, ids[3]!);
    // Status remains anchored to the first selection while a fresh prompt can open elsewhere.
    await page.getByTestId('selection-ask-button').click();
    await expect(page.getByTestId('selection-ask-input')).toBeVisible();
    await input.press('Escape');
    model.release('parallel');
    await done(page, 'pending_merge');
    await page.evaluate((id) => window.brickloopEditorTest.taskMerge(id), task.taskId);
    await done(page);
    const merged = await page.evaluate(() => window.brickloopEditorTest.expanded());
    expect(merged.find((r) => r.path.at(-1) === ids[0])?.matrix[12]).toBe(-60);
    expect(merged.find((r) => r.path.at(-1) === ids[3])?.matrix[14]).toBe(120);
    await expect(page.getByTestId('review-bar')).toBeVisible();

    // Stop retains completed edits and closes its status strip.
    await openAsk(page, [ids[0]!]);
    model.frames.push({ calls: [move(ids[0]!, 20)] }, { text: '正在检查', hold: true });
    await input.fill('停止测试');
    await input.press('Enter');
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)?.text))
      .toContain('正在检查');
    await page.getByTestId('selection-ask-status').getByRole('button', { name: '停止' }).click();
    await done(page);
    await expect(page.getByTestId('selection-ask-status')).toHaveCount(0);
    await page.evaluate(() => window.brickloopEditorTest.reviewMode('before'));
    await expect(page.getByTestId('selection-ask-button')).toHaveCount(0);
    await page.evaluate(() => window.brickloopEditorTest.reviewMode('after'));
    // Turning the switch off preserves the context but allows edits outside the selection.
    await openAsk(page, [ids[0]!]);
    await page.getByRole('switch', { name: '只改选中部分' }).click();
    model.frames.push({ calls: [move(ids[3]!, 20)] }, { text: '已完成不限范围的修改。' });
    await input.fill('不限范围测试');
    await input.press('Enter');
    await done(page);
    expect(
      (await page.evaluate(() => window.brickloopEditorTest.expanded())).find((r) => r.path.at(-1) === ids[3])
        ?.matrix[12],
    ).toBe(20);
    // Four independently scoped tasks can be started while only three strips are shown.
    const count = await page.evaluate(() => window.brickloopEditorTest.tasks().length);
    for (let i = 0; i < 4; i++) {
      const text = `多任务选区${i}`;
      model.route(text, [{ hold: true }]);
      await openAsk(page, [ids[i === 2 ? 3 : i % 2]!]);
      await expect(page.getByRole('switch', { name: '只改选中部分' })).toBeChecked();
      await input.fill(text);
      await input.press('Enter');
      await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.tasks().length)).toBe(count + i + 1);
    }
    await expect(page.getByTestId('selection-ask-status')).toHaveCount(3);
    const pending = await page.evaluate(() => window.brickloopEditorTest.tasks().slice(-4));
    expect(pending.at(-1)?.status).toBe('queued');
    for (const task of [...pending].reverse()) await page.evaluate((id) => window.brickloop.aiStop(id), task.taskId);
    await expect(page.getByTestId('selection-ask-status')).toHaveCount(0);
    // No-provider guidance remains keyboard dismissible.
    await page.evaluate(() => window.brickloopEditorTest.settings('ai'));
    await page.getByRole('button', { name: '删除 本机选区验收', exact: true }).click();
    await expect(page.getByRole('button', { name: '删除 本机选区验收', exact: true })).toHaveCount(0);
    await page
      .getByRole('dialog')
      .locator('.ant-modal-footer')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await openAsk(page, [ids[0]!]);
    await expect(page.getByTestId('selection-ask-input')).toContainText('请先在 AI 设置中添加服务商');
    await expect(page.getByRole('button', { name: '打开 AI 设置' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('selection-ask-input')).toHaveCount(0);
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await app.close();
    }
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});
