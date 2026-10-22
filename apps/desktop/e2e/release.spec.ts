import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import { setStableContentSize } from './window-size';
import type { ElectronApplication, Page } from '@playwright/test';
import { createDocument, createWorkspace, DocumentSession, toLDraw, translation } from '@brickloop/core';
import { packProject } from '../../../packages/io/src/project';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';
import { exportShortcuts, assignShortcut, effectiveShortcuts } from '../src/shared/shortcuts';
import { writePack } from '@brickloop/catalog';
import { defaultPreferences } from '../src/shared/preferences';

declare global {
  interface Window {
    brickloopEditorTest: EditorTestApi;
  }
}
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(desktop, '../../.devdata/e2e');
const evidence = path.join(desktop, '../../.devdata/e2e-evidence/m7-2');
test.setTimeout(180000);
async function launch(directory: string, files: string[] = []) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron({
    args: [desktop, ...files],
    env: { ...env, BRICKLOOP_DATA_DIR: directory },
    timeout: 30000,
  });
  const page = await app.firstWindow();

  await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', { timeout: 45000 });
  await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
  return { app, page };
}
async function stop(app: ElectronApplication) {
  const page = await app.firstWindow();
  await page.evaluate(() => window.brickloopEditorTest.prepareClose());
  await app.close();
}
async function capture(app: ElectronApplication, page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  for (const [width, height] of [
    [1440, 900],
    [1100, 700],
  ] as const) {
    await setStableContentSize(app, page, width, height);
    await page.mouse.move(16, 16);
    await page.waitForTimeout(240);
    await page.screenshot({
      path: path.join(evidence, `${name}-${width}x${height}.png`),
      animations: 'disabled',
      scale: 'css',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
}
async function chooseSave(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, file);
}
async function chooseOpen(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
}
async function fixture(directory: string, title = '彩色积木搭建说明') {
  const session = new DocumentSession(createDocument({ title }), { bboxProvider: () => [-40, -4, -20, 40, 24, 20] });
  for (let step = 0; step < 8; step++) {
    if (step) {
      const added = session.dispatch({ type: 'step.add' });
      if (!added.ok) throw new Error('step');
    }
    const model = session.document.models[session.document.rootModelId]!;
    const colorId = ['c:bright-red', 'c:bright-yellow', 'c:bright-blue', 'c:dark-green'][step % 4]!;
    const result = session.dispatch({
      type: 'part.add',
      partId: 'ld:3001',
      colorId,
      stepId: model.stepIds.at(-1)!,
      transform: toLDraw(translation([step * 100, -24, 0])),
    });
    if (!result.ok) throw new Error(result.error.messageKey);
  }
  if (title === '彩色积木搭建说明') {
    const rootModel = session.document.models[session.document.rootModelId]!;
    session.setContext({
      activeModelPath: [],
      selection: Object.keys(rootModel.instances)
        .slice(4)
        .map((id) => [id]),
    });
    const created = session.dispatch({ type: 'submodel.create', name: '四色组件' });
    if (!created.ok) throw new Error(created.error.messageKey);
    const child = Object.values(session.document.models).find((model) => model.id !== session.document.rootModelId)!;
    const parent = session.document.models[session.document.rootModelId]!;
    const lastStep = parent.stepIds[4]!;
    session.setContext({ activeModelPath: [], selection: [] });
    const copy = session.dispatch({
      type: 'submodel.instantiate',
      modelId: child.id,
      stepId: lastStep,
      transform: toLDraw(translation([550, -24, 160])),
    });
    if (!copy.ok) throw new Error(copy.error.messageKey);
    for (const stepId of parent.stepIds.slice(5)) {
      const removed = session.dispatch({ type: 'step.remove', stepId, targetStepId: lastStep });
      if (!removed.ok) throw new Error(removed.error.messageKey);
    }
  }
  const file = path.join(directory, `${title}.brkl`);
  await writeFile(file, packProject(session.document, createWorkspace(), {}));
  return file;
}

test('M7-2 settings, shortcut conflict/import/export, about licenses and persistence', async () => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'release-settings-'));
  await writeFile(
    path.join(directory, 'settings.json'),
    JSON.stringify({ language: 'zh-CN', preferences: { ...defaultPreferences, snapshotMinutes: 7 } }),
  );
  let running = await launch(directory);
  try {
    const { app, page } = running;
    expect((await page.evaluate(() => window.brickloop.getAppInfo())).dataDirectory).toBe(
      path.join(directory, 'config'),
    );
    expect(await page.evaluate(() => window.brickloopEditorTest.preferences().snapshotMinutes)).toBe(7);
    await page.keyboard.press('Control+,');
    await expect(page.getByRole('dialog')).toBeVisible();
    const tabs = ['常规', '编辑', '快捷键', '零件库', 'AI 助手', '外部智能体', '高级'];
    for (const [index, label] of tabs.entries()) {
      await page.locator('.settings-tabs > .ant-tabs-nav').getByRole('tab', { name: label, exact: true }).click();
      await capture(
        app,
        page,
        `settings-${['general', 'editing', 'shortcuts', 'library', 'ai', 'external', 'advanced'][index]}`,
      );
    }
    await page.getByRole('tab', { name: '快捷键', exact: true }).click();
    await page.getByRole('button', { name: '修改“保存”快捷键', exact: true }).click();
    await page.locator('.key-recorder').press('Control+o');
    await expect(page.getByRole('dialog', { name: '快捷键冲突' })).toContainText('打开');
    await capture(app, page, 'shortcut-conflict');
    await page.getByRole('dialog', { name: '快捷键冲突' }).getByRole('button', { name: '取消', exact: true }).click();
    expect((await page.evaluate(() => window.brickloopEditorTest.preferences())).shortcuts['file.save']).toEqual([
      'Ctrl+S',
    ]);
    await page.getByRole('button', { name: '修改“保存”快捷键', exact: true }).click();
    await page.locator('.key-recorder').press('Control+o');
    await page.getByRole('button', { name: '覆盖', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.preferences().shortcuts['file.open']))
      .toEqual([]);
    const keysFile = path.join(directory, 'shortcuts.json');
    await chooseSave(app, keysFile);
    await page.getByRole('button', { name: '导出 JSON…', exact: true }).click();
    await expect
      .poll(async () =>
        readFile(keysFile, 'utf8').then(
          (text) => JSON.parse(text).bindings['file.save'],
          () => null,
        ),
      )
      .toEqual(['Ctrl+O']);
    await writeFile(keysFile, exportShortcuts(assignShortcut(effectiveShortcuts(), 'file.save', 'Ctrl+Shift+J')));
    await chooseOpen(app, keysFile);
    await page.getByRole('button', { name: '导入 JSON…', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.preferences().shortcuts['file.save']))
      .toEqual(['Ctrl+Shift+J']);
    const importedConflict = effectiveShortcuts();
    importedConflict['file.save'] = ['Ctrl+O'];
    await writeFile(keysFile, JSON.stringify({ version: 1, bindings: importedConflict }));
    await page.getByRole('button', { name: '导入 JSON…', exact: true }).click();
    await page.getByRole('dialog', { name: '快捷键冲突' }).getByRole('button', { name: '取消', exact: true }).click();
    expect(await page.evaluate(() => window.brickloopEditorTest.preferences().shortcuts['file.save'])).toEqual([
      'Ctrl+Shift+J',
    ]);
    await page.getByRole('button', { name: '导入 JSON…', exact: true }).click();
    await page.getByRole('dialog', { name: '快捷键冲突' }).getByRole('button', { name: '覆盖', exact: true }).click();
    expect(await page.evaluate(() => window.brickloopEditorTest.preferences().shortcuts['file.open'])).toEqual([]);
    await page.getByRole('button', { name: '恢复默认', exact: true }).click();
    await page.getByRole('tab', { name: '常规', exact: true }).click();
    await page.getByRole('spinbutton', { name: '快照间隔' }).fill('2');
    await page.getByRole('spinbutton', { name: '快照间隔' }).press('Tab');
    await page.getByRole('checkbox', { name: '启动时打开上次工程' }).check();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).last().click();
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeHidden();
    await page.evaluate(async () => {
      const api = window.brickloopEditorTest,
        value = api.preferences();
      await api.savePreferences({ shortcuts: { ...value.shortcuts, 'edit.delete': ['J'], 'edit.undo': ['Ctrl+U'] } });
      await api.seed(1);
      api.select(
        Object.keys(api.snapshot().document.models[api.snapshot().document.rootModelId]!.instances).map((id) => [id]),
      );
    });
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
    await expect(page.getByRole('menuitem').filter({ hasText: /^删除/ }).locator('.shortcut')).toHaveText('J');
    await page.keyboard.press('Escape');
    await page.getByTestId('viewport-host').click({ button: 'right', position: { x: 300, y: 180 } });
    await expect(
      page.locator('.viewport-context-menu').getByRole('menuitem').filter({ hasText: /^删除/ }).locator('.shortcut'),
    ).toHaveText('J');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '撤销', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText('Ctrl+U');
    await page.mouse.move(16, 16);
    await page.locator('.document-title').click();
    await page.evaluate(() => {
      const api = window.brickloopEditorTest,
        doc = api.snapshot().document;
      api.select(Object.keys(doc.models[doc.rootModelId]!.instances).map((id) => [id]));
    });
    await page.keyboard.press('Delete');
    expect((await page.evaluate(() => window.brickloopEditorTest.expanded())).length).toBe(1);
    await page.keyboard.press('j');
    expect((await page.evaluate(() => window.brickloopEditorTest.expanded())).length).toBe(0);
    await page.keyboard.press('Control+u');
    expect((await page.evaluate(() => window.brickloopEditorTest.expanded())).length).toBe(1);
    await page.evaluate(() => window.brickloopEditorTest.about());
    await expect(page.getByRole('dialog', { name: '关于 Brickloop' })).toContainText('以 MIT 许可证开源。');
    await expect(page.getByRole('dialog', { name: '关于 Brickloop' })).toContainText('开发者：孤独翼梦（Vesperis）');
    await expect(page.getByRole('dialog', { name: '关于 Brickloop' })).toContainText(
      'Copyright © 2026 孤独翼梦（Vesperis）',
    );
    await capture(app, page, 'about');
    await page.getByRole('tab', { name: '开源许可' }).click();
    await expect(page.locator('.license-list')).toContainText('LDraw.org Parts Library');
    await expect(page.locator('.license-list')).toContainText('Noto Sans SC');
    await expect(page.locator('.license-list article')).toHaveCount(
      (await page.evaluate(() => window.brickloop.aboutInfo())).licenses.length,
    );
    await capture(app, page, 'licenses');
    await page.locator('.license-list').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await capture(app, page, 'licenses-attributions');
    await page.getByRole('textbox', { name: '搜索名称或许可' }).fill('Noto');
    await page.getByText('查看许可与署名').click();
    await expect(page.locator('.license-list')).toContainText('SIL OPEN FONT LICENSE');
    await stop(app);
    running = await launch(directory);
    await expect
      .poll(() => running.page.evaluate(() => window.brickloopEditorTest.preferences().snapshotMinutes))
      .toBe(2);
    expect(await running.page.evaluate(() => window.brickloopEditorTest.preferences().reopenLast)).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(directory, 'config/settings.json'), 'utf8')).preferences.snapshotMinutes,
    ).toBe(2);
  } finally {
    await stop(running.app);
    await rm(directory, { recursive: true, force: true });
  }
});

test('M7-2 instruction PDF cancel/success, fixed camera scale and associated file delivery', async () => {
  await mkdir(root, { recursive: true });
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'release-pdf-')),
    file = await fixture(directory);
  const { app, page } = await launch(directory, [file]);
  try {
    await expect(page.locator('.document-title')).toContainText('彩色积木搭建说明');
    await page.evaluate(() => window.brickloopEditorTest.meshesReady());
    const frames = await page.evaluate(() => window.brickloopEditorTest.instructionFrames());
    expect(frames).toHaveLength(9);
    const bounds = await page.evaluate(
      async (frames) => {
        const results = [];
        for (const frame of frames) {
          const image = new Image();
          image.src = `data:image/png;base64,${btoa(frame.png.map((byte) => String.fromCharCode(byte)).join(''))}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let x0 = Infinity,
            x1 = -1,
            y0 = Infinity,
            y1 = -1;
          // First red part is on the right of the isometric projection, separated from later parts.
          for (let y = 0; y < canvas.height; y++)
            for (let x = 0; x < canvas.width; x++) {
              const i = (y * canvas.width + x) * 4;
              if (pixels[i + 3]! > 200 && pixels[i]! > pixels[i + 1]! * 1.6 && pixels[i]! > pixels[i + 2]! * 1.6) {
                x0 = Math.min(x0, x);
                x1 = Math.max(x1, x);
                y0 = Math.min(y0, y);
                y1 = Math.max(y1, y);
              }
            }
          results.push({ modelId: frame.modelId, bbox: [x0, y0, x1, y1] });
        }
        return results;
      },
      frames.filter((frame) => frame.step < 4),
    );
    expect(new Set(bounds.map((row) => row.modelId)).size).toBe(2);
    for (const row of bounds) {
      expect(row.bbox[2]).toBeGreaterThan(row.bbox[0]!);
      expect(row.bbox).toEqual(bounds.find((first) => first.modelId === row.modelId)!.bbox);
    }
    for (const [index, frame] of frames.entries())
      await writeFile(path.join(evidence, `instruction-step-${index + 1}.png`), new Uint8Array(frame.png));
    const pdf = path.join(evidence, 'instructions-A4-landscape-4-steps.pdf');
    await chooseSave(app, pdf);
    await page.evaluate(() => window.brickloopEditorTest.pdf());
    await capture(app, page, 'instructions-dialog');
    await page.getByRole('dialog').getByRole('button', { name: '导出', exact: true }).click();
    await expect(page.locator('.instruction-progress')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('已取消，未写入文件');
    await page.getByRole('dialog').getByRole('button', { name: '导出', exact: true }).click();
    await expect(page.locator('.instruction-progress')).toBeVisible();
    await capture(app, page, 'instructions-progress');
    await expect(page.getByRole('dialog')).toContainText('说明书已保存', { timeout: 120000 });
    expect((await readFile(pdf)).subarray(0, 5).toString()).toBe('%PDF-');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).last().click();
    const nextFile = await fixture(directory, '第二个工程');
    await app.evaluate(
      ({ app }, [file, cwd]) => {
        app.emit('second-instance', {}, ['brickloop', file], cwd, {});
      },
      [nextFile, directory],
    );
    await expect(page.locator('.document-title')).toContainText('第二个工程');
    await app.evaluate(
      ({ app }, [file, cwd]) => {
        app.emit('second-instance', {}, ['brickloop', file], cwd, {});
      },
      [file, directory],
    );
    await expect(page.locator('.document-title')).toContainText('彩色积木搭建说明');
    expect(await page.locator('.document-tab').count()).toBe(2);
    // A copied file shares the project identity but must still open as its own tab.
    const copy = path.join(directory, '工程副本.brkl');
    await copyFile(file, copy);
    await app.evaluate(
      ({ app }, [file, cwd]) => {
        app.emit('second-instance', {}, ['brickloop', file], cwd, {});
      },
      [copy, directory],
    );
    await expect(page.locator('.document-tab')).toHaveCount(3);
    await expect(page.locator('.document-title')).toContainText('工程副本');
  } finally {
    await stop(app);
    await rm(directory, { recursive: true, force: true });
  }
});

test('M7-2 associated data pack review and impact confirmation across open projects', async () => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'release-pack-'));
  const file = await fixture(directory),
    second = await fixture(directory, '另一个搭建工程');
  const { app, page } = await launch(directory, [file, second]);
  try {
    await expect(page.locator('.document-tab')).toHaveCount(2);
    const library = await page.evaluate(async () => ({
      parts: await window.brickloop.catalogSearch('', { includeAll: false }),
      colors: (await window.brickloop.catalogColors()).factory,
      catalog: await window.brickloop.assemblyCatalog(),
    }));
    const target = path.join(directory, 'factory update.brklpack');
    await writePack(target, {
      manifest: {
        id: 'release-fixture',
        name: '精简工厂数据包',
        version: '1.0.0',
        source: 'Brickloop test fixture',
        createdAt: '2026-10-16T00:00:00Z',
        templateVersion: 1,
        contentHash: '',
      },
      parts: library.parts
        .filter((p) => p.id !== 'ld:3001')
        .map((p) => ({
          partId: p.id,
          factoryNo: p.factoryNo ?? p.id,
          factoryName: p.nameZh,
          legoNo: p.legoNo,
          ldrawFile: p.ldrawFile,
          status: 'active',
          colors: (library.catalog.parts.find((v) => v.id === p.id)?.colors ?? []).filter(
            (c) => c !== 'c:bright-red',
          ) as (typeof library.colors)[number]['id'][],
        })),
      colors: library.colors
        .filter((c) => c.id !== 'c:bright-red')
        .map((c) => ({ colorId: c.id, factoryCode: c.factoryCode!, measuredRgb: c.rgb, definition: c })),
      categories: [],
      assets: {},
    });
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('menuitem', { name: '数据包管理', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '数据包管理' })).toBeVisible();
    await app.evaluate(
      ({ app }, [file, cwd]) => {
        app.emit('second-instance', {}, ['brickloop', file], cwd, {});
      },
      [target, directory],
    );
    await expect(page.getByRole('dialog', { name: '数据包管理' })).toContainText('精简工厂数据包');
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '切换数据包的影响' })).toContainText('另一个搭建工程');
    await expect(page.getByRole('dialog', { name: '切换数据包的影响' })).toContainText('3001');
    await expect(page.getByRole('dialog', { name: '切换数据包的影响' })).toContainText('亮红');
    await capture(app, page, 'pack-impact');
    await page
      .getByRole('dialog', { name: '切换数据包的影响' })
      .getByRole('button', { name: '取消', exact: true })
      .click();
    expect((await page.evaluate(() => window.brickloop.catalogStatus())).pack?.id).toBe('demo');
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await page
      .getByRole('dialog', { name: '切换数据包的影响' })
      .getByRole('button', { name: '继续', exact: true })
      .click();
    await expect
      .poll(async () => (await page.evaluate(() => window.brickloop.catalogStatus())).pack?.id)
      .toBe('release-fixture');
    await page.locator('.pack-manager .ant-modal-close').click();
    await page.evaluate(() => window.brickloopEditorTest.assemblyReady());
    await page.evaluate(() => window.brickloopEditorTest.action('model.info'));
    await expect(page.locator('.model-info-content')).not.toContainText('尚未检查');
  } finally {
    await stop(app);
    await rm(directory, { recursive: true, force: true });
  }
});
