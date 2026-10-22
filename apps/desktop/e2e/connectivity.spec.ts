import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import { setStableContentSize } from './window-size';
import type { ElectronApplication, Page } from '@playwright/test';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';
declare global {
  interface Window {
    brickloopEditorTest: EditorTestApi;
  }
}
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(desktop, '../..');
const evidence = path.join(desktop, '../../.devdata/e2e-evidence/m3-3');
async function resize(app: ElectronApplication, page: Page, width: number, height: number) {
  await setStableContentSize(app, page, width, height);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}
async function capture(app: ElectronApplication, page: Page, name: string) {
  for (const [width, height] of [
    [1440, 900],
    [1100, 700],
  ]) {
    await resize(app, page, width!, height!);
    await page.screenshot({
      path: path.join(evidence, `${name}-${width}x${height}.png`),
      scale: 'css',
      animations: 'disabled',
    });
  }
}
async function fixture(page: Page, positions: [number, number, number][]) {
  await page.evaluate(async (values) => {
    const api = window.brickloopEditorTest;
    api.enter([]);
    api.action('select.all');
    api.command({ type: 'edit.delete' });
    for (const [x, y, z] of values)
      api.command({
        type: 'part.add',
        partId: 'ld:3001',
        colorId: 'c:bright-red',
        transform: [x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      });
    await api.meshesReady();
    await api.assemblyReady();
    api.preset('iso');
    api.action('view.fitAll');
  }, positions);
}
test('M3-3 吸附、碰撞、检查、连接点与标注文件闭环', async () => {
  test.setTimeout(180000);
  await mkdir(evidence, { recursive: true });
  const dataRoot = path.join(root, '.devdata/e2e');
  await mkdir(dataRoot, { recursive: true });
  const directory = await mkdtemp(path.join(dataRoot, 'connectivity-'));
  const connectorFile = path.join(root, 'library/connectors/3001.json'),
    colliderFile = path.join(root, 'library/colliders/ld%3A3001.collider.json');
  const original = await Promise.all([readFile(connectorFile), readFile(colliderFile)]);
  let app: ElectronApplication | undefined;
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    app = await launchElectron({ args: [desktop], env: { ...env, BRICKLOOP_DATA_DIR: directory }, timeout: 20000 });
    const page = await app.firstWindow();

    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45000,
    });
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
    await resize(app, page, 1440, 900);
    await expect(page).toHaveTitle('未命名 1 — Brickloop（积环）');
    await fixture(page, [[10, -24, 0]]);
    await page.getByRole('textbox', { name: '搜索零件名称或编号' }).fill('3001');
    await page.locator('[data-part-id="ld:3001"]').click();
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-placing', 'true');
    const point = await page.evaluate(() => window.brickloopEditorTest.project([10, -24, 0]));
    await page.mouse.move(point.x, point.y);
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.assembly().chosen?.transform.slice(12, 15)))
      .toEqual([10, -48, 0]);
    await capture(app, page, 'snap-highlight');
    const point2 = await page.evaluate(() => window.brickloopEditorTest.project([10, -24, 0]));
    await page.keyboard.down('Alt');
    await page.mouse.move(point2.x + 1, point2.y);
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.assembly().chosen)).toBeNull();
    await page.keyboard.up('Alt');
    for (let frame = 0; frame < 60; frame++) await page.mouse.move(point2.x + Math.sin(frame / 5) * 6, point2.y);
    await page.mouse.move(point2.x, point2.y);
    await page.mouse.click(point2.x, point2.y);
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(2);
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded()[1]!.matrix.slice(12, 15))).toEqual([
      10, -48, 0,
    ]);
    await fixture(page, [[0, -24, 0]]);
    await page.getByRole('toolbar').getByRole('button', { name: '吸附', exact: true }).click();
    await page.locator('[data-part-id="ld:3001"]').click();
    const gridPoint = await page.evaluate(() => window.brickloopEditorTest.project([0, -24, 0]));
    await page.mouse.move(gridPoint.x, gridPoint.y);
    await page.mouse.click(gridPoint.x, gridPoint.y);
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(2);
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded()[1]!.matrix.slice(12, 15))).toEqual([
      0, -48, 0,
    ]);
    // Blocking applies to the displayed pose; turning collision off also disables blocking.
    await fixture(page, [[10, -24, 0]]);
    await page.evaluate(() => window.brickloopEditorTest.assemblyOption('policy', 'block'));
    await page.locator('[data-part-id="ld:3001"]').click();
    const blockedPoint = await page.evaluate(() => window.brickloopEditorTest.project([0, -24, 0]));
    await page.mouse.move(blockedPoint.x, blockedPoint.y);
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.assembly().hitCount)).toBe(2);
    await page.mouse.click(blockedPoint.x, blockedPoint.y);
    await expect(page.locator('.preview-message')).toContainText('已阻止放置');
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(1);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.brickloopEditorTest.assemblyOption('policy', 'warn'));
    // Real transform-handle drag: x starts off the target connector grid and must snap sideways by 10 LDU.
    await fixture(page, [
      [10, -24, 0],
      [0, -80, 0],
    ]);
    await page.getByRole('toolbar').getByRole('button', { name: '吸附', exact: true }).click();
    await page.getByRole('toolbar').getByRole('button', { name: '移动', exact: true }).click();
    await page.keyboard.press('Numpad1');
    const drag = await page.evaluate(() => {
      const api = window.brickloopEditorTest;
      const handle = api.handles().find((point) => point.axis === 'Y')!;
      const before = api.project([0, -80, 0]),
        after = api.project([0, -48, 0]);
      return { handle, dy: after.y - before.y };
    });
    await page.mouse.move(drag.handle.x, drag.handle.y);
    await page.mouse.down();
    await page.mouse.move(drag.handle.x, drag.handle.y + drag.dy, { steps: 16 });
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.assembly().chosen !== null)).toBe(true);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.snapshot().previewing)).toBe(false);
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded()[1]!.matrix.slice(12, 15))).toEqual([
      10, -48, 0,
    ]);
    await page.getByRole('toolbar').getByRole('button', { name: '选择', exact: true }).click();
    await fixture(page, [
      [0, -24, 0],
      [10, -48, 0],
    ]);
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-collision-count', '2');
    await page.mouse.move(16, 16);
    await capture(app, page, 'collision');
    await page.getByRole('toolbar').getByRole('button', { name: '碰撞检测', exact: true }).click();
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-collision-count', '0');
    expect(
      await page.evaluate(() =>
        window.brickloopEditorTest.assembly().issues.some((issue) => issue.kind === 'collision'),
      ),
    ).toBe(false);
    await page.getByRole('toolbar').getByRole('button', { name: '碰撞检测', exact: true }).click();
    await fixture(page, [
      [0, -24, 0],
      [0, -48, 0],
      [140, -80, 0],
    ]);
    await page.evaluate(() => {
      const api = window.brickloopEditorTest;
      api.select([api.expanded()[0]!.path]);
      api.action('select.connected');
    });
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().workspace.selection.length)).toBe(2);
    await page.getByRole('toolbar').getByRole('button', { name: '连接点', exact: true }).click();
    await expect.poll(() => page.locator('.brickloop-viewport').getAttribute('data-connector-count')).not.toBe('0');
    await capture(app, page, 'connectors');
    await page.keyboard.press('F7');
    await expect(page.locator('[data-issue-kind="floating"]')).toBeVisible();
    await capture(app, page, 'checks');
    await page.locator('[data-issue-kind="floating"]').click();
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().workspace.selection[0])).toEqual(
      await page.evaluate(() => window.brickloopEditorTest.expanded()[2]!.path),
    );
    await page.evaluate(() => window.brickloopEditorTest.structure());
    await expect(page.locator('.tree-color-dot').first()).toBeVisible();
    await expect(page.locator('.tree-part-number').first()).toHaveText('3001');
    await page.evaluate(() => window.brickloopEditorTest.action('view.fitAll'));
    await capture(app, page, 'structure-tree');
    await page.evaluate(() => {
      const api = window.brickloopEditorTest;
      api.select([api.expanded()[0]!.path, api.expanded()[1]!.path]);
      api.command({ type: 'submodel.create', name: '连接模块' });
      const path = api.snapshot().workspace.selection[0]!;
      api.enter(path);
      api.action('view.fitAll');
    });
    await capture(app, page, 'context-dim');
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('menuitem', { name: '零件库维护模式', exact: true }).click();
    await page.locator('[data-part-id="ld:3001"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '编辑连接点' }).click();
    await expect(page.getByRole('dialog', { name: '连接点标注' })).toBeVisible();
    await expect(page.locator('.annotation-list-scroll > button').first()).toBeVisible();
    await page.getByRole('button', { name: '复制', exact: true }).click();
    await expect(page.locator('.annotation-list-scroll > button')).toHaveCount(6);
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.locator('.annotation-list-scroll > button')).toHaveCount(5);
    await page.getByRole('button', { name: '试配', exact: true }).click();
    await expect(page.locator('.annotation-footer')).toContainText('个候选');
    await page.getByRole('button', { name: '从图元推断', exact: true }).click();
    await expect(page.locator('.annotation-diff')).toBeVisible();
    await capture(app, page, 'annotation');
    await page.getByRole('button', { name: '采用推断结果', exact: true }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.annotation-footer')).toHaveText('已保存为草稿');
    await writeFile(path.join(evidence, '3001-saved-draft.json'), await readFile(connectorFile));
    await writeFile(path.join(evidence, '3001-saved-collider.json'), await readFile(colliderFile));
    expect(JSON.parse(await readFile(connectorFile, 'utf8')).status).toBe('draft');
    expect(JSON.parse(await readFile(colliderFile, 'utf8')).version).toBeGreaterThan(
      JSON.parse(original[1]!.toString()).version,
    );
    const timings = await page.evaluate(() => window.brickloopEditorTest.assembly().timings);
    const stats = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        frames: values.length,
        p50Ms: sorted[Math.floor(sorted.length * 0.5)],
        p95Ms: sorted[Math.floor(sorted.length * 0.95)],
        maxMs: sorted.at(-1),
      };
    };
    await writeFile(
      path.join(evidence, 'interaction-performance.json'),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          execution: 'Dedicated browser Worker; preview collision budget 4 ms',
          snap: stats(timings.map((t) => t.snapMs)),
          collision: stats(timings.map((t) => t.collisionMs)),
          timings,
        },
        null,
        2,
      ) + '\n',
    );
    await page.getByRole('button', { name: '关闭标注编辑器' }).click();
    await page.evaluate(() => window.brickloopEditorTest.prepareClose());
  } finally {
    if (app) {
      await (await app.firstWindow()).evaluate(() => window.brickloopEditorTest.prepareClose()).catch(() => undefined);
      await app.close();
    }
    await writeFile(connectorFile, original[0]!);
    await writeFile(colliderFile, original[1]!);
    await rm(directory, { recursive: true, force: true });
  }
});
