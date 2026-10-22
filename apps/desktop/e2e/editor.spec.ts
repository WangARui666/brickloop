import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import { setStableContentSize } from './window-size';
import type { ElectronApplication, Page } from '@playwright/test';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataRoot = path.resolve(desktop, '../../.devdata/e2e');
const output = path.join(desktop, '../../.devdata/e2e-results');
declare global {
  interface Window {
    brickloopEditorTest: EditorTestApi;
  }
}
async function launch(directory: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const start = performance.now();
  const app = await launchElectron({
    args: [desktop],
    env: { ...env, BRICKLOOP_DATA_DIR: directory },
    timeout: 20000,
  });
  const page = await app.firstWindow();

  await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', { timeout: 45000 });
  const elapsed = performance.now() - start;
  await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-render-count', /[1-9]/, { timeout: 20000 });
  await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
  return { app, page, elapsed };
}
const snapshot = (page: Page) => page.evaluate(() => window.brickloopEditorTest.snapshot());
async function screenshot(page: Page, name: string) {
  await expect(page.locator('.toolbar .tool-group:first-child .active-tool[aria-pressed="true"]')).toHaveCSS(
    'color',
    'rgb(255, 138, 61)',
  );
  await page.locator('.document-title').click();
  await expect(page.locator('.ant-menu-submenu-popup:visible')).toHaveCount(0);
  await page.mouse.move(16, 16);
  await page.screenshot({
    path: path.join(output, 'screenshots', `${name}.png`),
    scale: 'css',
    animations: 'disabled',
  });
}
async function beginPart(page: Page) {
  await page.getByRole('textbox', { name: '搜索零件名称或编号' }).fill('3001');
  await page.locator('[data-part-id="ld:3001"]').dblclick();
  await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-placing', 'true');
  await expect(page.locator('.preview-message')).toHaveCount(0);
  await expect(page.locator('[data-part-id="ld:3001"] img')).toBeVisible({ timeout: 30000 });
}
async function point(page: Page, coords: [number, number, number]) {
  return page.evaluate((p) => window.brickloopEditorTest.project(p), coords);
}
async function setSelect(page: Page, label: string, value: string) {
  if (label === '参照系' && !(await page.getByRole('combobox', { name: label, exact: true }).isVisible()))
    await page.getByRole('toolbar').getByRole('button', { name: '移动', exact: true }).click();
  if (label === '网格' || label === '旋转步长')
    await page
      .getByRole('toolbar')
      .getByRole('button', { name: label === '网格' ? '移动' : '旋转', exact: true })
      .click();
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:visible').getByText(value, { exact: true }).click();
  await page.locator('.document-title').click();
}
async function size(app: ElectronApplication, page: Page, width: number, height: number) {
  await setStableContentSize(app, page, width, height);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector('.brickloop-viewport canvas')!.getBoundingClientRect().width ===
          document.querySelector('.viewport-surface')!.clientWidth,
      ),
    )
    .toBe(true);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}
test('M2-3 放置、叠放、变换事务、按键合并、换色隐藏删除与框选', async () => {
  test.setTimeout(180000);
  await mkdir(dataRoot, { recursive: true });
  await mkdir(path.join(output, 'screenshots'), { recursive: true });
  const dir = await mkdtemp(path.join(dataRoot, 'editor-'));
  let app: ElectronApplication | undefined;
  try {
    const launched = await launch(dir);
    app = launched.app;
    const page = launched.page;
    await size(app, page, 1440, 900);
    await expect(page).not.toHaveTitle(/•/);
    await beginPart(page);
    let p = await point(page, [0, 0, 0]);
    await page.mouse.move(p.x, p.y);
    await screenshot(page, 'm2-3-preview-1440x900');
    await size(app, page, 1100, 700);
    p = await point(page, [0, 0, 0]);
    await page.mouse.move(p.x, p.y);
    await screenshot(page, 'm2-3-preview-1100x700');
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', '1');
    let state = await snapshot(page);
    let instances = Object.values(state.document.models[state.document.rootModelId]!.instances);
    expect(instances[0]!.transform.slice(0, 3)).toEqual([0, -24, 0]);
    await beginPart(page);
    p = await point(page, [0, -28, 0]);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', '2');
    state = await snapshot(page);
    instances = Object.values(state.document.models[state.document.rootModelId]!.instances);
    expect(instances[1]!.transform[1]).toBe(-48);
    await expect(page).toHaveTitle(/•/);
    await screenshot(page, 'm2-3-stacked-title');
    const history = state.history.length;
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    state = await snapshot(page);
    expect(state.history.length).toBe(history + 1);
    await page.keyboard.press('Control+z');
    expect((await snapshot(page)).history.length).toBe(history);
    await screenshot(page, 'm2-3-cmd07-rotation-undo');
    await page.keyboard.press('Numpad1');
    await setSelect(page, '网格', '¼ 格');
    const before = (await snapshot(page)).document;
    await page.keyboard.press('d');
    state = await snapshot(page);
    const selected = state.workspace.selection[0]![0]!;
    const previous = before.models[before.rootModelId]!.instances[selected]!.transform;
    const moved = state.document.models[state.document.rootModelId]!.instances[selected]!.transform;
    expect(Math.hypot(moved[0]! - previous[0]!, moved[2]! - previous[2]!)).toBe(5);
    await screenshot(page, 'm2-3-ui04-quarter-grid');
    await page.getByRole('button', { name: '移动', exact: true }).click();
    await page.keyboard.press('f');
    await screenshot(page, 'm2-3-move-1100x700');
    await size(app, page, 1440, 900);
    await screenshot(page, 'm2-3-move-1440x900');
    let handles = await page.evaluate(() => window.brickloopEditorTest.handles());
    const handle = handles.find((p) => p.axis === 'X')!;
    expect(handle).toBeDefined();
    const base = await snapshot(page);
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(handle.x + 80, handle.y, { steps: 12 });
    await expect.poll(async () => (await snapshot(page)).previewing).toBe(true);
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).history.length).toBe(base.history.length + 1);
    await page.keyboard.press('Control+z');
    expect((await snapshot(page)).document).toEqual(base.document);
    await screenshot(page, 'm2-3-cmd02-drag-undo');
    handles = await page.evaluate(() => window.brickloopEditorTest.handles());
    const cancelHandle = handles.find((p) => p.axis === 'X')!;
    const cancelBase = await snapshot(page);
    await page.mouse.move(cancelHandle.x, cancelHandle.y);
    await page.mouse.down();
    await page.mouse.move(cancelHandle.x + 60, cancelHandle.y, { steps: 10 });
    await expect.poll(async () => (await snapshot(page)).previewing).toBe(true);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    state = await snapshot(page);
    expect(state.document).toEqual(cancelBase.document);
    expect(state.history).toEqual(cancelBase.history);
    expect(state.dirty).toBe(cancelBase.dirty);
    const restoredHandle = (await page.evaluate(() => window.brickloopEditorTest.handles())).find(
      (p) => p.axis === 'X',
    )!;
    expect(Math.abs(restoredHandle.x - cancelHandle.x)).toBeLessThan(1);
    await screenshot(page, 'm2-3-cmd03-drag-cancel');
    await page.getByRole('button', { name: '旋转', exact: true }).click();
    await setSelect(page, '旋转步长', '45°');
    const rotationBase = await snapshot(page);
    const ring = (await page.evaluate(() => window.brickloopEditorTest.handles())).find((p) => p.axis === 'Z')!;
    expect(ring).toBeDefined();
    await page.mouse.move(ring.x, ring.y);
    await page.mouse.down();
    await page.mouse.move(ring.x - 60, ring.y - 60, { steps: 12 });
    await expect.poll(async () => (await snapshot(page)).previewing).toBe(true);
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).history.length).toBe(rotationBase.history.length + 1);
    await page.keyboard.press('Control+z');
    expect((await snapshot(page)).document).toEqual(rotationBase.document);
    await screenshot(page, 'm2-3-rotation-drag-undo');
    await page.getByRole('button', { name: '移动', exact: true }).click();
    await page.getByRole('menuitem', { name: '视图', exact: true }).click();
    await page.getByRole('menuitem', { name: '预设视角', exact: true }).click();
    await page.getByRole('menuitem', { name: '等轴测', exact: true }).click();
    await screenshot(page, 'm2-3-move-1440x900');
    await size(app, page, 1100, 700);
    await screenshot(page, 'm2-3-move-1100x700');
    await size(app, page, 1440, 900);
    await page.getByRole('button', { name: '旋转', exact: true }).click();
    await screenshot(page, 'm2-3-rotate-1440x900');
    await size(app, page, 1100, 700);
    await screenshot(page, 'm2-3-rotate-1100x700');
    await page.getByRole('textbox', { name: '位置 X', exact: true }).fill('40');
    await page.getByRole('textbox', { name: '位置 X', exact: true }).press('Enter');
    await expect(page.getByRole('textbox', { name: '位置 X', exact: true })).toHaveValue('40');
    await screenshot(page, 'm2-3-properties-1100x700');
    await page.locator('[data-color-id="c:bright-blue"]').first().click();
    state = await snapshot(page);
    expect(state.document.models[state.document.rootModelId]!.instances[selected]!.colorId).toBe('c:bright-blue');
    await screenshot(page, 'm2-3-recolor');
    const hideHistory = state.history.length;
    await page.keyboard.press('h');
    state = await snapshot(page);
    expect(state.workspace.hidden).toHaveLength(1);
    expect(state.history.length).toBe(hideHistory);
    await screenshot(page, 'm2-3-hide');
    await page.keyboard.press('Alt+h');
    expect((await snapshot(page)).workspace.hidden).toHaveLength(0);
    await screenshot(page, 'm2-3-show-all');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', '0');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', '2');
    await screenshot(page, 'm2-3-delete-undo');
    await page.getByRole('button', { name: '选择', exact: true }).click();
    await beginPart(page);
    p = await point(page, [0, -28, 0]);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y);
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', '3');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+0');
    await page.keyboard.press('Numpad7');
    const rect = (await page.getByTestId('viewport-host').boundingBox())!;
    await page.mouse.move(rect.x + 8, rect.y + 70);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 8, rect.y + rect.height - 30, { steps: 12 });
    await page.mouse.up();
    expect((await snapshot(page)).workspace.selection).toHaveLength(3);
    await screenshot(page, 'm2-3-box-three');
    await size(app, page, 1440, 900);
    await screenshot(page, 'm2-3-properties-1440x900');
    await page.evaluate(() => window.brickloopEditorTest.markSaved());
    await expect(page).not.toHaveTitle(/•/);
    await page.keyboard.press('d');
    await expect(page).toHaveTitle(/•/);
    await page.keyboard.press('Control+z');
    await expect(page).not.toHaveTitle(/•/);
    await screenshot(page, 'm2-3-saved-revision-title');
    expect(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth && document.body.scrollHeight <= innerHeight),
    ).toBe(true);
  } finally {
    if (app) {
      await (await app.firstWindow()).evaluate(() => window.brickloopEditorTest.prepareClose());
      await app.close();
    }
    if (path.dirname(dir) === dataRoot) await rm(dir, { recursive: true, force: true });
  }
});

test('M2-3 冷热启动与 100 / 1000 / 10000 实例帧时间', async () => {
  test.setTimeout(240000);
  await mkdir(dataRoot, { recursive: true });
  const dir = await mkdtemp(path.join(dataRoot, 'performance-'));
  let app: ElectronApplication | undefined;
  try {
    let result = await launch(dir);
    app = result.app;
    const coldMs = result.elapsed;
    await app.close();
    app = undefined;
    result = await launch(dir);
    app = result.app;
    const hotMs = result.elapsed;
    const results = [];
    for (const count of [100, 1000, 10000]) {
      const metrics = await result.page.evaluate((count) => window.brickloopEditorTest.benchmark(count), count);
      results.push(metrics);
      console.log('M2-3 frame performance', JSON.stringify(metrics));
      await screenshot(result.page, `m2-3-performance-${count}`);
    }
    const batch = await result.page.evaluate(() => window.brickloopEditorTest.benchmark(1000, 1000));
    const metrics = { coldMs, hotMs, results, batch };
    await writeFile(path.join(output, 'm2-3-performance.json'), JSON.stringify(metrics, null, 2));
    console.log('M2-3 startup', JSON.stringify({ coldMs, hotMs }));
    console.log('M2-3 batch 1000', JSON.stringify(batch));
  } finally {
    if (app) {
      await (await app.firstWindow()).evaluate(() => window.brickloopEditorTest.prepareClose());
      await app.close();
    }
    if (path.dirname(dir) === dataRoot) await rm(dir, { recursive: true, force: true });
  }
});

test('M2-3 编组、共享上下文、局部坐标与选择修饰键', async () => {
  test.setTimeout(90000);
  await mkdir(dataRoot, { recursive: true });
  const dir = await mkdtemp(path.join(dataRoot, 'shared-'));
  let app: ElectronApplication | undefined;
  try {
    const result = await launch(dir);
    app = result.app;
    const page = result.page;
    await page.evaluate(() => window.brickloopEditorTest.seed(3));
    await page.keyboard.press('Numpad7');
    const clickPart = async (x: number, options: { modifiers?: ('Control' | 'Shift')[]; double?: boolean } = {}) => {
      const p = await point(page, [x, -24, 0]);
      if (options.modifiers) for (const key of options.modifiers) await page.keyboard.down(key);
      if (options.double) await page.mouse.dblclick(p.x, p.y);
      else await page.mouse.click(p.x, p.y);
      if (options.modifiers) for (const key of options.modifiers) await page.keyboard.up(key);
    };
    await clickPart(0);
    expect((await snapshot(page)).workspace.selection).toHaveLength(1);
    await clickPart(100, { modifiers: ['Control'] });
    expect((await snapshot(page)).workspace.selection).toHaveLength(2);
    await clickPart(0, { modifiers: ['Control'] });
    expect((await snapshot(page)).workspace.selection).toHaveLength(1);
    await screenshot(page, 'm2-3-ctrl-selection');
    await page.keyboard.press('Control+a');
    expect(
      await page.evaluate(() => window.brickloopEditorTest.command({ type: 'group.create', name: '测试编组' })),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await clickPart(100);
    expect((await snapshot(page)).workspace.selection).toHaveLength(3);
    await clickPart(100, { double: true });
    await expect(page.locator('.context-breadcrumb')).toContainText('测试编组');
    await clickPart(0);
    expect((await snapshot(page)).workspace.selection).toHaveLength(1);
    await screenshot(page, 'm2-3-group-context');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+a');
    expect(
      await page.evaluate(() => window.brickloopEditorTest.command({ type: 'submodel.create', name: '共享组合' })),
    ).toBe(true);
    await page.evaluate(() => {
      const state = window.brickloopEditorTest.snapshot();
      const model = state.document.models[state.document.rootModelId]!;
      const reference = Object.values(model.instances)[0]!;
      if (reference.ref.kind !== 'model') throw new Error('Missing submodel');
      window.brickloopEditorTest.command({
        type: 'submodel.instantiate',
        modelId: reference.ref.modelId,
        transform: [400, 0, 0, 0, 0, 1, 0, 1, 0, -1, 0, 0],
      });
    });
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', '6');
    await page.keyboard.press('Control+0');
    await clickPart(0, { double: true });
    await expect(page.locator('.context-breadcrumb')).toContainText('测试编组');
    await clickPart(0, { double: true });
    await expect(page.locator('.shared-notice')).toContainText('此子模型被引用 2 次');
    await clickPart(0, { double: true });
    await clickPart(0);
    const base = await snapshot(page);
    expect(base.workspace.activeModelPath).toHaveLength(1);
    expect(base.workspace.selection).toHaveLength(1);
    await setSelect(page, '参照系', '主选件局部');
    await page.getByRole('textbox', { name: '位置 X', exact: true }).fill('5');
    await page.getByRole('textbox', { name: '位置 X', exact: true }).press('Enter');
    const changed = await snapshot(page);
    expect(changed.metrics.matrixWrites).toBe(2);
    expect(changed.document.models[changed.document.rootModelId]).toEqual(
      base.document.models[base.document.rootModelId],
    );
    await screenshot(page, 'm2-3-shared-context');
    await page.locator('.document-title').click();
    await page.keyboard.press('Control+z');
    expect((await snapshot(page)).document).toEqual(base.document);
    await screenshot(page, 'm2-3-shared-undo');
  } finally {
    if (app) {
      await (await app.firstWindow()).evaluate(() => window.brickloopEditorTest.prepareClose());
      await app.close();
    }
    if (path.dirname(dir) === dataRoot) await rm(dir, { recursive: true, force: true });
  }
});
