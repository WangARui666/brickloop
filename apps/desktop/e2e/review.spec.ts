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
const shots = path.join(root, '.devdata/m8-1-shots');
async function finish(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.brickloopEditorTest.tasks().some((t) => t.status === 'running' || t.status === 'queued'),
        ),
      { timeout: 45000 },
    )
    .toBe(false);
  await expect(page.getByTestId('review-bar')).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await finish(page);
}
async function capture(page: Page, file: string) {
  await page.locator('.ai-review').evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.mouse.move(10, 10);
  await page.screenshot({ path: path.join(shots, file), animations: 'disabled' });
}
async function orbit(page: Page) {
  return page.evaluate(async () => {
    const api = window.brickloopEditorTest;
    const camera = api.snapshot().workspace.camera;
    const samples: number[] = [];
    const baseline = api.metrics().frames.length;
    const surface = document.querySelector<HTMLElement>('.brickloop-viewport')!;
    const updates = surface.dataset.reviewUpdates;
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      api.orbit(i * 0.025);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return {
      medianMs: samples[50]!,
      medianFps: 1000 / samples[50]!,
      p95Ms: samples[95]!,
      updatesStable: surface.dataset.reviewUpdates === updates,
      frames: api.metrics().frames.length - baseline,
      camera,
    };
  });
}

test('REV-01–REV-07: real AI transactions, per-item review, before mode, occurrences and performance', async () => {
  test.setTimeout(240000);
  await mkdir(shots, { recursive: true });
  await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.devdata/e2e/review-')),
    model = await fakeModel();
  let app: ElectronApplication | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    app = await launchElectron({ args: [desktop], env: { ...env, BRICKLOOP_DATA_DIR: directory }, timeout: 30000 });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setContentSize(1440, 900);
      window.webContents.setBackgroundThrottling(false);
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
          name: '本机审阅验收',
          endpoint,
          model: 'offline-model',
          models: ['offline-model'],
          proxy: 'system',
          proxyUrl: '',
        },
        'offline-review-key',
      );
    }, model.endpoint);
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
    await page.keyboard.press('Control+k');
    const seed = await page.evaluate(async () => {
      const api = window.brickloopEditorTest;
      for (const [x, z] of [
        [-100, -40],
        [0, -40],
        [100, -40],
        [-100, 60],
      ])
        api.command({
          type: 'part.add',
          partId: 'ld:3001',
          colorId: 'c:bright-red',
          transform: [x!, -24, z!, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        });
      await api.meshesReady();
      api.select([]);
      api.action('view.fitAll');
      const colors = await window.brickloop.catalogColors();
      const part = (await window.brickloop.assemblyCatalog()).parts.find((part) => part.id === 'ld:3001')!;
      return {
        ids: api.expanded().map((row) => row.path.at(-1)!),
        color: colors.factory.find((color) => color.id !== 'c:bright-red' && part.colors.includes(color.id))!.id,
        before: api.snapshot().document,
        selection: api.snapshot().workspace.selection,
      };
    });
    model.frames.push(
      { calls: [{ name: 'get_part_info', arguments: { partId: 'ld:3001' } }] },
      {
        calls: [
          { name: 'delete', arguments: { instanceIds: [seed.ids[0]] } },
          { name: 'set_color', arguments: { instanceIds: [seed.ids[1], seed.ids[2]], colorId: seed.color } },
          { name: 'move', arguments: { instanceIds: [seed.ids[2]], delta: { x_ldu: 0, y_ldu: 0, z_ldu: 100 } } },
          {
            name: 'place_part',
            arguments: {
              partId: 'ld:3001',
              colorId: 'c:bright-red',
              pose: { kind: 'ldu', x_ldu: 0, y_ldu: -24, z_ldu: 60 },
            },
          },
          {
            name: 'place_part',
            arguments: {
              partId: 'ld:3001',
              colorId: 'c:bright-red',
              pose: { kind: 'ldu', x_ldu: -100, y_ldu: -24, z_ldu: 160 },
            },
          },
        ],
      },
      { text: '已新增两件，移除一件，并调整颜色和位置。可以逐项审阅。' },
    );
    await send(page, '调整配色和布局，保留清晰的零件间距');
    const review = await page.evaluate(() => window.brickloopEditorTest.review());
    expect(review?.items).toHaveLength(5);
    expect(review?.beforeRevision).toBe(seed.before.revision);
    expect(review?.items.find((item) => item.instanceId === seed.ids[2])?.kinds).toEqual(['recolored', 'moved']);
    const surface = page.locator('.brickloop-viewport');
    await expect(surface).toHaveAttribute('data-review-added', '2');
    await expect(surface).toHaveAttribute('data-review-changed', '2');
    await expect(surface).toHaveAttribute('data-review-moved', '1');
    await expect(surface).toHaveAttribute('data-review-ghosts', '2');
    await capture(page, '01-viewport-review.png');
    const camera = await page.evaluate(() => window.brickloopEditorTest.camera());
    await page.evaluate(() => {
      window.brickloopEditorTest.action('view.fitAll');
      window.brickloopEditorTest.zoomReview(0.8);
    });
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const viewportBox = (await page.locator('.viewport-surface').boundingBox())!;
    await page.screenshot({
      path: path.join(shots, '04-viewport-detail.png'),
      animations: 'disabled',
      clip: {
        x: viewportBox.x + viewportBox.width * 0.1,
        y: viewportBox.y + viewportBox.height * 0.26,
        width: viewportBox.width * 0.8,
        height: viewportBox.height * 0.48,
      },
    });
    await page.evaluate((camera) => window.brickloopEditorTest.restoreCamera(camera, camera.span), camera);
    const recolored = review!.items.find((item) => item.instanceId === seed.ids[1])!;
    const row = page.locator(`[data-review-key="${recolored.key}"]`);
    await expect(row.locator('.review-state')).toHaveCount(0);
    await expect(row.locator('.review-swatch').first()).toHaveCSS('width', '12px');
    await expect(row.locator('.review-tail')).toHaveText(recolored.instanceId.slice(-6));
    await row.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(row).toHaveAttribute('data-review-state', 'rejected');
    await expect(row.locator('.review-row-main > strong')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(row.getByRole('button', { name: '恢复', exact: true })).toBeEnabled();
    expect(
      await page.evaluate(
        (id) => window.brickloopEditorTest.expanded().find((row) => row.path.at(-1) === id)?.colorId,
        seed.ids[1]!,
      ),
    ).toBe('c:bright-red');
    await capture(page, '02-review-list-rejected.png');
    await page.locator('.viewport-surface').click({ position: { x: 20, y: 60 } });
    await page.keyboard.press('Control+z');
    await expect(row).toHaveAttribute('data-review-state', 'accepted');
    const added = page.locator('[data-review-group="added"]');
    const count = await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length);
    await added.getByRole('button', { name: '拒绝本组' }).click();
    await expect(surface).toHaveAttribute('data-review-added', '0');
    await added.getByRole('button', { name: '恢复本组' }).click();
    await expect(surface).toHaveAttribute('data-review-added', '2');
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length)).toBe(count + 2);

    // Before mode keeps selection and camera, blocks commands/toolbar/paste/drop/send, Esc exits.
    await page.evaluate((id) => window.brickloopEditorTest.select([[id]]), seed.ids[1]!);
    const previous = await page.evaluate(() => ({
      selection: window.brickloopEditorTest.snapshot().workspace.selection,
      camera: window.brickloopEditorTest.camera(),
    }));
    await page.getByTestId('review-bar').getByText('改前', { exact: true }).click();
    await expect(surface).toHaveAttribute('data-part-count', '4');
    await expect(page.getByText('正在查看改前状态')).toBeVisible();
    await expect(page.getByRole('toolbar').getByRole('button').first()).toBeDisabled();
    await expect(page.getByRole('textbox', { name: '给 AI 助手的消息' })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: '给 AI 助手的消息' })).toHaveAttribute(
      'placeholder',
      '查看改前状态时不能发送',
    );
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.brickloopEditorTest.command({ type: 'edit.delete' }))).toBe(false);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Control+v');
    expect(
      await page.evaluate(() => ({
        selection: window.brickloopEditorTest.snapshot().workspace.selection,
        camera: window.brickloopEditorTest.camera(),
      })),
    ).toEqual(previous);
    await capture(page, '03-before-mode.png');
    await page.keyboard.press('Escape');
    await expect(surface).toHaveAttribute('data-part-count', '5');

    // A manual edit supersedes the changed item and prevents round undo.
    await page.evaluate(
      (id) => window.brickloopEditorTest.command({ type: 'transform.translate', paths: [[id]], delta: [0, -24, 0] }),
      seed.ids[1]!,
    );
    await expect(row).toHaveAttribute('data-review-state', 'superseded');
    await expect(row.getByRole('button', { name: '拒绝', exact: true })).toBeDisabled();
    await expect(page.getByTestId('review-bar').getByRole('button', { name: '撤销整轮' })).toBeDisabled();
    await expect(page.locator('.review-history-hint')).toHaveText('之后已有其他修改，请使用撤销历史');
    await page.evaluate(() => window.brickloopEditorTest.action('edit.undo'));
    expect(await page.evaluate(() => window.brickloopEditorTest.reviewUndo())).toBe(true);
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(4);

    // One definition change expands to all three occurrences and survives tab switching.
    const shared = await page.evaluate(() => {
      const api = window.brickloopEditorTest;
      api.action('select.all');
      api.command({ type: 'submodel.create', name: '共享底座' });
      const snapshot = api.snapshot(),
        root = snapshot.document.models[snapshot.document.rootModelId]!;
      const instance = Object.values(root.instances).find((instance) => instance.ref.kind === 'model')!;
      if (instance.ref.kind !== 'model') throw new Error('submodel');
      for (const x of [500, 1000])
        api.command({
          type: 'submodel.instantiate',
          modelId: instance.ref.modelId,
          transform: [x, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        });
      api.select([]);
      return { occurrence: instance.id, documentId: snapshot.document.documentId };
    });
    model.frames.push(
      { calls: [{ name: 'get_part_info', arguments: { partId: 'ld:3001' } }] },
      {
        calls: [
          {
            name: 'place_part',
            arguments: {
              partId: 'ld:3001',
              colorId: 'c:bright-red',
              modelPath: [shared.occurrence],
              pose: { kind: 'ldu', x_ldu: 0, y_ldu: -24, z_ldu: 220 },
            },
          },
        ],
      },
      { text: '共享底座新增一件。' },
    );
    await send(page, '在共享底座中添加一件');
    expect((await page.evaluate(() => window.brickloopEditorTest.review()))?.items).toHaveLength(1);
    await expect(surface).toHaveAttribute('data-review-added', '3');
    await page.evaluate(() => {
      window.brickloopEditorTest.action('file.new');
    });
    expect(await page.evaluate(() => window.brickloopEditorTest.review())).toBeNull();
    await page.evaluate((id) => window.brickloopEditorTest.switch(id), shared.documentId);
    await expect(surface).toHaveAttribute('data-review-added', '3');
    await page.evaluate(() => window.brickloopEditorTest.reviewMode('before'));
    const otherId = await page.evaluate(
      (id) => window.brickloopEditorTest.snapshot().state.tabs.find((tab) => tab.id !== id)!.id,
      shared.documentId,
    );
    await page.evaluate((id) => window.brickloopEditorTest.switch(id), otherId);
    await page.evaluate((id) => window.brickloopEditorTest.switch(id), shared.documentId);
    expect((await page.evaluate(() => window.brickloopEditorTest.review()))?.mode).toBe('after');
    await page.evaluate(() => window.brickloopEditorTest.reviewEnd());
    await page.evaluate(() => {
      const api = window.brickloopEditorTest;
      api.enter([]);
      api.applyOps([{ type: 'meta.update', changes: { notes: 'MCP isolation' } }], 'mcp');
    });
    expect(await page.evaluate(() => window.brickloopEditorTest.review())).toBeNull();

    // 2,000 AI removals: only the first 500 registered ghosts are meshes; first page is capped.
    await page.evaluate(() => window.brickloopEditorTest.action('file.new'));
    await page.evaluate(() => window.brickloopEditorTest.seed(2000));
    await page.evaluate(() => window.brickloopEditorTest.action('ai.open'));
    const ids = await page.evaluate(() => window.brickloopEditorTest.expanded().map((row) => row.path.at(-1)!));
    model.frames.push(
      { calls: [{ name: 'delete', arguments: { instanceIds: ids } }] },
      { text: '已移除本轮的 2,000 件。' },
    );
    await send(page, '删除这 2000 件以比较布局');
    await expect(surface).toHaveAttribute('data-review-ghosts', '2000');
    await expect(surface).toHaveAttribute('data-review-box-ghosts', '1500');
    await expect(page.locator('.review-row')).toHaveCount(200);
    const perf = await page.evaluate(() => window.brickloopEditorTest.review());
    expect(perf!.firstScreenMs).toBeLessThanOrEqual(200);
    await page.getByRole('button', { name: '再显示 200 项' }).click();
    await expect(page.locator('.review-row')).toHaveCount(400);
    await page.evaluate(() => {
      const api = window.brickloopEditorTest;
      if (
        !api.reviewApply(
          api.review()!.items.map((item) => item.key),
          'before',
        )
      )
        throw new Error('Restore removed items');
    });
    await page.evaluate((colorId) => {
      const api = window.brickloopEditorTest,
        doc = api.snapshot().document,
        model = doc.models[doc.rootModelId]!;
      api.applyOps(
        [
          {
            type: 'instance.update',
            items: Object.keys(model.instances).map((instanceId) => ({
              modelId: model.id,
              instanceId,
              changes: { colorId },
            })),
          },
        ],
        'ai',
      );
    }, seed.color);
    await expect(surface).toHaveAttribute('data-review-changed', '2000');
    await page.evaluate(() => window.brickloopEditorTest.reviewVisible(false));
    const hidden = await orbit(page);
    await page.evaluate(() => window.brickloopEditorTest.reviewVisible(true));
    const annotated = await orbit(page);
    expect(annotated.updatesStable).toBe(true);
    expect(annotated.medianMs).toBeLessThan(Math.max(hidden.medianMs + 3, hidden.medianMs * 1.35));
    const measurements = { diffMs: perf!.diffMs, firstScreenMs: perf!.firstScreenMs, hidden, annotated };
    console.log(`REV-07 ${JSON.stringify(measurements)}`);
    await writeFile(path.join(shots, 'performance.json'), JSON.stringify(measurements, null, 2));
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
    await model.close();
    await rm(directory, { recursive: true, force: true });
  }
});
