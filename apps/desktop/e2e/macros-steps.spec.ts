import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import { setStableContentSize } from './window-size';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { unzipSync } from 'fflate';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(desktop, '../../.devdata/e2e');
const evidence = path.join(desktop, '../../.devdata/e2e-evidence/m7-1b');
async function launch(directory: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron({ args: [desktop], env: { ...env, BRICKLOOP_DATA_DIR: directory } });
  const page = await app.firstWindow();

  await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', { timeout: 60000 });
  await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
  return { app, page };
}
async function stop(app: ElectronApplication) {
  await (await app.firstWindow()).evaluate(() => window.brickloopEditorTest.prepareClose());
  await app.close();
}
const snapshot = (page: Page) => page.evaluate(() => window.brickloopEditorTest.snapshot());
const inventory = (page: Page) =>
  page.evaluate(() =>
    window.brickloopEditorTest
      .expanded()
      .map((row) => `${row.partId}/${row.colorId}`)
      .sort(),
  );
async function macros(page: Page) {
  await page.locator('#library-panel .ant-segmented').getByText('宏', { exact: true }).click();
  await expect(page.locator('[data-macro-id="builtin.table"] img')).toBeVisible({ timeout: 120000 });
}
async function readyImages(page: Page) {
  await expect(page.locator('.thumbnail-skeleton')).toHaveCount(0, { timeout: 120000 });
  await expect
    .poll(() =>
      page
        .locator('img')
        .evaluateAll((images) =>
          images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0),
        ),
    )
    .toBe(true);
}
async function capture(app: ElectronApplication, page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  for (const [width, height] of [
    [1440, 900],
    [1100, 700],
  ]) {
    // Native window frames/DPI can change during drag operations. Pin the test viewport too.
    await page.setViewportSize({ width: width!, height: height! });
    await setStableContentSize(app, page, width!, height!);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
    await readyImages(page);
    await page.mouse.move(16, 16);
    await page.waitForTimeout(250);
    await expect
      .poll(() =>
        page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length),
      )
      .toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({
      path: path.join(evidence, `${name}-${width}x${height}.png`),
      animations: 'disabled',
      scale: 'css',
    });
  }
}
async function commitPlacement(page: Page) {
  await expect(page.locator('[data-placing="true"]')).toBeVisible();
  const rect = await page.getByTestId('viewport-host').boundingBox();
  await page.mouse.move(rect!.x + rect!.width * 0.5, rect!.y + rect!.height * 0.6);
  await page.waitForTimeout(500);
  await page.mouse.click(rect!.x + rect!.width * 0.5, rect!.y + rect!.height * 0.6);
  await expect(page.locator('[data-placing="true"]')).toHaveCount(0);
  await page.evaluate(() => window.brickloopEditorTest.action('view.fitAll'));
}
async function newDocument(page: Page) {
  await page.locator('.document-title').click();
  await page.keyboard.press('Control+n');
  await expect.poll(async () => (await inventory(page)).length).toBe(0);
}

// Windows can send a real buttonless mousemove between synthetic mousedown and mousemove.
// It can cancel the gesture or start a drag before Playwright intercepts it; neither delivers
// a drop to the target. Completion requires a drag from the source onto the original target.
async function dragUntilDropped(source: Locator, target: Locator, name: string, unchanged: () => Promise<void>) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const targetElement = await target.elementHandle();
    if (!targetElement) throw new Error(`${name} drag target was not found.`);
    try {
      const dragEvents = await source.evaluateHandle((element, target) => {
        const draggable = element.closest('[draggable="true"]') ?? element;
        const state = {
          started: false,
          start: null as string | null,
          drop: null as string | null,
          droppedOnTarget: false,
        };
        const describe = (landed: EventTarget | null) => {
          if (!(landed instanceof Element)) return String(landed);
          const row = landed.closest('[data-step-id]');
          const description = `${landed.tagName.toLowerCase()}${landed.id ? `#${landed.id}` : ''}${
            landed.classList.length ? `.${[...landed.classList].join('.')}` : ''
          }`;
          if (row) {
            const rows = [...row.parentElement!.children].filter((child) => child.matches('[data-step-id]'));
            return `${description} in step row ${rows.indexOf(row) + 1} [data-step-id="${row.getAttribute('data-step-id')}"]`;
          } else if (landed.closest('[data-testid="viewport-host"]')) {
            return `${description} in viewport [data-testid="viewport-host"]`;
          } else if (landed.closest('.ai-panel')) {
            return `${description} in AI panel (.ai-panel)`;
          } else {
            return description;
          }
        };
        const recordStart = (event: Event) => {
          state.started = event.target instanceof Node && draggable.contains(event.target);
          state.start = describe(event.target);
        };
        const recordDrop = (event: Event) => {
          state.droppedOnTarget = event.target instanceof Node && target.contains(event.target);
          state.drop = describe(event.target);
        };
        document.addEventListener('dragstart', recordStart, { capture: true, once: true });
        document.addEventListener('drop', recordDrop, { capture: true, once: true });
        return {
          state,
          cleanup: () => {
            document.removeEventListener('dragstart', recordStart, true);
            document.removeEventListener('drop', recordDrop, true);
          },
        };
      }, targetElement);
      let result: { started: boolean; start: string | null; drop: string | null; droppedOnTarget: boolean };
      try {
        await source.dragTo(target);
        result = await dragEvents.evaluate(({ state }) => state);
      } finally {
        try {
          await dragEvents.evaluate(({ cleanup }) => cleanup());
        } finally {
          await dragEvents.dispose();
        }
      }
      if (result.droppedOnTarget) {
        if (result.started) return;
        throw new Error(
          `${name} drag dropped on the intended target (${result.drop}), but did not start from the source (dragstart: ${result.start ?? 'not observed'}).`,
        );
      }
      if (result.drop !== null)
        throw new Error(`${name} drag dropped on ${result.drop} instead of the intended target.`);
      await unchanged();
      if (attempt < 3)
        test.info().annotations.push({
          type: `${name}-drag-retry`,
          description: `No drop on attempt ${attempt}; dragstart=${result.started} (${
            result.started ? 'drag began before Playwright interception' : 'gesture canceled before dragstart'
          }); retrying (${attempt + 1}/3).`,
        });
    } finally {
      await targetElement.dispose();
    }
  }
  throw new Error(`${name} drag did not deliver a drop to the intended target after 3 attempts.`);
}

test('MAC-01：保存、两种插入事务、内置宏、管理与磁盘缩略图缓存', async () => {
  test.setTimeout(480000);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'macros-'));
  let running: ElectronApplication | undefined;
  try {
    const { app, page } = await launch(directory);
    running = app;
    await page.evaluate(async () => {
      await window.brickloopEditorTest.seed(3);
      const state = window.brickloopEditorTest.snapshot(),
        model = state.document.models[state.document.rootModelId]!;
      const ids = Object.keys(model.instances);
      window.brickloopEditorTest.select([[ids[1]!]]);
      window.brickloopEditorTest.command({ type: 'color.set', colorId: 'c:bright-yellow' });
      window.brickloopEditorTest.select(ids.map((id) => [id]));
    });
    const original = await inventory(page);
    await page.evaluate(() => window.brickloopEditorTest.select([]));
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '将所选保存为宏', exact: false })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.getByTestId('viewport-host').click();
    await page.evaluate(() => window.brickloopEditorTest.action('select.all'));
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
    await page.getByRole('menuitem', { name: '将所选保存为宏', exact: false }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('彩色长凳');
    await expect(dialog.locator('.macro-live-preview img')).toBeVisible();
    const colored = await dialog.locator('.macro-live-preview img').getAttribute('src');
    await dialog.getByText('中性灰', { exact: true }).click();
    await expect(dialog.locator('.macro-live-preview img')).toBeVisible();
    await expect(dialog.locator('.macro-live-preview img')).not.toHaveAttribute('src', colored!);
    await dialog.getByText('保留原色', { exact: true }).click();
    await capture(app, page, 'save-macro');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: '彩色长凳', exact: true })).toBeVisible();
    const files = await readdir(path.join(directory, 'config/macros'));
    const saved = unzipSync(await readFile(path.join(directory, 'config/macros', files[0]!)));
    expect(saved['thumbnail.png']?.byteLength).toBeGreaterThan(100);
    for (const mode of ['编组', '子模型']) {
      await newDocument(page);
      if (mode === '子模型') {
        await page.getByRole('combobox', { name: '插入方式', exact: true }).click();
        await page.getByText('子模型', { exact: true }).last().click();
      }
      await page.getByRole('button', { name: '彩色长凳', exact: true }).dblclick();
      await commitPlacement(page);
      expect(await inventory(page)).toEqual(original);
      const state = await snapshot(page),
        model = state.document.models[state.document.rootModelId]!;
      expect(state.history).toHaveLength(1);
      if (mode === '编组') expect(Object.values(state.document.groups)).toHaveLength(1);
      else expect(Object.values(model.instances).filter((row) => row.ref.kind === 'model')).toHaveLength(1);
      await page.evaluate(() => window.brickloopEditorTest.action('edit.undo'));
      expect(await inventory(page)).toHaveLength(0);
      await page.evaluate(() => window.brickloopEditorTest.action('edit.redo'));
      expect(await inventory(page)).toEqual(original);
    }
    await newDocument(page);
    await page.getByRole('combobox', { name: '插入方式', exact: true }).click();
    await page.getByText('编组', { exact: true }).last().click();
    await page.getByRole('button', { name: '桌子', exact: true }).dblclick();
    await expect(page.locator('[data-placing="true"]')).toBeVisible();
    const rect = await page.getByTestId('viewport-host').boundingBox();
    await page.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height * 0.65);
    await page.keyboard.press('ArrowRight');
    await capture(app, page, 'macro-placement');
    await page.keyboard.press('Escape');
    expect(await inventory(page)).toHaveLength(0);
    // Native drag/drop follows the same placement flow.
    await dragUntilDropped(
      page.getByRole('button', { name: '桌子', exact: true }),
      page.getByTestId('viewport-host'),
      'macro',
      async () => {
        await expect(page.locator('[data-placing="true"]')).toHaveCount(0);
        expect(await inventory(page)).toHaveLength(0);
      },
    );
    await commitPlacement(page);
    expect(await inventory(page)).toHaveLength(15);
    await page.evaluate(() => window.brickloopEditorTest.select([]));
    await page.getByRole('button', { name: '彩色长凳', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('彩色座椅');
    await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
    await expect(page.getByRole('button', { name: '彩色座椅', exact: true })).toBeVisible();
    await app.evaluate(({ shell }) => {
      shell.showItemInFolder = (file) => {
        Object.assign(globalThis, { revealedMacro: file });
      };
    });
    await page.getByRole('button', { name: '彩色座椅', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '在资源管理器中显示', exact: true }).click();
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { revealedMacro: string }).revealedMacro)).toBe(
      path.join(directory, 'config/macros', files[0]!),
    );
    await page.getByRole('button', { name: '彩色座椅', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除宏', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    expect((await readdir(path.join(directory, 'config/macros'))).length).toBe(1);
    await page.getByRole('button', { name: '彩色座椅', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除宏', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除宏', exact: true }).click();
    await expect(page.getByRole('button', { name: '彩色座椅', exact: true })).toHaveCount(0);
    await page.getByTestId('macro-panel').locator('.macro-categories').getByText('全部宏', { exact: true }).click();
    await capture(app, page, 'macros-all');
    expect(await page.locator('[data-macro-id] img').count()).toBe(6);
    const cache = path.join(directory, 'cache/macros');
    const before = await Promise.all(
      (await readdir(cache)).map(async (file) => [file, (await stat(path.join(cache, file))).mtimeMs]),
    );
    expect(
      (await page.evaluate(() => window.brickloopEditorTest.macroThumbnailMetrics())).rendered,
    ).toBeGreaterThanOrEqual(6);
    await stop(app);
    running = undefined;
    const restarted = await launch(directory);
    running = restarted.app;
    await macros(restarted.page);
    await readyImages(restarted.page);
    const metrics = await restarted.page.evaluate(() => window.brickloopEditorTest.macroThumbnailMetrics());
    expect(metrics.rendered).toBe(0);
    expect(metrics.cacheHits).toBe(6);
    const after = await Promise.all(
      (await readdir(cache)).map(async (file) => [file, (await stat(path.join(cache, file))).mtimeMs]),
    );
    expect(after).toEqual(before);
  } finally {
    if (running) await stop(running);
    await rm(directory, { recursive: true, force: true });
  }
});

test('图案：七组、人仔表情原色缩略图、搜索、非工厂标记及插入检查', async () => {
  test.setTimeout(240000);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'patterns-'));
  const { app, page } = await launch(directory);
  try {
    await macros(page);
    const groups = await page.evaluate(() => window.brickloop.patternGroups());
    expect(groups).toHaveLength(7);
    expect(groups.every((group) => group.count > 0)).toBe(true);
    console.info('Pattern groups:', JSON.stringify(groups));
    await page.getByText('人仔表情', { exact: true }).click();
    await expect(page.locator('[data-part-id]').first()).toBeVisible();
    await expect(page.locator('.non-factory-badge').first()).toHaveText('非工厂件');
    await capture(app, page, 'patterns-faces');
    const first = page.locator('[data-part-id]').first(),
      id = await first.getAttribute('data-part-id');
    await page.getByRole('textbox', { name: '搜索宏或图案' }).fill(id!);
    await expect(page.locator('[data-part-id]')).toHaveCount(1);
    await page.locator('[data-part-id]').first().dblclick();
    await commitPlacement(page);
    expect(await inventory(page)).toEqual([`${id}/c:bright-yellow`]);
    await page.evaluate(() => window.brickloopEditorTest.assemblyReady());
    const issues = await page.evaluate(() => window.brickloopEditorTest.assembly().issues);
    expect(issues.some((issue) => issue.kind === 'nonFactoryPart')).toBe(true);
    await page.evaluate(() => window.brickloopEditorTest.action('select.all'));
    await page.getByTestId('viewport-host').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '将所选保存为宏', exact: false }).click();
    await page.getByRole('dialog').getByRole('textbox', { name: '名称', exact: true }).fill('表情组合');
    await page.getByRole('dialog').getByRole('combobox', { name: '分类', exact: true }).fill('我的图案');
    await expect(page.locator('.macro-live-preview img')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await newDocument(page);
    await page.getByRole('button', { name: '表情组合', exact: true }).dblclick();
    await expect(page.locator('.macro-warning')).toContainText('零件 1 种');
    await commitPlacement(page);
    await page.evaluate(() => window.brickloopEditorTest.assemblyReady());
    expect(
      (await page.evaluate(() => window.brickloopEditorTest.assembly().issues)).some(
        (issue) => issue.kind === 'nonFactoryPart',
      ),
    ).toBe(true);
  } finally {
    await stop(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test('搭建步骤：当前步骤、所选分配、拖动排序、删除合并、逐步查看及恢复', async () => {
  test.setTimeout(240000);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'steps-'));
  const { app, page } = await launch(directory);
  try {
    const initial = await snapshot(page);
    expect(initial.document.models[initial.document.rootModelId]!.stepIds).toHaveLength(1);
    await page.evaluate(async () => {
      await window.brickloopEditorTest.seed(6);
      const state = window.brickloopEditorTest.snapshot(),
        ids = Object.keys(state.document.models[state.document.rootModelId]!.instances);
      for (let i = 0; i < ids.length; i++) {
        window.brickloopEditorTest.select([[ids[i]!]]);
        window.brickloopEditorTest.command({
          type: 'transform.set',
          transform: [(i % 2) * 80 - 40, -24 * (Math.floor(i / 2) + 1), 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        });
        window.brickloopEditorTest.command({
          type: 'color.set',
          colorId: ['c:bright-yellow', 'c:bright-red', 'c:bright-blue'][Math.floor(i / 2)]!,
        });
      }
      window.brickloopEditorTest.action('view.fitAll');
      window.brickloopEditorTest.structure();
    });
    await page.locator('.structure-view-tabs').getByText('步骤', { exact: true }).click();
    const state = await snapshot(page),
      model = state.document.models[state.document.rootModelId]!,
      ids = Object.keys(model.instances);
    await page.getByRole('button', { name: '添加步骤', exact: true }).click();
    await page.evaluate((ids) => window.brickloopEditorTest.select(ids.map((id) => [id])), ids.slice(2, 4));
    await page.getByRole('button', { name: '第 2 步操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '把所选移到此步骤', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '把所选移到此步骤', exact: true })).toBeHidden();
    await page.getByRole('button', { name: '添加步骤', exact: true }).click();
    await page.evaluate((ids) => window.brickloopEditorTest.select(ids.map((id) => [id])), ids.slice(4));
    await page.getByRole('button', { name: '第 3 步操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '把所选移到此步骤', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '把所选移到此步骤', exact: true })).toBeHidden();
    const order = (await snapshot(page)).document.models[model.id]!.stepIds;
    await dragUntilDropped(
      page.locator(`[data-step-id="${order[2]}"] .step-grip`),
      page.locator(`[data-step-id="${order[0]}"]`),
      'step',
      async () => {
        expect((await snapshot(page)).document.models[model.id]!.stepIds).toEqual(order);
      },
    );
    await expect
      .poll(async () => (await snapshot(page)).document.models[model.id]!.stepIds)
      .toEqual([order[2], order[0], order[1]]);
    await page.evaluate(() => window.brickloopEditorTest.action('edit.undo'));
    expect((await snapshot(page)).document.models[model.id]!.stepIds).toEqual(order);
    await page.locator(`[data-step-id="${order[1]}"] .step-select`).click();
    await page.evaluate(() => window.brickloopEditorTest.select([]));
    // A genuine part-placement click must land in the selected second step.
    await page.locator('[data-part-id]').first().click();
    await commitPlacement(page);
    const placed = (await snapshot(page)).document.models[model.id]!;
    expect(placed.steps[order[1]!]!.instanceIds).toHaveLength(3);
    await page.evaluate(() => window.brickloopEditorTest.action('edit.undo'));
    await page.evaluate(() => {
      window.brickloopEditorTest.select([]);
      window.brickloopEditorTest.action('view.fitAll');
    });
    await page.locator('.properties-dock-title').click();
    await capture(app, page, 'steps');
    const beforeView = (await snapshot(page)).workspace;
    await page.locator('.document-title').click();
    await page.keyboard.press('Control+Shift+p');
    await expect(page.getByRole('region', { name: '逐步查看导航' })).toBeVisible();
    await expect(page.locator('[data-step-visible-count]')).toHaveAttribute('data-step-visible-count', '4');
    await expect(page.locator('[data-step-dimmed-count]')).toHaveAttribute('data-step-dimmed-count', '2');
    await capture(app, page, 'step-viewing');
    await page.locator('.document-title').click();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.step-navigation')).toContainText('第 3 步，共 3 步');
    await expect(page.locator('[data-step-visible-count]')).toHaveAttribute('data-step-visible-count', '6');
    await expect(page.locator('[data-step-dimmed-count]')).toHaveAttribute('data-step-dimmed-count', '4');
    await page.keyboard.press('ArrowLeft');
    await page.getByRole('slider', { name: '当前步骤' }).fill('1');
    await expect(page.locator('[data-step-visible-count]')).toHaveAttribute('data-step-visible-count', '2');
    await expect(page.locator('[data-step-dimmed-count]')).toHaveAttribute('data-step-dimmed-count', '0');
    await page.getByRole('button', { name: '退出逐步查看', exact: true }).click();
    await expect(page.locator('[data-step-visible-count]')).toHaveAttribute('data-step-visible-count', '6');
    expect((await snapshot(page)).workspace.hidden).toEqual(beforeView.hidden);
    expect((await snapshot(page)).workspace.selection).toEqual(beforeView.selection);
    await page.getByRole('button', { name: '第 2 步操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '删除步骤', exact: true }).click();
    await expect(page.locator('.step-notice')).toContainText('2 件零件并入第 1 步');
    const after = (await snapshot(page)).document.models[model.id]!;
    expect(after.stepIds).toHaveLength(2);
    expect(after.steps[order[0]!]!.instanceIds).toHaveLength(4);
    await page.evaluate(() => window.brickloopEditorTest.action('edit.undo'));
    expect((await snapshot(page)).document.models[model.id]!.stepIds).toEqual(order);
  } finally {
    await stop(app);
    await rm(directory, { recursive: true, force: true });
  }
});
