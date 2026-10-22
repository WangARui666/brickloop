import { access, mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import { setStableContentSize } from './window-size';
import type { ElectronApplication, Page } from '@playwright/test';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { serializeDocument } from '@brickloop/core';
import type { BrkDocument } from '@brickloop/core';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';
import type { ExportFormat } from '../src/shared/project-api';

declare global {
  interface Window {
    brickloopEditorTest: EditorTestApi;
  }
}
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataRoot = path.resolve(desktop, '../../.devdata/e2e');
const output = path.join(desktop, '../../.devdata/e2e-results');
const screenshots = path.join(output, 'screenshots/m2-4');
const exec = promisify(execFile);
async function launch(directory: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron({
    args: [desktop],
    env: { ...env, BRICKLOOP_DATA_DIR: directory },
    timeout: 30000,
  });
  const page = await app.firstWindow();

  await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', { timeout: 45000 });
  await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
  await expect(page.locator('.status-bar')).toContainText(/最后恢复点 \d\d:/);
  return { app, page };
}
async function stop(app: ElectronApplication) {
  const page = await app.firstWindow();
  if (!page.isClosed()) await page.evaluate(() => window.brickloopEditorTest.prepareClose());
  await app.close();
}
const snapshot = (page: Page) => page.evaluate(() => window.brickloopEditorTest.snapshot());
async function capture(app: ElectronApplication, page: Page, name: string) {
  await mkdir(screenshots, { recursive: true });
  for (const [width, height] of [
    [1440, 900],
    [1100, 700],
  ]) {
    await setStableContentSize(app, page, width!, height!);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const dialog = page.locator('.ant-modal:visible');
    if (await dialog.count()) await expect(dialog.last()).toHaveCSS('opacity', '1');
    await page.mouse.move(16, 16);
    await page.screenshot({
      path: path.join(screenshots, `${name}-${width}x${height}.png`),
      animations: 'disabled',
      scale: 'css',
    });
  }
}
async function selectAll(page: Page) {
  await page.locator('.document-title').click();
  await page.keyboard.press('Control+a');
}
async function nameDialog(page: Page, value: string) {
  await page.getByRole('textbox', { name: '名称', exact: true }).fill(value);
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toBeHidden();
}
async function pair(page: Page) {
  await page.evaluate(() => window.brickloopEditorTest.seed(2));
  const state = await snapshot(page),
    instances = Object.values(state.document.models[state.document.rootModelId]!.instances);
  await page.evaluate((id) => {
    window.brickloopEditorTest.select([[id]]);
    window.brickloopEditorTest.command({ type: 'color.set', colorId: 'c:bright-yellow' });
  }, instances[1]!.id);
  await selectAll(page);
  await page.keyboard.press('Control+Alt+g');
  await nameDialog(page, '车轮');
  const after = await snapshot(page),
    instance = Object.values(after.document.models[after.document.rootModelId]!.instances)[0]!;
  const modelId = instance.ref.kind === 'model' ? instance.ref.modelId : '';
  expect(modelId).toBeTruthy();
  await page.evaluate(
    (modelId) =>
      window.brickloopEditorTest.command({
        type: 'submodel.instantiate',
        modelId,
        transform: [240, -24, 0, 0, 0, 1, 0, 1, 0, -1, 0, 0],
      }),
    modelId,
  );
  await page.evaluate(() => window.brickloopEditorTest.structure());
  return { modelId, first: instance.id };
}
async function chooseSave(app: ElectronApplication, target: string) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, target);
}
async function confirmReport(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}
async function exportFile(
  app: ElectronApplication,
  page: Page,
  format: ExportFormat,
  target: string,
  screenshot = false,
) {
  await mkdir(path.dirname(target), { recursive: true });
  await chooseSave(app, target);
  await page.evaluate((format) => window.brickloopEditorTest.showExport(format), format);
  await expect(page.getByRole('dialog')).toBeVisible();
  if (screenshot) await capture(app, page, `export-dialog-${format}`);
  await page.getByRole('dialog').getByRole('button', { name: '导出', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('导出报告', { timeout: 45000 });
  if (screenshot) await capture(app, page, `export-report-${format}`);
  await confirmReport(page);
  expect((await readFile(target)).length).toBeGreaterThan(50);
}

test('GRP-01/02/03、MOD-01/02/03、MOD-07、CMD-05：结构与多标签编辑闭环', async () => {
  test.setTimeout(180000);
  await mkdir(dataRoot, { recursive: true });
  const directory = await mkdtemp(path.join(dataRoot, 'documents-'));
  const { app, page } = await launch(directory);
  try {
    await page.evaluate(() => window.brickloopEditorTest.seed(10));
    await selectAll(page);
    await page.keyboard.press('Control+g');
    await nameDialog(page, '底盘');
    await page.evaluate(() => window.brickloopEditorTest.structure());
    const groupBefore = (await snapshot(page)).document.groups;
    const point = await page.evaluate(() => window.brickloopEditorTest.project([0, -36, 0]));
    await page.mouse.click(point.x, point.y);
    expect((await snapshot(page)).workspace.selection).toHaveLength(10);
    await page.getByRole('button', { name: '底盘', exact: true }).click();
    expect((await snapshot(page)).workspace.selection).toHaveLength(10);
    await page.getByRole('button', { name: '底盘', exact: true }).dblclick();
    await expect(page.locator('.context-breadcrumb')).toContainText('底盘');
    const firstPart = Object.values(
      (await snapshot(page)).document.models[(await snapshot(page)).document.rootModelId]!.instances,
    )[0]!;
    await page.evaluate((id) => {
      window.brickloopEditorTest.select([[id]]);
      window.brickloopEditorTest.command({ type: 'color.set', colorId: 'c:bright-yellow' });
    }, firstPart.id);
    expect(
      Object.values(
        (await snapshot(page)).document.models[(await snapshot(page)).document.rootModelId]!.instances,
      ).filter((i) => i.colorId === 'c:bright-yellow'),
    ).toHaveLength(1);
    await page.locator('.document-title').click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '底盘', exact: true }).click();
    await page.keyboard.press('Control+Shift+g');
    expect(Object.keys((await snapshot(page)).document.groups)).toHaveLength(0);
    await page.keyboard.press('Control+z');
    expect((await snapshot(page)).document.groups).toEqual(groupBefore);
    await capture(app, page, 'grp-01-02-03');
    const beforeClone = await page.evaluate(() => window.brickloopEditorTest.normalized());
    await page.locator('.document-title').click();
    await page.keyboard.press('c');
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-placing', 'true');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.brickloopEditorTest.normalized())).toBe(beforeClone);
    await page.keyboard.press('Control+n');
    const source = await pair(page);
    let state = await snapshot(page);
    const root = state.document.models[state.document.rootModelId]!;
    const second = Object.values(root.instances).find((i) => i.id !== source.first)!;
    const roots = Object.values(root.instances).map((i) => i.transform);
    await page.evaluate((id) => window.brickloopEditorTest.enter([id]), source.first);
    await expect(page.locator('.shared-notice')).toContainText('被引用 2 次');
    const child = Object.values(state.document.models[source.modelId]!.instances)[1]!;
    await page.evaluate(
      ({ parent, child }) => {
        window.brickloopEditorTest.select([[parent, child]]);
        window.brickloopEditorTest.command({ type: 'color.set', colorId: 'c:bright-blue' });
      },
      { parent: source.first, child: child.id },
    );
    expect(
      (await page.evaluate(() => window.brickloopEditorTest.expanded())).filter((p) => p.colorId === 'c:bright-blue'),
    ).toHaveLength(2);
    expect(Object.values((await snapshot(page)).document.models[root.id]!.instances).map((i) => i.transform)).toEqual(
      roots,
    );
    await capture(app, page, 'shared-model-breadcrumb-tabs-inspector');
    for (const [tool, name] of [
      ['select', '选择'],
      ['move', '移动'],
      ['rotate', '旋转'],
    ]) {
      await page.getByRole('toolbar').getByRole('button', { name: name!, exact: true }).click();
      await capture(app, page, `toolbar-${tool}`);
    }
    await page.evaluate(() => window.brickloopEditorTest.enter([]));
    await page.evaluate((id) => window.brickloopEditorTest.select([[id]]), second.id);
    await page.evaluate(() => window.brickloopEditorTest.action('submodel.makeUnique'));
    state = await snapshot(page);
    const ref = state.document.models[root.id]!.instances[second.id]!.ref;
    expect(ref.kind).toBe('model');
    if (ref.kind !== 'model') throw new Error('Expected model');
    expect(ref.modelId).not.toBe(source.modelId);
    await page.evaluate((id) => window.brickloopEditorTest.enter([id]), second.id);
    const independentChild = Object.values(state.document.models[ref.modelId]!.instances)[1]!;
    await page.evaluate(
      ({ parent, child }) => {
        window.brickloopEditorTest.select([[parent, child]]);
        window.brickloopEditorTest.command({ type: 'color.set', colorId: 'c:bright-green' });
      },
      { parent: second.id, child: independentChild.id },
    );
    expect(
      (await page.evaluate(() => window.brickloopEditorTest.expanded())).filter((p) => p.colorId === 'c:bright-blue'),
    ).toHaveLength(1);
    await capture(app, page, 'mod-03-independent');
    // Copy two occurrences sharing the first definition to another document.
    await page.evaluate(({ modelId, first }) => {
      window.brickloopEditorTest.enter([]);
      window.brickloopEditorTest.command({ type: 'submodel.instantiate', modelId });
      const s = window.brickloopEditorTest.snapshot();
      const added = s.workspace.selection[0]!;
      window.brickloopEditorTest.select([[first], added]);
    }, source);
    await page.locator('.document-title').click();
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+n');
    await page.keyboard.press('Control+v');
    await expect.poll(async () => Object.keys((await snapshot(page)).document.models).length).toBe(2);
    state = await snapshot(page);
    const targets = Object.values(state.document.models[state.document.rootModelId]!.instances);
    expect(targets).toHaveLength(2);
    expect(targets[0]!.ref).toEqual(targets[1]!.ref);
    const targetId = state.document.documentId;
    await page.keyboard.press('Control+z');
    expect(
      Object.values((await snapshot(page)).document.models[(await snapshot(page)).document.rootModelId]!.instances),
    ).toHaveLength(0);
    const sourceId = state.state.tabs.at(-2)!.id;
    await page.evaluate((id) => window.brickloopEditorTest.switch(id), sourceId);
    expect(Object.values((await snapshot(page)).document.models[root.id]!.instances)).toHaveLength(3);
    await page.evaluate((id) => window.brickloopEditorTest.switch(id), targetId);
    await page.keyboard.press('Control+Shift+z');
    await capture(app, page, 'mod-07-cmd-05-cross-tab');
    await page.keyboard.press('Control+w');
    await expect(page.getByRole('dialog')).toContainText('保存更改');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect((await snapshot(page)).state.activeId).toBe(targetId);
    await writeFile(
      path.join(output, 'm2-4-structure.json'),
      await page.evaluate(() => window.brickloopEditorTest.normalized()),
    );
  } finally {
    await stop(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test('P01/P02/CMD-04、导出 IO/OBJ/DAE/GLB/BOM、模型信息与截图', async () => {
  test.setTimeout(240000);
  await mkdir(dataRoot, { recursive: true });
  await mkdir(path.join(output, 'io'), { recursive: true });
  const directory = await mkdtemp(path.join(dataRoot, 'files-'));
  const { app, page } = await launch(directory);
  try {
    await pair(page);
    const file = path.join(directory, 'shared.brkl');
    await chooseSave(app, file);
    await page.locator('.document-title').click();
    await page.keyboard.press('Control+s');
    await expect(page).not.toHaveTitle(/•/);
    await page.evaluate(() => window.brickloopEditorTest.flush());
    const normalized = await page.evaluate(() => window.brickloopEditorTest.normalized());
    const saved = unzipSync(new Uint8Array(await readFile(file)));
    const { version } = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8')) as { version: string };
    expect(JSON.parse(strFromU8(saved['manifest.json']!)).appVersion).toBe(version);
    expect(serializeDocument(JSON.parse(strFromU8(saved['document.json']!)) as BrkDocument)).toBe(normalized);
    const thumb = saved['thumbnail.png']!;
    expect(Buffer.from(thumb).readUInt32BE(16)).toBe(512);
    expect(Buffer.from(thumb).readUInt32BE(20)).toBe(512);
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveTitle(/•/);
    await page.keyboard.press('Control+z');
    await expect(page).not.toHaveTitle(/•/);
    await page.keyboard.press('Control+w');
    await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
    expect(await page.evaluate(() => window.brickloopEditorTest.normalized())).toBe(normalized);
    await capture(app, page, 'p01-saved-reopened');
    // Windows ACL denies writes to this test-owned directory, including atomic temp files.
    const readonly = path.join(directory, 'readonly');
    await mkdir(readonly);
    const protectedFile = path.join(readonly, 'shared.brkl');
    await copyFile(file, protectedFile);
    const before = await readFile(protectedFile);
    const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    await exec('icacls', [readonly, '/deny', `${account}:(OI)(CI)(W)`], { windowsHide: true });
    try {
      await page.evaluate(() =>
        window.brickloopEditorTest.command({
          type: 'submodel.instantiate',
          modelId: Object.values(window.brickloopEditorTest.snapshot().document.models).find(
            (m) => m.kind === 'submodel',
          )!.id,
        }),
      );
      await chooseSave(app, protectedFile);
      await page.keyboard.press('Control+Shift+s');
      await expect(page.getByRole('dialog')).toContainText('没有写入权限');
      await expect(page).toHaveTitle(/•/);
      await capture(app, page, 'p02-save-permission');
      await confirmReport(page);
    } finally {
      await exec('icacls', [readonly, '/remove:d', account], { windowsHide: true });
    }
    expect(await readFile(protectedFile)).toEqual(before);
    // Remove the P02 edit, retaining two shared occurrences for Studio review.
    await page.keyboard.press('Control+z');
    for (const format of ['io', 'ldr', 'mpd', 'obj', 'dae', 'glb', 'csv', 'xlsx'] as const)
      await exportFile(
        app,
        page,
        format,
        path.join(output, 'io', `m2-4-shared.${format}`),
        ['io', 'obj', 'xlsx'].includes(format),
      );
    const exported = unzipSync(new Uint8Array(await readFile(path.join(output, 'io', 'm2-4-shared.io'))));
    expect(exported['modelv2.ldr']).toBeTruthy();
    expect(exported['thumbnail.png']).toBeTruthy();
    const xlsx = unzipSync(new Uint8Array(await readFile(path.join(output, 'io', 'm2-4-shared.xlsx'))));
    const images = Object.keys(xlsx).filter((key) => key.startsWith('xl/media/') && key.endsWith('.png'));
    expect(images).toHaveLength(2);
    expect(xlsx[images[0]!]).not.toEqual(xlsx[images[1]!]);
    const strings = strFromU8(xlsx['xl/sharedStrings.xml']!);
    expect(strings).toContain('数量');
    await writeFile(
      path.join(output, 'io', 'm2-4-bom-content.txt'),
      `BOM 内容摘要\n共 4 件，1 种零件，2 种颜色。\n已嵌入 ${images.length} 张对应颜色的缩略图，图片字节不同。\n首行冻结：${strFromU8(xlsx['xl/worksheets/sheet1.xml']!).includes('state="frozen"') ? '是' : '否'}\n\n${await readFile(path.join(output, 'io', 'm2-4-shared.csv'), 'utf8')}`,
    );
    await page.evaluate(() => window.brickloopEditorTest.action('model.info'));
    await expect(page.getByRole('dialog')).toContainText('展开总件数');
    await capture(app, page, 'model-info');
    await confirmReport(page);
    await exportFile(app, page, 'png', path.join(output, 'io', 'm2-4-viewport.png'), true);
    await page.evaluate((file) => window.brickloopEditorTest.open(file), path.join(output, 'io', 'm2-4-shared.io'));
    await expect(page.getByRole('tab', { selected: true })).toContainText('m2-4-shared.io');
    await expect(page.getByRole('tab', { selected: true })).not.toContainText('model.ldr');
    await expect(page).toHaveTitle(/m2-4-shared\.io/);
    await expect(page).not.toHaveTitle(/model\.ldr/);
    await expect(page.getByRole('dialog')).toContainText('展开总件数');
    await capture(app, page, 'io-roundtrip-report');
    await confirmReport(page);
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded())).toHaveLength(4);
  } finally {
    await stop(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test('REC-01：强制结束后发现恢复文档，恢复后结构一致', async () => {
  test.setTimeout(120000);
  await mkdir(dataRoot, { recursive: true });
  const directory = await mkdtemp(path.join(dataRoot, 'crash-'));
  let running = await launch(directory);
  try {
    await pair(running.page);
    await running.page.evaluate(() => window.brickloopEditorTest.preset('front'));
    const savedPath = path.join(directory, 'recovery-after-save.brkl');
    await chooseSave(running.app, savedPath);
    await running.page.evaluate(() => window.brickloopEditorTest.save(true));
    await expect(running.page).not.toHaveTitle(/•/);
    await running.page.evaluate(() =>
      window.brickloopEditorTest.command({ type: 'transform.translate', delta: [20, 0, 0] }),
    );
    await running.page.evaluate(() => window.brickloopEditorTest.flush());
    // Recovery restores workspace state from the snapshot, not the transaction journal.
    const beforeCrash = await snapshot(running.page);
    const checkpoint = path.join(
      directory,
      'recovery',
      beforeCrash.document.documentId,
      `snapshot-${beforeCrash.document.revision}.brkl`,
    );
    await expect
      .poll(
        () =>
          access(checkpoint).then(
            () => true,
            () => false,
          ),
        { timeout: 45_000 },
      )
      .toBe(true);
    // Keep REC-01's journal replay coverage: make one more edit after that snapshot.
    await running.page.evaluate(() =>
      window.brickloopEditorTest.command({ type: 'transform.translate', delta: [20, 0, 0] }),
    );
    await running.page.evaluate(() => window.brickloopEditorTest.flush());
    const expected = await running.page.evaluate(() => window.brickloopEditorTest.normalized());
    await capture(running.app, running.page, 'rec-01-before-crash');
    const savedCamera = await running.page.evaluate(() => window.brickloopEditorTest.camera());
    const process = running.app.process();
    const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
    await exec('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true });
    await exited;
    running = await launch(directory);
    await expect(running.page.getByRole('dialog')).toContainText('恢复未保存的文档');
    await expect(running.page.getByRole('dialog')).toContainText(savedPath);
    await capture(running.app, running.page, 'recovery-dialog');
    await running.page.getByRole('button', { name: '恢复', exact: true }).click();
    await expect(running.page.getByRole('dialog')).toBeHidden();
    await expect(running.page).toHaveTitle(/•/);
    expect(await running.page.evaluate(() => window.brickloopEditorTest.normalized())).toBe(expected);
    await running.page.evaluate(() => window.brickloopEditorTest.meshesReady());
    const recoveredCamera = await running.page.evaluate(() => window.brickloopEditorTest.camera());
    expect(recoveredCamera.mode).toBe(savedCamera.mode);
    expect(recoveredCamera.span).toBeCloseTo(savedCamera.span, 3);
    for (const key of ['position', 'target', 'up'] as const)
      recoveredCamera[key].forEach((value, axis) => expect(value).toBeCloseTo(savedCamera[key][axis]!, 3));
    await capture(running.app, running.page, 'rec-01-restored');
    await exportFile(running.app, running.page, 'io', path.join(output, 'io', 'm2-4-recovered.io'));
    await writeFile(path.join(output, 'm2-4-recovered.json'), expected);
    const recoveredId = (await snapshot(running.page)).document.documentId;
    await running.page.locator('.document-title').click();
    await running.page.keyboard.press('Control+w');
    await running.page.getByRole('button', { name: '不保存', exact: true }).click();
    await expect.poll(async () => (await snapshot(running.page)).document.documentId).not.toBe(recoveredId);
    expect(
      await access(path.join(directory, 'recovery', recoveredId)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await stop(running.app);
    await rm(directory, { recursive: true, force: true });
  }
});

test('M9-5d：未保存的中文 .io 文件名在关闭确认、恢复对话框和恢复标签中保留', async () => {
  test.setTimeout(120000);
  await mkdir(dataRoot, { recursive: true });
  const directory = await mkdtemp(path.join(dataRoot, 'io-title-recovery-'));
  const source = path.join(directory, '彩色积木.io');
  await writeFile(
    source,
    zipSync({
      'model.ldr': strToU8('0 FILE model.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n0 NOFILE'),
    }),
  );
  let running = await launch(directory);
  try {
    await running.page.evaluate((file) => window.brickloopEditorTest.open(file), source);
    await confirmReport(running.page);
    await expect(running.page.getByRole('tab', { selected: true })).toContainText('彩色积木.io');
    await expect(running.page).toHaveTitle(/彩色积木\.io/);
    await running.page.locator('.document-title').click();
    await running.page.keyboard.press('Control+w');
    await expect(running.page.getByRole('dialog')).toContainText('彩色积木.io');
    await running.page.getByRole('button', { name: '取消', exact: true }).click();
    await running.page.evaluate(() => window.brickloopEditorTest.flush());
    const expected = await running.page.evaluate(() => window.brickloopEditorTest.normalized());
    const id = (await snapshot(running.page)).document.documentId;
    const stored = unzipSync(new Uint8Array(await readFile(path.join(directory, 'recovery', id, 'snapshot-0.brkl'))));
    const { version } = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8')) as { version: string };
    expect(JSON.parse(strFromU8(stored['manifest.json']!)).appVersion).toBe(version);
    const process = running.app.process();
    const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
    await exec('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true });
    await exited;
    running = await launch(directory);
    await expect(running.page.getByRole('dialog')).toContainText('恢复未保存的文档');
    await expect(running.page.getByRole('dialog')).toContainText('彩色积木.io');
    await expect(running.page.getByRole('dialog')).not.toContainText('model.ldr');
    await running.page.getByRole('button', { name: '恢复', exact: true }).click();
    await expect(running.page.getByRole('dialog')).toBeHidden();
    await expect(running.page.getByRole('tab', { selected: true })).toContainText('彩色积木.io');
    await expect(running.page).toHaveTitle(/彩色积木\.io/);
    await expect(running.page).not.toHaveTitle(/model\.ldr/);
    expect(await running.page.evaluate(() => window.brickloopEditorTest.normalized())).toBe(expected);
  } finally {
    await stop(running.app);
    await rm(directory, { recursive: true, force: true });
  }
});

test('IO-01：Banana 样例显示 186 件与 Studio 内容导入报告', async () => {
  test.setTimeout(120000);
  const banana = process.env.BRICKLOOP_STUDIO_BANANA;
  if (!banana) {
    test.skip(true, 'BRICKLOOP_STUDIO_BANANA is not set');
    return;
  }
  const exists = await access(banana).then(
    () => true,
    () => false,
  );
  test.skip(!exists, `Banana sample unavailable: ${banana}`);
  await mkdir(dataRoot, { recursive: true });
  const directory = await mkdtemp(path.join(dataRoot, 'banana-'));
  const { app, page } = await launch(directory);
  try {
    await page.evaluate((file) => window.brickloopEditorTest.open(file), banana);
    await expect(page.getByRole('dialog')).toContainText('186');
    await expect(page.getByRole('dialog')).toContainText('Studio');
    await capture(app, page, 'banana-import-report');
    await confirmReport(page);
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded())).toHaveLength(186);
    await capture(app, page, 'banana-imported');
  } finally {
    await stop(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test('跨窗口剪贴板：两个应用窗口保留同一选择中的子模型共享', async () => {
  test.setTimeout(120000);
  await mkdir(dataRoot, { recursive: true });
  const directories = [
    await mkdtemp(path.join(dataRoot, 'clipboard-a-')),
    await mkdtemp(path.join(dataRoot, 'clipboard-b-')),
  ];
  const first = await launch(directories[0]!);
  let second: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    await pair(first.page);
    await selectAll(first.page);
    await first.page.keyboard.press('Control+c');
    second = await launch(directories[1]!);
    await second.page.locator('.document-title').click();
    await second.page.keyboard.press('Control+v');
    await expect.poll(async () => Object.keys((await snapshot(second!.page)).document.models).length).toBe(2);
    const state = await snapshot(second.page),
      rows = Object.values(state.document.models[state.document.rootModelId]!.instances);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.ref).toEqual(rows[1]!.ref);
    await second.page.evaluate(() => {
      window.brickloopEditorTest.structure();
      window.brickloopEditorTest.action('view.fitAll');
    });
    await capture(second.app, second.page, 'cross-window-clipboard');
  } finally {
    if (second) await stop(second.app);
    await stop(first.app);
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
});
