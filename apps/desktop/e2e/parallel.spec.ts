import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const place = (x: number, z = 0) => ({
  name: 'place_part',
  arguments: { partId: 'ld:3001', colorId: 'c:bright-red', pose: { kind: 'ldu', x_ldu: x, y_ldu: -24, z_ldu: z } },
});
async function start(page: Page, text: string) {
  return page.evaluate(async (text) => {
    const snapshot = await window.brickloop.aiSnapshot();
    return window.brickloop.aiStart({
      providerId: snapshot.settings.providers[0]!.id,
      model: 'offline-model',
      text,
      images: [],
      effort: 'balanced',
      selection: true,
      modelContext: true,
    });
  }, text);
}
async function status(page: Page, id: string, expected: string) {
  await expect
    .poll(() => page.evaluate((id) => window.brickloopEditorTest.tasks().find((t) => t.taskId === id)?.status, id), {
      timeout: 45000,
    })
    .toBe(expected);
}
async function shot(page: Page, name: string) {
  await page.mouse.move(10, 10);
  await page.screenshot({ path: path.join(shots, name), animations: 'disabled', scale: 'css' });
}
test('PAR-01–PAR-08: parallel copies, editing, queue, merge, conflicts, preview and close', async () => {
  test.setTimeout(240000);
  await mkdir(shots, { recursive: true });
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/parallel-')),
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
          name: '并行任务验收',
          endpoint,
          model: 'offline-model',
          models: ['offline-model'],
          proxy: 'system',
          proxyUrl: '',
          prices: { input: 1, output: 2, cacheRead: 0 },
        },
        'offline-parallel-key',
      );
    }, model.endpoint);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
    await page.keyboard.press('Control+k');
    const seed = await page.evaluate(async () => {
      const a = window.brickloopEditorTest;
      for (const x of [-200, 0, 200])
        a.command({
          type: 'part.add',
          partId: 'ld:3001',
          colorId: 'c:bright-red',
          transform: [x, -24, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        });
      await a.meshesReady();
      a.action('view.fitAll');
      a.select([]);
      a.markSaved();
      const catalog = await window.brickloop.assemblyCatalog(),
        colors = await window.brickloop.catalogColors();
      return {
        documentId: a.snapshot().document.documentId,
        ids: a.expanded().map((r) => r.path.at(-1)!),
        color: colors.factory.find(
          (c) => c.id !== 'c:bright-red' && catalog.parts.find((p) => p.id === 'ld:3001')!.colors.includes(c.id),
        )!.id,
      };
    });
    // PAR-01, PAR-02, PAR-07: changes remain isolated, even when active tabs change.
    model.route('任务甲', [{ calls: [move(seed.ids[0]!, 80)] }, { text: '左侧修改完成，等待自检。', gate: 'a' }]);
    model.route('任务乙', [{ calls: [move(seed.ids[2]!, 80)] }, { text: '右侧修改完成，等待自检。', gate: 'b' }]);
    const a = await start(page, '任务甲：调整左侧零件\n保持原有颜色。'),
      b = await start(page, '任务乙：调整右侧零件');
    await expect.poll(() => model.waiting('a') && model.waiting('b')).toBe(true);
    const before = await page.evaluate(() => window.brickloopEditorTest.snapshot());
    expect(before.previewing).toBe(false);
    expect(before.dirty).toBe(false);
    expect(before.state.locked).toBeNull();
    expect(before.document.models[before.document.rootModelId]!.instances[seed.ids[0]!]!.transform[0]).toBe(-200);
    await page.evaluate(() => {
      const a = window.brickloopEditorTest;
      a.command({
        type: 'part.add',
        partId: 'ld:3001',
        colorId: 'c:bright-red',
        transform: [0, -24, 130, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      });
    });
    for (const [id, title] of [
      [a, '任务甲：调整左侧零件'],
      [b, '任务乙：调整右侧零件'],
    ]) {
      const card = page.locator(`[data-task-id="${id}"]`);
      await expect(card).toHaveClass('ai-turn ai-task-card');
      await expect(card).toHaveCSS('border-top-color', 'rgba(255, 255, 255, 0.08)');
      await expect(card).toHaveCSS('border-radius', '8px');
      await expect(card.locator('.ai-task-header-row .ai-task-title')).toHaveText(title!);
      await expect(card.locator('.ai-task-header-row .ai-task-state')).toHaveText('运行中');
      await expect(
        card.locator('.ai-task-header-row').getByRole('button', { name: '停止', exact: true }),
      ).toBeVisible();
      await expect(card.getByText(/^约 US\$/)).toHaveCount(1);
      await expect(card.locator('.ai-task-meta')).toContainText('1 次调用');
      await expect(card).not.toContainText('输入 500');
    }
    await page.evaluate(() => window.brickloopEditorTest.taskPreview(null));
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.previewCounts().parts)).toBe(0);
    await page.locator('.ai-message-list').evaluate((element) => {
      element.scrollTop = 0;
    });
    await shot(page, '01-two-tasks-editing.png');
    const previewButton = page.locator(`[data-task-id="${a}"]`).getByRole('button', { name: '预览', exact: true });
    await expect(previewButton).toHaveAttribute('aria-pressed', 'false');
    await previewButton.click();
    await expect(previewButton).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(10, 10);
    await expect(previewButton).toHaveCSS('background-color', 'rgba(255, 138, 61, 0.14)');
    await expect(previewButton).toHaveCSS('color', 'rgb(255, 138, 61)');
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.previewCounts().parts)).toBe(1);
    await shot(page, '02-task-preview.png');
    const preview = await page.evaluate(() => window.brickloopEditorTest.previewCounts());
    await page.evaluate(() => window.brickloopEditorTest.orbit(0.9));
    await page.waitForTimeout(550);
    expect((await page.evaluate(() => window.brickloopEditorTest.previewCounts())).updates).toBe(preview.updates);
    await page.evaluate(() => window.brickloopEditorTest.taskPreview(null));
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.previewCounts().parts)).toBe(0);
    // A preview part is absent from the document/picking projection.
    expect(await page.locator('.brickloop-viewport').getAttribute('data-part-count')).toBe('4');
    // UI review: two running cards and one genuinely pending card, with no duplicated cost.
    model.route('任务丙', [{ calls: [move(seed.ids[1]!, 20)] }, { text: '中央微调完成，等待合并。', gate: 'mixed' }]);
    const mixed = await start(page, '任务丙：微调中央零件');
    await expect.poll(() => model.waiting('mixed')).toBe(true);
    await page.evaluate(() => {
      const api = window.brickloopEditorTest;
      api.select([api.expanded().at(-1)!.path]);
      api.command({ type: 'transform.translate', delta: [20, 0, 0] });
    });
    model.release('mixed');
    await status(page, mixed, 'pending_merge');
    const mixedCard = page.locator(`[data-task-id="${mixed}"]`);
    await expect(page.locator('.ai-task-state.task-running')).toHaveCount(2);
    await expect(page.locator('.ai-task-state.task-pending_merge')).toHaveCount(1);
    await expect(mixedCard.getByText(/^约 US\$/)).toHaveCount(1);
    await mixedCard.locator('.ai-task-cost').hover();
    await expect(page.getByRole('tooltip')).toHaveText('输入 1000 · 输出 100');
    await page.mouse.move(10, 10);
    await expect(page.getByRole('tooltip')).not.toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1200));
    await page.locator('.ai-message-list').evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(page.locator('.ai-task-card').first()).toBeInViewport({ ratio: 1 });
    await expect(mixedCard).toBeInViewport({ ratio: 1 });
    await page.locator('.ai-message-list').screenshot({
      path: path.join(shots, '05-three-task-cards.png'),
      animations: 'disabled',
      scale: 'device',
    });
    await mixedCard.getByRole('button', { name: '丢弃', exact: true }).click();
    await status(page, mixed, 'discarded');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
    const other = await page.evaluate(() => {
      const a = window.brickloopEditorTest;
      a.action('file.new');
      a.command({
        type: 'part.add',
        partId: 'ld:3001',
        colorId: 'c:bright-red',
        transform: [0, -24, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      });
      return a.snapshot().document.documentId;
    });
    expect(other).not.toBe(seed.documentId);
    model.release('a');
    model.release('b');
    await status(page, a, 'pending_merge');
    await status(page, b, 'pending_merge');
    const history = await page.evaluate(
      ({ target, other }) => ({
        target: window.brickloopEditorTest.savedHistory(target),
        other: window.brickloopEditorTest.savedHistory(other),
      }),
      { target: seed.documentId, other },
    );
    expect(history.target).toContain('任务甲');
    expect(history.target).toContain('任务乙');
    expect(history.other).toBe('');
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(1);
    await page.evaluate((id) => window.brickloopEditorTest.switch(id), seed.documentId);
    const n = await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length);
    await page.evaluate(
      (id) => Promise.all([window.brickloopEditorTest.taskMerge(id), window.brickloopEditorTest.taskMerge(id)]),
      a,
    );
    await status(page, a, 'merged');
    await page.evaluate((id) => window.brickloopEditorTest.taskMerge(id), b);
    await status(page, b, 'merged');
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length)).toBe(n + 2);
    // PAR-03: color vs movement conflicts as a whole instance, then resolves undoably.
    model.route('冲突任务', [{ calls: [move(seed.ids[1]!, 100)] }, { text: '已调整中央位置。', gate: 'conflict' }]);
    const c = await start(page, '冲突任务：移动中央零件');
    await expect.poll(() => model.waiting('conflict')).toBe(true);
    await page.evaluate(
      ({ id, color }) => {
        const a = window.brickloopEditorTest;
        a.select([[id]]);
        a.command({ type: 'color.set', colorId: color });
      },
      { id: seed.ids[1]!, color: seed.color },
    );
    model.release('conflict');
    await status(page, c, 'pending_merge');
    expect(
      (await page.evaluate((id) => window.brickloopEditorTest.tasks().find((t) => t.taskId === id)!.summary, c))
        ?.conflicts,
    ).toBe(1);
    await page.locator(`[data-task-id="${c}"]`).scrollIntoViewIfNeeded();
    await shot(page, '03-pending-conflict.png');
    await page.evaluate((id) => window.brickloopEditorTest.taskMerge(id), c);
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.previewCounts().parts)).toBe(0);
    await expect(page.locator('[data-review-group="conflicts"]')).toBeVisible();
    await expect(page.locator('.review-list-heading > strong')).toHaveText(/本轮修改\s*0\s*·\s*冲突\s*1/);
    await expect(page.getByTestId('review-bar')).not.toContainText('合并后新增问题');
    const conflictRow = page.locator('.review-conflict-row');
    const partName = await page.evaluate(async () => (await window.brickloop.catalogPart('ld:3001'))!.nameZh);
    await expect(conflictRow.locator('strong')).toHaveText(partName);
    await expect(conflictRow.locator('.review-swatch')).toHaveCount(1);
    await expect(conflictRow.locator('.review-location-text')).toContainText('步骤 1');
    await expect(conflictRow.locator('.review-tail')).toHaveText(seed.ids[1]!.slice(-6));
    await expect(conflictRow).toContainText('双方修改了同一对象');
    await expect(conflictRow.locator('.ant-btn-sm')).toHaveCount(2);
    await page.locator('.ai-review').scrollIntoViewIfNeeded();
    await shot(page, '04-merged-conflicts.png');
    const conflict = (await page.evaluate(() => window.brickloopEditorTest.review()))!.conflicts[0]!;
    await conflictRow.getByRole('button', { name: '用 AI 版本', exact: true }).click();
    await expect(conflictRow).toHaveCSS('opacity', '0.55');
    await expect(conflictRow).toContainText('已用 AI 版本');
    let current = await page.evaluate(() => window.brickloopEditorTest.snapshot().document);
    expect(current.models[current.rootModelId]!.instances[seed.ids[1]!]!.transform[0]).toBe(100);
    expect(current.models[current.rootModelId]!.instances[seed.ids[1]!]!.colorId).toBe('c:bright-red');
    await page.evaluate(() => window.brickloopEditorTest.action('edit.undo'));
    current = await page.evaluate(() => window.brickloopEditorTest.snapshot().document);
    expect(current.models[current.rootModelId]!.instances[seed.ids[1]!]!.colorId).toBe(seed.color);
    expect(await page.evaluate((key) => window.brickloopEditorTest.taskResolve(key, false), conflict.key)).toBe(true);
    await expect(conflictRow).toContainText('已保留我的');
    await expect(conflictRow).toHaveCSS('opacity', '0.55');
    // PAR-04: no intervening edits means automatic merge and review.
    model.route('直接应用', [{ calls: [move(seed.ids[0]!, 20)] }, { text: '完成' }]);
    const d = await start(page, '直接应用：微调左侧');
    await status(page, d, 'merged');
    expect((await page.evaluate(() => window.brickloopEditorTest.review()))?.items.length).toBeGreaterThan(0);
    // PAR-05: fourth request is queued, then starts automatically.
    await page.evaluate(() => window.brickloopEditorTest.concurrency(3));
    const queue: string[] = [];
    for (let i = 0; i < 4; i++) {
      model.route(`队列${i}`, [{ text: '处理中', gate: `q${i}` }]);
      queue.push(await start(page, `队列${i}`));
    }
    await status(page, queue[3]!, 'queued');
    await expect.poll(() => model.waiting('q0')).toBe(true);
    model.release('q0');
    await expect.poll(() => model.waiting('q3')).toBe(true);
    for (let i = 1; i < 4; i++) model.release(`q${i}`);
    for (const id of queue) await status(page, id, 'merged');
    // PAR-08: offset overlapping additions produce one new collision pair.
    model.route('碰撞任务', [
      { calls: [{ name: 'get_part_info', arguments: { partId: 'ld:3001' } }, place(1000)] },
      { text: '完成', gate: 'collision' },
    ]);
    const collision = await start(page, '碰撞任务：新增一件');
    await expect.poll(() => model.waiting('collision')).toBe(true);
    await page.evaluate(() =>
      window.brickloopEditorTest.command({
        type: 'part.add',
        partId: 'ld:3001',
        colorId: 'c:bright-red',
        transform: [1020, -24, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      }),
    );
    model.release('collision');
    await status(page, collision, 'pending_merge');
    await page.evaluate((id) => window.brickloopEditorTest.taskMerge(id), collision);
    expect((await page.evaluate(() => window.brickloopEditorTest.review()))!.newIssues).toBe(1);
    await expect(page.getByTestId('review-bar')).toContainText('合并后新增问题 1 处');
    await expect(page.locator('.review-new-issues')).toHaveCSS('color', 'rgb(245, 184, 61)');
    // MCP remains bound to the transaction's document after a tab switch.
    await page.evaluate(
      async ({ other, original, instanceId }) => {
        const api = window.brickloopEditorTest;
        await api.mcpTool('beginTransaction', 'External task');
        if (api.snapshot().state.locked !== 'mcp') throw new Error('Missing MCP lock');
        api.switch(other);
        if (api.snapshot().state.locked !== null) throw new Error('MCP lock leaked to another tab');
        if (
          !api.command({
            type: 'part.add',
            partId: 'ld:3001',
            colorId: 'c:bright-red',
            transform: [200, -24, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
          })
        )
          throw new Error('Other tab editing blocked');
        await api.mcpTool('move', { instanceIds: [instanceId], delta: { x_ldu: 20, y_ldu: 0, z_ldu: 0 } });
        await api.mcpTool('commitTransaction', {});
        api.switch(original);
        if (api.snapshot().state.locked !== null) throw new Error('MCP lock not released');
      },
      { other, original: seed.documentId, instanceId: seed.ids[0]! },
    );
    // Background summary/check work and the running task must not add work to the drag path.
    await page.evaluate(() => window.brickloopEditorTest.reviewEnd());
    const baseline = await page.evaluate(() => window.brickloopEditorTest.benchmark(10000));
    model.route('性能任务', [{ text: '处理中', gate: 'performance' }]);
    const performanceTask = await start(page, '性能任务');
    await status(page, performanceTask, 'running');
    const concurrent = await page.evaluate(() => window.brickloopEditorTest.benchmark(10000));
    await expect
      .poll(
        async () => {
          if (model.waiting('performance')) return 'ready';
          return page.evaluate((id) => {
            const api = window.brickloopEditorTest;
            return `${api.tasks().find((t) => t.taskId === id)?.status}/${api.aiState().turns.find((t) => t.id === id)?.result?.reason ?? 'preparing'}`;
          }, performanceTask);
        },
        { timeout: 45000 },
      )
      .toBe('ready');
    console.log('PAR 10,000-part drag', JSON.stringify({ baseline, concurrent }));
    await writeFile(path.join(shots, 'performance.json'), JSON.stringify({ baseline, concurrent }, null, 2));
    expect(concurrent.updateP95Ms!).toBeLessThan(Math.max(8, baseline.updateP95Ms! * 2));
    expect(concurrent.p95Ms!).toBeLessThan(Math.max(50, baseline.p95Ms! * 2));
    await page.evaluate((id) => window.brickloopEditorTest.taskDiscard(id), performanceTask);
    await page.evaluate(() => window.brickloopEditorTest.seed(3));
    // PAR-06: cancel keeps running, confirm stops/discards and never applies to another tab.
    model.route('关闭任务', [{ text: '处理中', gate: 'close' }]);
    const closing = await start(page, '关闭任务');
    await expect.poll(() => model.waiting('close')).toBe(true);
    await page.evaluate(() => window.brickloopEditorTest.action('file.close'));
    await expect(page.getByText('停止并丢弃 AI 任务？', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await status(page, closing, 'running');
    await page.evaluate(() => window.brickloopEditorTest.action('file.close'));
    await page.getByRole('button', { name: '丢弃', exact: true }).click();
    await status(page, closing, 'discarded');
    // A separate dirty-document prompt still protects the designer's edits.
    await expect(page.getByRole('button', { name: '不保存', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '不保存', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.snapshot().document.documentId)).toBe(other);
    expect(await page.evaluate(() => window.brickloopEditorTest.aiState().error)).toBeNull();
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
    await model.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
