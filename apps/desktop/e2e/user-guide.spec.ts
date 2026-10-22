import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import { setStableContentSize } from './window-size';
import type { ElectronApplication, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDocument, createWorkspace, DocumentSession, toLDraw, translation } from '@brickloop/core';
import { packProject } from '../../../packages/io/src/project';
import { writePack } from '@brickloop/catalog';
import { fakeModel } from './ai-model-fixture';
import { imageModelServer } from './image-model-fixture';
import { fakeOAuth } from '../../../packages/ai/test/oauth-fixture';
import { guideHouseParts, guideHousePlan } from './guide-house-fixture';
import { guidePng } from './guide-png-fixture';
import { animationCottage } from './animation-fixture';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';
import type { DesktopApi } from '../src/shared/api';

declare global {
  interface Window {
    brickloopEditorTest: EditorTestApi;
    brickloop: DesktopApi;
  }
}
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(desktop, '../..');
const { version } = JSON.parse(await readFile(path.join(desktop, 'package.json'), 'utf8')) as { version: string };
const temporary = path.join(root, '.devdata/tmp/docs-screenshots');
const images = path.join(root, 'docs/user-guide/images');
const generated = new Set<string>();
const environment = () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.BRICKLOOP_EVAL_API_KEY;
  return env;
};
async function launch(directory: string, files: string[] = [], packaged = false, pipe?: string, oauth?: string) {
  const app = await launchElectron({
    ...(packaged
      ? { executablePath: path.join(root, 'dist/win-unpacked/Brickloop.exe'), args: files }
      : { args: [desktop, '--host-resolver-rules=MAP guide-model.test 127.0.0.1', ...files] }),
    env: {
      ...environment(),
      BRICKLOOP_DATA_DIR: directory,
      ...(pipe ? { BRICKLOOP_MCP_PIPE: pipe } : {}),
      ...(oauth ? { BRICKLOOP_TEST_OAUTH: oauth } : {}),
    },
    timeout: 45000,
  });
  const page = await app.firstWindow();

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.webContents.setBackgroundThrottling(false);
  });
  await setStableContentSize(app, page, 1440, 900);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', { timeout: 90000 });
  if (!packaged) await page.waitForFunction(() => !!window.brickloopEditorTest);
  return { app, page };
}
async function isolated(
  name: string,
  run: (app: ElectronApplication, page: Page, directory: string) => Promise<void>,
  oauth?: string,
) {
  await mkdir(temporary, { recursive: true });
  const directory =
    name === 'workspace' ? await teachingDirectory('导入导出演示') : await mkdtemp(path.join(temporary, `${name}-`));
  const { app, page } = await launch(directory, [], false, undefined, oauth);
  try {
    await run(app, page, directory);
  } finally {
    await page.evaluate(() => window.brickloopEditorTest.prepareClose()).catch(() => undefined);
    await app.close();
    await cleanup(directory);
  }
}
async function cleanup(directory: string) {
  if (path.dirname(path.resolve(directory)) !== temporary) throw new Error('Unsafe guide cleanup path');
  await rm(directory, { recursive: true, force: true });
}
async function teachingDirectory(name: '导入导出演示' | '恢复演示') {
  const directory = path.join(temporary, name);
  await cleanup(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}
async function capture(app: ElectronApplication, page: Page, id: string, keepPointer = false) {
  if (!keepPointer) await page.mouse.move(16, 16);
  if (await page.locator('.ant-modal-close:focus').count()) {
    await page.locator('.ant-modal:visible .ant-modal-title').last().click();
    if (!keepPointer) await page.mouse.move(16, 16);
  }
  if (await page.evaluate(() => !!window.brickloopEditorTest))
    await page.evaluate(async () => {
      await window.brickloopEditorTest.meshesReady();
      await window.brickloopEditorTest.assemblyReady();
    });
  await expect(page.locator('.thumbnail-skeleton')).toHaveCount(0, { timeout: 120000 });
  await expect
    .poll(
      () =>
        page
          .locator('img:visible')
          .evaluateAll((items) =>
            items.every((item) => item instanceof HTMLImageElement && item.complete && item.naturalWidth > 0),
          ),
      { timeout: 120000 },
    )
    .toBe(true);
  await page.waitForFunction(
    (exportProgress) =>
      document.getAnimations().filter((animation) => {
        const effect = animation.effect;
        // Progress transitions restart on every encoded batch; waiting for them would capture the saved state.
        if (
          exportProgress &&
          effect instanceof KeyframeEffect &&
          effect.target instanceof Element &&
          effect.target.closest('[data-testid="animation-export-progress"]')
        )
          return false;
        return animation.playState === 'running' && effect?.getComputedTiming().iterations !== Infinity;
      }).length === 0,
    id === 'animation-export',
  );
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const visibleText = await page.locator('body').innerText();
  expect(visibleText, `Screenshot ${id} must not contain a personal path or API key`).not.toMatch(
    /[a-z]:\\Users\\|\/Users\/|\/home\/|sk-[a-z0-9_-]{8,}/i,
  );
  const raw = await page.screenshot({ scale: 'css', animations: 'disabled' });
  const scaled = await app.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64')).resize({ width: 1280, quality: 'best' });
    return { bitmap: image.toBitmap().toString('base64'), size: image.getSize() };
  }, raw.toString('base64'));
  expect(scaled.size).toEqual({ width: 1280, height: 800 });
  await mkdir(images, { recursive: true });
  const bitmap = Buffer.from(scaled.bitmap, 'base64');
  const png = guidePng(bitmap, 1280, 800);
  const decoded = await app.evaluate(
    ({ nativeImage }, png) => nativeImage.createFromBuffer(Buffer.from(png, 'base64')).toBitmap().toString('base64'),
    png.toString('base64'),
  );
  expect(Buffer.from(decoded, 'base64').equals(bitmap)).toBe(true);
  await writeFile(path.join(images, `${id}.png`), png);
  generated.add(id);
  console.log(`Screenshot ${id}: 1280×800`);
}
async function closeDialog(page: Page) {
  const dialog = page.locator('[role="dialog"]:visible').last();
  const close = dialog.getByRole('button', { name: '关闭', exact: true });
  if (await close.count()) await close.last().click();
  else await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}
async function saveTo(app: ElectronApplication, filePath: string) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, filePath);
}
async function seed(
  page: Page,
  positions: number[][] = [
    [0, -24, 0],
    [80, -24, 0],
    [0, -48, 0],
    [80, -48, 0],
    [0, -72, 0],
    [80, -72, 0],
  ],
) {
  await page.evaluate(async (positions) => {
    const api = window.brickloopEditorTest;
    api.enter([]);
    await api.seed(positions.length);
    const ids = Object.keys(api.snapshot().document.models[api.snapshot().document.rootModelId]!.instances);
    for (let i = 0; i < ids.length; i++) {
      api.select([[ids[i]!]]);
      api.command({
        type: 'transform.set',
        transform: [...positions[i]!, 1, 0, 0, 0, 1, 0, 0, 0, 1] as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ],
      });
      api.command({
        type: 'color.set',
        colorId: ['c:bright-yellow', 'c:bright-red', 'c:bright-blue'][Math.floor(i / 2) % 3]!,
      });
    }
    api.select([]);
    await api.meshesReady();
    await api.assemblyReady();
    api.preset('iso');
    api.action('view.fitAll');
  }, positions);
}

async function localModel(page: Page, endpoint: string, presetId = 'custom', model = '积木设计') {
  await page.evaluate(
    async ({ endpoint, presetId, model }) => {
      const snapshot = await window.brickloop.aiSaveProvider({
        id: crypto.randomUUID(),
        type: 'compatible',
        presetId,
        name: '本机教学模型',
        endpoint,
        model,
        models: [model],
        proxy: 'system',
        proxyUrl: '',
        prices: { input: 1, output: 2, cacheRead: 0.1 },
      });
      await window.brickloop.aiSaveSettings({ ...snapshot.settings, localOnly: true });
    },
    { endpoint, presetId, model },
  );
  await page.reload();
  await page.waitForFunction(() => !!window.brickloopEditorTest);
  await page.evaluate(() => window.brickloopEditorTest.assemblyOption('groundIsFixed', true));
}
async function house(page: Page) {
  return page.evaluate(async (parts) => {
    const api = window.brickloopEditorTest;
    const ids: Record<string, string> = {};
    api.applyOps([
      { type: 'meta.update', changes: { title: '红顶小屋' } },
      {
        type: 'model.update',
        items: [{ modelId: api.snapshot().document.rootModelId, changes: { name: '红顶小屋' } }],
      },
    ]);
    for (const p of parts) {
      api.command({
        type: 'part.add',
        partId: `ld:${p.part}`,
        colorId: p.color,
        transform: [
          p.x * 20,
          -p.y * 8,
          p.z * 20,
          ...(p.turn ? [0, 0, 1, 0, 1, 0, -1, 0, 0] : [1, 0, 0, 0, 1, 0, 0, 0, 1]),
        ] as [number, number, number, number, number, number, number, number, number, number, number, number],
      });
      ids[p.name] = api.expanded().at(-1)!.path.at(-1)!;
    }
    api.select([]);
    await api.meshesReady();
    await api.assemblyReady();
    api.preset('iso');
    api.action('view.fitAll');
    api.zoomReview(0.65);
    return ids;
  }, guideHouseParts);
}
async function aiPanel(page: Page) {
  await page.evaluate(() => window.brickloopEditorTest.action('ai.open'));
  const resize = page.locator('.panel-resize-right');
  await resize.focus();
  for (let i = 0; i < 20; i++) await resize.press('ArrowLeft');
  await page.locator('.viewport-surface').focus();
}
async function startTask(page: Page, text: string) {
  return page.evaluate(async (text) => {
    const snapshot = await window.brickloop.aiSnapshot();
    return window.brickloop.aiStart({
      providerId: snapshot.settings.providers[0]!.id,
      model: snapshot.settings.providers[0]!.model,
      text,
      images: [],
      effort: 'balanced',
      selection: true,
      modelContext: true,
    });
  }, text);
}
async function taskStatus(page: Page, id: string, status: string) {
  await expect
    .poll(() => page.evaluate((id) => window.brickloopEditorTest.tasks().find((t) => t.taskId === id)?.status, id), {
      timeout: 120000,
    })
    .toBe(status);
}
const recolor = (id: string, colorId: string) => ({ name: 'set_color', arguments: { instanceIds: [id], colorId } });
const movePart = (id: string, x: number) => ({
  name: 'move',
  arguments: { instanceIds: [id], delta: { x_ldu: x, y_ldu: 0, z_ldu: 0 } },
});
async function scrollMessages(page: Page, top: boolean) {
  await page.locator('.ai-message-list').evaluate((el, top) => {
    el.scrollTop = top ? 0 : el.scrollHeight;
  }, top);
}

test('工作区、设置、编辑、导出、宏与步骤', async () => {
  await isolated('workspace', async (app, page, directory) => {
    await capture(app, page, 'first-launch');
    await page.keyboard.press('Control+,');
    await capture(app, page, 'settings-general');
    await page.getByRole('tab', { name: '快捷键', exact: true }).click();
    await page.getByRole('button', { name: '修改“保存”快捷键', exact: true }).click();
    await page.locator('.key-recorder').press('Control+o');
    await expect(page.getByRole('dialog', { name: '快捷键冲突' })).toBeVisible();
    await capture(app, page, 'shortcut-settings');
    await page.getByRole('dialog', { name: '快捷键冲突' }).getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '快捷键冲突' })).toBeHidden();
    await closeDialog(page);
    await page.evaluate(() => window.brickloopEditorTest.about());
    await expect(page.getByRole('dialog')).toContainText(version);
    await capture(app, page, 'about-licenses');
    await closeDialog(page);
    await seed(page);
    await capture(app, page, 'workspace-overview');
    await page.evaluate(() => window.brickloopEditorTest.action('model.info'));
    await capture(app, page, 'model-information');
    await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索零件名称或编号' }).fill('3001');
    await capture(app, page, 'library-search-palette');
    await page.evaluate(() => window.brickloopEditorTest.select([window.brickloopEditorTest.expanded()[4]!.path]));
    await page.getByRole('toolbar').getByRole('button', { name: '旋转', exact: true }).click();
    await capture(app, page, 'transform-properties');
    await page.evaluate(() => window.brickloopEditorTest.select([]));
    for (const [format, id] of [
      ['io', 'studio-export'],
      ['xlsx', 'bom-export'],
      ['obj', 'mesh-export'],
      ['png', 'screenshot-export'],
    ] as const) {
      await page.evaluate((format) => window.brickloopEditorTest.showExport(format), format);
      await capture(app, page, id);
      if (format === 'io') {
        const file = path.join(directory, '彩色积木.io');
        await saveTo(app, file);
        await page.getByRole('dialog').getByRole('button', { name: '导出', exact: true }).click();
        await expect(page.getByRole('dialog')).toContainText('导出报告', { timeout: 60000 });
        await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
        await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
        await expect(page.getByRole('dialog')).toContainText('展开总件数');
        await capture(app, page, 'studio-import-report');
        await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
      } else await closeDialog(page);
    }
    await page.evaluate(() => window.brickloopEditorTest.pdf());
    await page.getByRole('combobox', { name: '每页步骤数', exact: true }).click();
    await page.locator('.ant-select-dropdown:visible').getByText('2 步', { exact: true }).click();
    await capture(app, page, 'instructions-export');
    await closeDialog(page);
    await page.evaluate(() => window.brickloopEditorTest.action('select.all'));
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
    await page.getByRole('menuitem', { name: '将所选保存为宏', exact: false }).click();
    await page.getByRole('dialog').getByRole('textbox', { name: '名称', exact: true }).fill('三色积木墙');
    await expect(page.locator('.macro-live-preview img')).toBeVisible();
    await capture(app, page, 'macro-save');
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await page.evaluate(() => window.brickloopEditorTest.select([]));
    await page.locator('#library-panel .ant-segmented').getByText('宏', { exact: true }).click();
    await expect(page.locator('[data-macro-id]')).toHaveCount(6);
    await capture(app, page, 'macro-library');
    await page.getByText('人仔表情', { exact: true }).click();
    await expect(page.locator('.macro-body [data-part-id]').first()).toBeVisible();
    await expect(page.locator('.macro-body .thumbnail-skeleton')).toHaveCount(0, { timeout: 120000 });
    const patternEvidence = await page.evaluate(async () => {
      const cards = [...document.querySelectorAll<HTMLElement>('.macro-body [data-part-id]')];
      const output = [];
      for (const card of cards) {
        const id = card.dataset.partId! as `ld:${string}`;
        const image = card.querySelector('img');
        const mesh = await window.brickloop.meshGet(id);
        let opaque = 0;
        if (image) {
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! > 0) opaque++;
        }
        output.push({
          id,
          image: !!image,
          opaque,
          failed: !!card.querySelector('svg'),
          batches: mesh.mesh.batches.length,
          indices: mesh.mesh.batches.reduce((n, b) => n + b.indices.length, 0),
          diagnostics: mesh.mesh.diagnostics,
        });
      }
      return output;
    });
    await writeFile(path.join(temporary, 'pattern-evidence.json'), JSON.stringify(patternEvidence, null, 2));
    expect(patternEvidence.length).toBeGreaterThanOrEqual(9);
    for (const card of patternEvidence) {
      expect(card.image && card.opaque > 0 && !card.failed, card.id).toBe(true);
      expect(card.indices, card.id).toBeGreaterThan(0);
      expect(card.diagnostics.missing, card.id).toEqual([]);
    }
    console.log(`Pattern cards: ${patternEvidence.length} decoded thumbnails with nonempty meshes`);
    await capture(app, page, 'pattern-macros');
    await page.locator('#library-panel .ant-segmented').getByText('零件库', { exact: true }).click();
    await page.evaluate(() => {
      const api = window.brickloopEditorTest;
      const ids = Object.keys(api.snapshot().document.models[api.snapshot().document.rootModelId]!.instances);
      for (let i = 1; i < 3; i++) {
        api.command({ type: 'step.add' });
        const model = api.snapshot().document.models[api.snapshot().document.rootModelId]!;
        api.select(ids.slice(i * 2, i * 2 + 2).map((id) => [id]));
        api.command({ type: 'step.assign', stepId: model.stepIds.at(-1)! });
      }
      api.select([]);
      api.structure();
    });
    await page.locator('.structure-view-tabs').getByText('步骤', { exact: true }).click();
    await page.getByRole('button', { name: '第 3 步操作', exact: true }).click();
    await capture(app, page, 'steps-editor');
    await page.keyboard.press('Escape');
    await page.locator('.document-title').click();
    await page.keyboard.press('Control+Shift+p');
    await page.getByRole('slider', { name: '当前步骤' }).fill('3');
    await capture(app, page, 'step-playback');
    await page.getByRole('button', { name: '退出逐步查看', exact: true }).click();
  });
});

test('子模型、连接与检查', async () => {
  await isolated('structure', async (app, page, directory) => {
    await seed(page);
    await page.evaluate(() => {
      const api = window.brickloopEditorTest;
      api.select(
        api
          .expanded()
          .slice(0, 2)
          .map((row) => row.path),
      );
      api.command({ type: 'submodel.create', name: '双色组件' });
      const doc = api.snapshot().document;
      const child = Object.values(doc.models).find((m) => m.kind === 'submodel')!;
      api.select([]);
      api.command({
        type: 'submodel.instantiate',
        modelId: child.id,
        transform: [0, 0, 120, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      });
      api.structure();
      api.action('view.fitAll');
    });
    await capture(app, page, 'structure-submodels');
    await page.evaluate(() => {
      const api = window.brickloopEditorTest,
        doc = api.snapshot().document;
      const instance = Object.values(doc.models[doc.rootModelId]!.instances).find((row) => row.ref.kind === 'model')!;
      api.enter([instance.id]);
    });
    await capture(app, page, 'shared-submodel');
    await page.evaluate(() => window.brickloopEditorTest.action('file.new'));
    await seed(page, [[10, -24, 0]]);
    await page.getByRole('textbox', { name: '搜索零件名称或编号' }).fill('3001');
    await page.getByRole('toolbar').getByRole('button', { name: '连接点', exact: true }).click();
    await page.locator('[data-part-id="ld:3001"]').click();
    const point = await page.evaluate(() => window.brickloopEditorTest.project([10, -24, 0]));
    await page.mouse.move(point.x, point.y);
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest.assembly().chosen)).toBe(true);
    await capture(app, page, 'snap-connectors', true);
    await page.keyboard.press('Escape');
    await page.getByRole('toolbar').getByRole('button', { name: '连接点', exact: true }).click();
    await seed(page, [
      [0, -24, 0],
      [10, -24, 0],
      [180, -120, 0],
    ]);
    await page.evaluate(() => window.brickloopEditorTest.assemblyOption('policy', 'warn'));
    await page.locator('.document-title').click();
    await page.keyboard.press('F7');
    await page.getByRole('checkbox', { name: '仅可见件', exact: true }).uncheck();
    await expect(page.locator('[data-issue-kind="collision"]').first()).toBeVisible();
    await capture(app, page, 'collision-three-states');
    await page.locator('[data-issue-kind="collision"]').first().click();
    await capture(app, page, 'checks-overview');
    await seed(page, [
      [0, -24, 0],
      [120, -24, 0],
    ]);
    await page.getByRole('checkbox', { name: '接触地面视为固定', exact: true }).check();
    // The demo pack allows every factory color; a real imported teaching pack supplies one restricted pairing.
    const library = await page.evaluate(async () => ({
      parts: await window.brickloop.catalogSearch('', { includeAll: false }),
      colors: (await window.brickloop.catalogColors()).factory,
      catalog: await window.brickloop.assemblyCatalog(),
    }));
    const restrictedPack = path.join(directory, '教学配色限制.brklpack');
    await writePack(restrictedPack, {
      manifest: {
        id: 'guide-color-limits',
        name: '教学配色限制',
        version: '1.0.0',
        source: '虚构教学数据',
        createdAt: '2026-10-16T00:00:00Z',
        templateVersion: 1,
        contentHash: '',
      },
      parts: library.parts
        .filter((p) => p.id !== 'ld:3004')
        .map((p) => ({
          partId: p.id,
          factoryNo: p.factoryNo ?? p.id,
          factoryName: p.nameZh,
          legoNo: p.legoNo,
          ldrawFile: p.ldrawFile,
          status: 'active' as const,
          colors: (p.id === 'ld:3001'
            ? ['c:bright-red']
            : library.catalog.parts.find((row) => row.id === p.id)!.colors) as (typeof library.colors)[number]['id'][],
        })),
      colors: library.colors.map((c) => ({
        colorId: c.id,
        factoryCode: c.factoryCode!,
        measuredRgb: c.rgb,
        definition: c,
      })),
      categories: [],
      assets: {},
    });
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, restrictedPack);
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('menuitem', { name: '数据包管理', exact: true }).click();
    await page.getByRole('button', { name: '导入数据包', exact: true }).click();
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await page
      .getByRole('dialog', { name: '切换数据包的影响' })
      .getByRole('button', { name: '继续', exact: true })
      .click();
    await expect(page.locator('[data-pack-id="guide-color-limits"]')).toContainText('已启用');
    await page.locator('.pack-manager .ant-modal-close').click();
    await expect(page.locator('.pack-manager')).toBeHidden();
    await page.evaluate(async () => {
      const api = window.brickloopEditorTest;
      const catalog = await window.brickloop.assemblyCatalog();
      const colors = (await window.brickloop.catalogColors()).all;
      const color = colors.find((color) => !catalog.colors.includes(color.id))!;
      api.select([api.expanded()[0]!.path]);
      api.command({ type: 'color.set', colorId: color.id });
      api.command({
        type: 'part.add',
        partId: 'ld:3004',
        colorId: 'c:bright-yellow',
        transform: [180, -24, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      });
      await api.meshesReady();
      await api.assemblyReady();
      api.select([]);
      api.action('view.fitAll');
    });
    const kinds = await page.evaluate(() => window.brickloopEditorTest.assembly().issues.map((issue) => issue.kind));
    expect(kinds).toEqual(expect.arrayContaining(['nonFactoryPart', 'nonFactoryColor', 'unavailableColor']));
    await capture(app, page, 'checks-factory');
  });
});

test('数据包导入、差异与管理', async () => {
  await isolated('packs', async (app, page, directory) => {
    const library = await page.evaluate(async () => ({
      parts: await window.brickloop.catalogSearch('', { includeAll: false }),
      colors: (await window.brickloop.catalogColors()).factory,
      catalog: await window.brickloop.assemblyCatalog(),
    }));
    const file = path.join(directory, '示例工厂.brklpack');
    await writePack(file, {
      manifest: {
        id: 'guide-factory',
        name: '示例工厂',
        version: '1.0.0',
        source: '虚构教学数据',
        createdAt: '2026-10-16T00:00:00Z',
        templateVersion: 1,
        contentHash: '',
      },
      parts: library.parts.slice(0, 3).map((p, i) => ({
        partId: p.id,
        factoryNo: `F00${i + 1}`,
        factoryName: p.nameZh,
        legoNo: p.legoNo,
        ldrawFile: p.ldrawFile,
        status: 'active' as const,
        colors: (i === 2
          ? ['c:guide-unknown']
          : library.catalog.parts.find((row) => row.id === p.id)!.colors) as (typeof library.colors)[number]['id'][],
      })),
      colors: library.colors.map((c) => ({
        colorId: c.id,
        factoryCode: c.factoryCode!,
        measuredRgb: c.rgb,
        definition: c,
      })),
      categories: [],
      assets: {},
    });
    await page.getByRole('button', { name: '示例包', exact: true }).click();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, file);
    await page.getByRole('button', { name: '导入数据包', exact: true }).click();
    await expect(page.getByRole('log')).toBeVisible();
    await capture(app, page, 'pack-import-review');
    await page.getByRole('button', { name: '忽略错误行导入', exact: true }).click();
    await expect(page.getByText('与当前包的差异：示例工厂')).toBeVisible();
    await capture(app, page, 'pack-import-diff');
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.locator('[data-pack-id="guide-factory"]')).toBeVisible();
    await page.locator('[data-pack-id="demo"]').getByRole('button', { name: '启用', exact: true }).click();
    await capture(app, page, 'pack-manager');
  });
});

test('AI 设置与图片同意', async () => {
  const model = await fakeModel();
  const oauth = await fakeOAuth();
  try {
    await isolated(
      'ai',
      async (app, page) => {
        await page.keyboard.press('Control+,');
        await page.getByRole('tab', { name: 'AI 助手', exact: true }).click();
        await expect(page.locator('.ai-provider-item')).toHaveCount(0);
        await expect(page.getByRole('button', { name: '用账号登录', exact: false })).toBeVisible();
        await expect(page.getByRole('button', { name: '使用 API Key', exact: false })).toBeVisible();
        await capture(app, page, 'ai-setup-methods');
        await page.getByRole('button', { name: '使用 API Key', exact: false }).click();
        const provider = page.locator('.ai-provider-modal');
        await expect(provider.locator('.ai-preset')).toHaveCount(17);
        await capture(app, page, 'ai-provider-presets');
        await provider.getByRole('searchbox').fill('DeepSeek');
        await provider.locator('.ai-preset').click();
        await expect(provider.getByLabel('API 密钥', { exact: true })).toHaveValue('');
        await expect(provider.locator('input:visible')).toHaveCount(1);
        await expect(provider.getByRole('button', { name: '去获取 API Key ↗', exact: true })).toBeVisible();
        await expect(provider.getByRole('button', { name: '测试连接', exact: true })).toBeVisible();
        await expect(provider.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
        await expect(provider.getByRole('textbox', { name: '服务地址', exact: true })).toBeHidden();
        await expect(provider.getByRole('combobox', { name: '模型', exact: true })).toBeHidden();
        await expect(provider.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
        await capture(app, page, 'ai-provider-key');
        await provider.getByRole('button', { name: '取消', exact: true }).click();
        await expect(provider).toBeHidden();
        await expect(page.locator('.ai-provider-item')).toHaveCount(0);
        expect(model.requests).toHaveLength(0);
        await page.getByRole('button', { name: '用账号登录', exact: false }).click();
        await page.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
        await expect(page.locator('.ai-provider-modal').getByRole('status')).toContainText('连接成功');
        await expect(provider.getByRole('combobox', { name: '模型', exact: true })).toBeVisible();
        await expect(provider.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
        await provider.getByRole('combobox', { name: '模型', exact: true }).scrollIntoViewIfNeeded();
        await capture(app, page, 'ai-provider-test');
        await page.locator('.ai-provider-modal').getByRole('button', { name: '保存', exact: true }).click();
        await page.getByRole('button', { name: '知道了', exact: true }).click();
        await expect(page.locator('.ai-provider-item')).toContainText('gpt-6-astra');
        await expect(page.locator('.chatgpt-signin')).toHaveCount(0);
        await capture(app, page, 'ai-providers');
        await page.getByRole('button', { name: '编辑 ChatGPT', exact: true }).click();
        await page.getByRole('combobox', { name: '模型', exact: true }).click();
        await expect(page.locator('.ant-select-dropdown:visible')).toContainText('gpt-6-astra');
        await capture(app, page, 'ai-provider-models');
        await page.keyboard.press('Escape');
        await page.locator('.ai-provider-modal').getByRole('button', { name: '取消', exact: true }).click();
        await page.getByRole('checkbox', { name: '仅使用本机模型', exact: true }).scrollIntoViewIfNeeded();
        await expect(page.locator('.ai-page-advanced')).not.toHaveAttribute('open');
        await expect(page.getByRole('spinbutton', { name: '每轮操作上限', exact: true })).toBeHidden();
        await expect(page.getByRole('spinbutton', { name: '每轮时长（分钟）', exact: true })).toBeHidden();
        await capture(app, page, 'ai-budget-privacy');
        await closeDialog(page);
        await page.evaluate(async () => {
          const snapshot = await window.brickloop.aiSnapshot();
          for (const account of snapshot.accounts) await window.brickloop.aiAccount('signout', account.id);
          for (const provider of snapshot.settings.providers) await window.brickloop.aiDeleteProvider(provider.id);
        });
        await page.evaluate(
          async ({ endpoint, id }) => {
            const snapshot = await window.brickloop.aiSaveProvider({
              id,
              type: 'compatible',
              name: '本机教学模型',
              endpoint,
              model: '积木设计',
              models: ['积木设计'],
              proxy: 'system',
              proxyUrl: '',
              prices: { input: 1, output: 2, cacheRead: 0.1 },
            });
            await window.brickloop.aiSaveSettings({ ...snapshot.settings, localOnly: true });
          },
          { endpoint: model.endpoint, id: randomUUID() },
        );
        await page.reload();
        await page.waitForFunction(() => !!window.brickloopEditorTest);
        await seed(page);
        await page.keyboard.press('Control+k');
        // The reserved .test hostname maps to this same local fake server. Refuse before any image is sent.
        const requestsBeforeConsent = model.requests.length;
        await page.evaluate(async () => {
          const snapshot = await window.brickloop.aiSnapshot();
          const provider = snapshot.settings.providers[0]!;
          await window.brickloop.aiSaveProvider({
            ...provider,
            endpoint: provider.endpoint.replace('127.0.0.1', 'guide-model.test'),
          });
          const updated = await window.brickloop.aiSnapshot();
          await window.brickloop.aiSaveSettings({ ...updated.settings, localOnly: false });
        });
        await page.getByRole('button', { name: '按参考图生成', exact: true }).click();
        await page
          .getByLabel('选择参考图', { exact: true })
          .setInputFiles(path.join(root, 'packages/ai/test/ai-eval/references/01-front.png'));
        await page.getByRole('textbox', { name: '描述', exact: true }).fill('按原创参考图搭建小房子');
        await page.getByRole('button', { name: '生成计划', exact: true }).click();
        await expect(page.locator('.ai-approval-modal')).toBeVisible();
        await capture(app, page, 'ai-image-consent');
        await page.locator('.ai-approval-modal').getByRole('button', { name: '拒绝', exact: true }).click();
        await expect.poll(() => page.evaluate(async () => (await window.brickloop.aiSnapshot()).running)).toBe(false);
        expect(model.requests.length).toBe(requestsBeforeConsent);
      },
      oauth.origin,
    );
  } finally {
    await model.close();
    await oauth.close();
  }
});

test('AI 上下文用量、新对话与失败原因', async () => {
  const model = await fakeModel();
  const fakeKey = 'sk-guide-demo-only';
  const failure = {
    status: 400,
    errorCode: 'invalid_parameter',
    errorMessage: `Demo request rejected; credential ${fakeKey}. Check request parameters.`,
  };
  try {
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(path.join(temporary, 'context-'));
    let session = await launch(directory);
    try {
      let { app, page } = session;
      await localModel(page, model.endpoint, 'deepseek', 'deepseek-flash');
      await house(page);
      await aiPanel(page);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());
      model.frames.push(
        { reasoning: 'Offline guide fixture.', text: '红顶与墙面配色清晰。' },
        { reasoning: 'Offline guide fixture.', text: '门廊位于入口正前方。' },
        failure,
      );
      const first = await startTask(page, '检查外形');
      await taskStatus(page, first, 'merged');
      const second = await startTask(page, '说明门廊');
      await taskStatus(page, second, 'merged');
      // Reopen completed records so their transient task controls do not push the
      // failed turn's exclusion label below the composer in the usage screenshot.
      const file = path.join(directory, '上下文演示.brkl');
      await saveTo(app, file);
      await page.evaluate(() => window.brickloopEditorTest.save(true));
      await page.evaluate(() => window.brickloopEditorTest.prepareClose());
      await app.close();
      session = await launch(directory);
      ({ app, page } = session);
      // localModel's setup reload leaves an empty untitled recovery entry in this
      // isolated profile. Discard only that zero-operation fixture before opening.
      const recovery = page.getByRole('dialog', { name: '恢复未保存的文档' });
      await expect(recovery).toContainText('可恢复 0 次操作');
      await recovery.getByRole('button', { name: '丢弃', exact: true }).click();
      await expect(recovery).toBeHidden();
      await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
      await aiPanel(page);
      const failed = await startTask(page, '继续检查');
      await taskStatus(page, failed, 'failed');
      await expect(page.locator(`[data-task-id="${failed}"] .ai-context-excluded`)).toHaveText('未计入上下文');
      const bar = page.getByTestId('ai-context-bar');
      await expect(bar).toContainText('/ 1M');
      await expect(bar).toContainText('% · 2 轮');
      await expect(bar.getByRole('progressbar')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(fakeKey);
      await page.locator('.ai-panel > .ant-alert .ant-alert-close-icon').click();
      await scrollMessages(page, true);
      // Centering this label would scroll the first completed reply out of view.
      await page
        .locator(`[data-task-id="${failed}"] .ai-context-excluded`)
        .evaluate((element) => element.scrollIntoView({ block: 'nearest' }));
      await expect(page.locator(`[data-task-id="${failed}"] .ai-context-excluded`)).toBeInViewport();
      await expect(page.locator(`[data-task-id="${first}"] .ai-assistant`)).toBeInViewport();
      await expect(page.locator(`[data-task-id="${second}"] .ai-assistant`)).toBeInViewport();
      await capture(app, page, 'ai-context-usage');
      await page.getByRole('button', { name: '新对话', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText('模型、审阅和撤销记录都不会改变');
      await expect(page.getByRole('dialog')).toContainText('保存工程后，重新打开仍然有效');
      await page.getByRole('dialog').locator('.ant-modal-title').click();
      await capture(app, page, 'ai-new-conversation');
      await page.getByRole('button', { name: '取消', exact: true }).click();
    } finally {
      await session.page.evaluate(() => window.brickloopEditorTest.prepareClose()).catch(() => undefined);
      await session.app.close();
      await cleanup(directory);
    }
    await isolated('failure', async (app, page) => {
      await localModel(page, model.endpoint, 'deepseek', 'deepseek-flash');
      await house(page);
      await aiPanel(page);
      model.frames.push(failure);
      const failed = await startTask(page, '检查模型并说明需要调整的地方');
      await taskStatus(page, failed, 'failed');
      const details = page.locator(`[data-task-id="${failed}"] .ai-failure`);
      await expect(details).toContainText('请求被服务商拒绝');
      await expect(details).toContainText('invalid_parameter');
      await expect(details).toContainText('HTTP 400');
      await expect(details).toContainText('服务商说明');
      await expect(page.locator('.ai-panel > .ant-alert')).toContainText('HTTP 400');
      await expect(page.locator('body')).not.toContainText(fakeKey);
      await scrollMessages(page, false);
      await capture(app, page, 'ai-failure-reason');
    });
  } finally {
    await model.close();
  }
});

test('AI DeepSeek Flash 深度下拉层', async () => {
  const model = await fakeModel();
  try {
    await isolated('effort-dropdown', async (app, page) => {
      await localModel(page, model.endpoint, 'deepseek', 'deepseek-flash');
      await setStableContentSize(app, page, 1280, 800);
      await aiPanel(page);
      await page.evaluate(() => window.brickloopEditorTest.preset('front'));
      await expect(page.locator('.ai-panel-header')).toContainText('deepseek-flash');
      await page.getByRole('combobox', { name: '深度', exact: true }).click();
      const popup = page.locator('.ai-effort-popup:visible');
      const options = popup.locator('.ant-select-item-option');
      await expect(options).toHaveCount(3);
      await expect(popup.locator('.ai-effort-option > span:first-child')).toHaveText(['快速', '均衡', '深入']);
      await expect(popup.locator('.ai-effort-description')).toHaveText([
        '关闭思考，回复最快',
        '服务商默认',
        '开启最大强度思考',
      ]);
      for (const option of await options.all()) await expect(option).toBeInViewport({ ratio: 1 });
      await expect(page.locator('body')).not.toContainText(/offline|fixture|placeholder|测试占位/i);
      await capture(app, page, 'ai-effort-dropdown');
      expect(model.requests).toHaveLength(0);
    });
  } finally {
    await model.close();
  }
});

test('AI 选中工厂件的本地检查', async () => {
  const model = await fakeModel();
  try {
    await isolated('local-check', async (app, page) => {
      await localModel(page, model.endpoint);
      await seed(page, [
        [0, -24, 0],
        [0, -48, 0],
        [0, -72, 0],
      ]);
      expect(await page.evaluate(() => window.brickloopEditorTest.aiTool('validate', {}))).toMatchObject({
        ok: true,
        data: { issues: [] },
      });
      await aiPanel(page);
      await page.evaluate(() => {
        const api = window.brickloopEditorTest;
        api.select(
          api
            .expanded()
            .slice(1)
            .map((part) => part.path),
        );
        api.action('view.fitAll');
        api.zoomReview(0.65);
      });
      await page.getByRole('button', { name: '换成工厂件', exact: true }).click();
      await page.getByRole('button', { name: '发送', exact: true }).click();
      const turn = page.locator('.ai-turn');
      await expect(turn).toContainText('检查范围：选中 2 件（含子结构）');
      await expect(turn).toContainText('非工厂件：0');
      await expect(turn).toContainText('本地检查，未调用模型');
      await expect(turn.getByRole('button', { name: '让 AI 再检查一次', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(page.locator('body')).not.toContainText(/offline|fixture|placeholder|测试占位/i);
      await capture(app, page, 'ai-local-check');
      expect(model.requests).toHaveLength(0);
    });
  } finally {
    await model.close();
  }
});

test('AI 模型思考中的活动状态', async () => {
  const model = await fakeModel();
  const reasoning = '先检查屋顶、墙体和门廊的比例，再整理需要调整的连接位置。';
  try {
    await isolated('liveness', async (app, page) => {
      await localModel(page, model.endpoint, 'deepseek', 'deepseek-flash');
      await house(page);
      await aiPanel(page);
      model.frames.push({
        reasoningChunks: Array.from({ length: 60 }, () => reasoning.repeat(8)),
        text: '红顶与墙体比例清晰，门廊位于入口前方，建议继续检查烟囱连接。',
      });
      const taskId = await startTask(page, '检查小屋的外形比例，说明哪些连接需要进一步检查');
      const line = page.locator(`[data-task-id="${taskId}"] .ai-liveness`);
      await expect(line).toContainText('模型正在思考');
      const first = (await line.innerText()).match(/已生成约 (\S+) 字/)?.[1];
      expect(first).toBeDefined();
      await expect.poll(async () => (await line.innerText()).match(/已生成约 (\S+) 字/)?.[1]).not.toBe(first);
      await expect(line).toHaveText(/模型正在思考 · 已生成约 \S+ 字 · \d+ 秒前有数据/);
      await expect(line).toBeInViewport({ ratio: 1 });
      await expect(page.locator('body')).not.toContainText(reasoning);
      await expect(page.locator('body')).not.toContainText(/offline|fixture|placeholder|测试占位/i);
      await capture(app, page, 'ai-liveness');
      await expect(line).toContainText('模型正在思考');
      await taskStatus(page, taskId, 'merged');
      await expect(line).toHaveCount(0);
    });
  } finally {
    await model.close();
  }
});

test('看图计划的颜色与包围盒调整明细', async () => {
  const server = await imageModelServer();
  const plan = structuredClone(guideHousePlan);
  plan.components[0]!.colors = ['bright-green', 'c:bright-blue'];
  plan.components[0]!.boundingBox!.max = { x: 9, y: 9, z: 9 };
  server.controls.planOverride = plan;
  try {
    await isolated('plan-repairs', async (app, page) => {
      await localModel(page, server.endpoint);
      await aiPanel(page);
      await page.getByRole('button', { name: '按参考图生成', exact: true }).click();
      await page
        .getByRole('textbox', { name: '描述', exact: true })
        .fill('红顶小屋：绿色墙体、蓝色门廊和烟囱，先确认各部件的尺寸和颜色');
      const reference = await readFile(path.join(root, 'packages/ai/test/ai-eval/references/01-front.png'));
      await page
        .getByLabel('选择参考图', { exact: true })
        .setInputFiles({ name: '小屋正面.png', mimeType: 'image/png', buffer: reference });
      await page.getByRole('button', { name: '生成计划', exact: true }).click();
      const modal = page.locator('.image-plan-modal');
      const repairs = modal.locator('.plan-color-repairs');
      await expect(repairs.locator('summary')).toHaveText('已调整 2 处（颜色 1 处、包围盒 1 处）');
      await repairs.locator('summary').click();
      await expect(repairs).toHaveAttribute('open');
      await expect(repairs.locator('li')).toHaveCount(2);
      await expect(repairs.locator('li').first()).toContainText('bright-green');
      await expect(repairs.locator('li').last()).toHaveText(
        '第 1 个部件“墙体与门廊”：包围盒终点由 (9, 9, 9) 改为 (5, 7.2, 3)，按宽、深、高重算。',
      );
      for (const item of await repairs.locator('li').all()) await expect(item).toBeInViewport({ ratio: 1 });
      await expect(modal.getByRole('button', { name: '开始搭建', exact: true })).toBeEnabled();
      await expect(page.locator('body')).not.toContainText(/offline|fixture|placeholder|测试占位/i);
      await capture(app, page, 'image-plan-repairs');
      await closeDialog(page);
    });
  } finally {
    await server.close();
  }
});

test('AI 并行任务、预览与冲突', async () => {
  const model = await fakeModel();
  try {
    await isolated('parallel', async (app, page) => {
      await localModel(page, model.endpoint);
      const ids = await house(page);
      await aiPanel(page);
      model.route('调整门廊', [
        { calls: [movePart(ids['门廊']!, 80)] },
        { text: '门廊已移到入口右侧，正在核对位置。', gate: 'porch' },
      ]);
      model.route('调整烟囱', [
        { calls: [recolor(ids['烟囱']!, 'c:bright-yellow')] },
        { text: '烟囱已改成黄色，正在核对配色。', gate: 'chimney' },
      ]);
      const porch = await startTask(page, '调整门廊：移到入口右侧');
      const chimney = await startTask(page, '调整烟囱：与黄色墙体呼应');
      await expect.poll(() => model.waiting('porch') && model.waiting('chimney')).toBe(true);
      await page.evaluate((id) => {
        const api = window.brickloopEditorTest;
        api.select([[id]]);
        api.command({ type: 'color.set', colorId: 'c:bright-red' });
      }, ids['门廊']!);
      await page.locator(`[data-task-id="${porch}"]`).getByRole('button', { name: '预览', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.previewCounts().parts)).toBe(1);
      await scrollMessages(page, true);
      await expect(page.locator('.task-running')).toHaveCount(2);
      await capture(app, page, 'ai-parallel-tasks');
      model.release('porch');
      model.release('chimney');
      await taskStatus(page, porch, 'pending_merge');
      await taskStatus(page, chimney, 'pending_merge');
      await page.evaluate(() => window.brickloopEditorTest.select([]));
      await scrollMessages(page, true);
      await page.locator(`[data-task-id="${porch}"]`).getByRole('button', { name: '合并', exact: true }).click();
      await expect(page.locator('[data-review-group="conflicts"]')).toBeVisible();
      await scrollMessages(page, false);
      await capture(app, page, 'ai-merge-conflicts');
      await page.evaluate((id) => window.brickloopEditorTest.taskDiscard(id), chimney);
    });
  } finally {
    await model.close();
  }
});

test('选中提问、引用与状态', async () => {
  const model = await fakeModel();
  try {
    await isolated('ask', async (app, page) => {
      await localModel(page, model.endpoint);
      const ids = await house(page);
      await page.evaluate((ids) => {
        const api = window.brickloopEditorTest;
        api.structure();
        api.select([[ids['前檐-2']!], [ids['前檐2']!]]);
      }, ids);
      await expect(page.getByTestId('selection-ask-button')).toBeVisible();
      await capture(app, page, 'ai-ask-button');
      await page.getByTestId('selection-ask-button').click();
      const input = page.getByRole('textbox', { name: '让 AI 修改选中部分', exact: true });
      await input.fill('把 @');
      await expect(page.getByRole('listbox', { name: '引用候选' })).toBeVisible();
      await capture(app, page, 'ai-ask-mentions');
      await input.press('Escape');
      await input.fill('把选中的两块前檐改为蓝色');
      model.frames.push(
        { gate: 'ask', calls: [recolor(ids['前檐-2']!, 'c:bright-blue'), recolor(ids['前檐2']!, 'c:bright-blue')] },
        { text: '两块前檐已改为蓝色，墙体和屋顶保持原样。' },
      );
      await input.press('Enter');
      await expect.poll(() => model.waiting('ask')).toBe(true);
      await expect(page.getByTestId('selection-ask-status')).toBeVisible();
      await expect(page.locator('.ai-unread')).toBeVisible();
      await capture(app, page, 'ai-ask-status');
      model.release('ask');
      await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.tasks().at(-1)?.status)).toBe('merged');
      await page.evaluate(() => window.brickloopEditorTest.select([]));
      await aiPanel(page);
      await scrollMessages(page, true);
      await expect(page.locator('.ai-user').first()).toContainText('选中 2 件');
      await capture(app, page, 'ai-ask-selection');
    });
  } finally {
    await model.close();
  }
});

test('三维审阅标注、分组与改前', async () => {
  const model = await fakeModel();
  try {
    await isolated('review', async (app, page) => {
      await localModel(page, model.endpoint);
      const ids = await house(page);
      await aiPanel(page);
      model.frames.push(
        { calls: [{ name: 'get_part_info', arguments: { partId: 'ld:3004' } }] },
        {
          calls: [
            { name: 'delete', arguments: { instanceIds: [ids['烟囱']] } },
            recolor(ids['前檐-2']!, 'c:bright-blue'),
            movePart(ids['门廊']!, 80),
            {
              name: 'place_part',
              arguments: {
                partId: 'ld:3004',
                colorId: 'c:bright-yellow',
                pose: { kind: 'ldu', x_ldu: -40, y_ldu: -160, z_ldu: -10 },
              },
            },
          ],
        },
        { text: '已移除蓝色烟囱，在屋脊左侧加了一块黄色砖；左侧前檐改为蓝色，门廊移到右侧。请逐项审阅。' },
      );
      const id = await startTask(page, '整理屋顶，并调整前檐和门廊');
      await taskStatus(page, id, 'merged');
      const surface = page.locator('.brickloop-viewport');
      await expect(surface).toHaveAttribute('data-review-added', '1');
      await expect(surface).toHaveAttribute('data-review-moved', '1');
      await expect(surface).toHaveAttribute('data-review-ghosts', '2');
      await page.evaluate(() => window.brickloopEditorTest.assemblyReady());
      expect(
        await page.evaluate(() =>
          window.brickloopEditorTest.assembly().issues.filter((issue) => issue.kind === 'collision'),
        ),
      ).toEqual([]);
      await scrollMessages(page, false);
      await capture(app, page, 'ai-review-bar');
      await page.locator('[data-review-group="recolored"]').getByRole('button', { name: '拒绝', exact: true }).click();
      await expect(page.locator('[data-review-state="rejected"]')).toHaveCount(1);
      await capture(app, page, 'ai-review-list');
      await page.getByTestId('review-bar').getByText('改前', { exact: true }).click();
      await expect(page.getByText('正在查看改前状态')).toBeVisible();
      await expect(page.getByRole('toolbar').getByRole('button').first()).toBeDisabled();
      await expect(page.getByRole('textbox', { name: '给 AI 助手的消息' })).toBeDisabled();
      await capture(app, page, 'ai-review-before');
    });
  } finally {
    await model.close();
  }
});

test('看图搭建与马赛克', async () => {
  const server = await imageModelServer();
  server.controls.guideHouse = true;
  try {
    await isolated('images', async (app, page) => {
      await localModel(page, server.endpoint);
      await page.keyboard.press('Control+k');
      await page.getByRole('button', { name: '按参考图生成', exact: true }).click();
      await page
        .getByRole('textbox', { name: '描述', exact: true })
        .fill('红顶小屋：黄色墙体、蓝色门廊和烟囱，先搭主体再完善屋顶');
      const reference = await readFile(path.join(root, 'packages/ai/test/ai-eval/references/01-front.png'));
      await page.getByLabel('选择参考图', { exact: true }).setInputFiles([
        { name: '小屋正面.png', mimeType: 'image/png', buffer: reference },
        { name: '屋顶细节.png', mimeType: 'image/png', buffer: reference },
      ]);
      await page.getByRole('combobox', { name: '第 2 张图片视角' }).selectOption({ label: '不参与对比' });
      await expect(page.locator('.image-input-modal .ai-page-advanced')).not.toHaveAttribute('open');
      await expect(page.getByRole('spinbutton', { name: '迭代轮数', exact: true })).toBeHidden();
      await expect(page.locator('.image-input-modal')).toContainText('全部零件（概念设计）');
      const advanced = page.locator('.image-input-modal summary').filter({ hasText: '高级' });
      await advanced.scrollIntoViewIfNeeded();
      await expect(advanced).toBeInViewport({ ratio: 0.99 });
      await expect(page.locator('.image-input-modal .reference-grid img').first()).toBeInViewport({ ratio: 0.99 });
      await capture(app, page, 'image-model-input');
      await page.locator('.image-input-modal summary').filter({ hasText: '高级' }).click();
      await expect(page.getByRole('spinbutton', { name: '迭代轮数', exact: true })).toHaveValue('20');
      await page.getByRole('spinbutton', { name: '迭代轮数', exact: true }).fill('4');
      await page.getByRole('button', { name: '生成计划', exact: true }).click();
      const plan = page.locator('.image-plan-modal');
      await expect(plan.getByRole('button', { name: '开始搭建', exact: true })).toBeVisible({ timeout: 45000 });
      await expect(plan.getByText('推测：前视图 · 0.90', { exact: true })).toBeVisible();
      await capture(app, page, 'image-plan-review');
      server.controls.delay = 1200;
      await plan.getByRole('button', { name: '开始搭建', exact: true }).click();
      await expect(page.locator('.image-task-card .image-round-timeline li')).toHaveCount(1, { timeout: 120000 });
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible();
      const taskId = await page.evaluate(() => window.brickloopEditorTest.tasks().at(-1)!.taskId);
      // A small doorstep is the designer's concurrent edit; it leaves the generated house pending merge.
      await page.evaluate(() => {
        const api = window.brickloopEditorTest;
        api.command({
          type: 'part.add',
          partId: 'ld:3020',
          colorId: 'c:bright-blue',
          transform: [0, -8, -120, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        });
        api.select([]);
        api.restoreCamera({
          mode: 'perspective',
          fov: 45,
          position: [480, -520, -620],
          target: [0, -130, 0],
          up: [0, -1, 0],
        });
      });
      await page.getByRole('textbox', { name: '插话', exact: true }).fill('保留蓝色门廊，烟囱不要再加高');
      await capture(app, page, 'image-task-running');
      await page.getByRole('textbox', { name: '插话', exact: true }).press('Enter');
      server.controls.delay = 0;
      await page.getByRole('button', { name: '继续', exact: true }).click();
      await taskStatus(page, taskId, 'pending_merge');
      const result = await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)?.report);
      expect(result?.reason).toBe('completed');
      expect(result?.unfinished).toEqual([]);
      expect(result?.validation.issues).toEqual([]);
      const iterations = result!.rounds.map((r) => ({
        round: r.round,
        phase: r.phase,
        parts: r.partCount,
        iou: r.comparisons[0]!.iou,
        issues: r.issues.map((issue) => issue.kind),
      }));
      expect(iterations.map((r) => r.phase)).toEqual(['drafting', 'iterating', 'detailing', 'buildability']);
      expect(new Set(iterations.map((r) => r.parts)).size).toBe(4);
      expect(iterations[0]!.issues).toContain('collision');
      expect(iterations[2]!.issues).toContain('floating');
      expect(iterations[3]!.issues).toEqual([]);
      expect(iterations[3]!.iou).toBeGreaterThanOrEqual(0.6);
      expect(iterations[3]!.iou - iterations[0]!.iou).toBeGreaterThan(0.15);
      await writeFile(
        path.join(temporary, 'iteration-metrics.json'),
        JSON.stringify(
          {
            source: 'packages/ai/test/ai-eval/references/01-front.png',
            sourceSha256: createHash('sha256').update(reference).digest('hex'),
            preparation: 'Original file used directly without any processing.',
            reason: result!.reason,
            iterations,
          },
          null,
          2,
        ),
      );
      console.log('House iterations:', JSON.stringify(iterations));
      await aiPanel(page);
      await scrollMessages(page, true);
      await capture(app, page, 'image-task-pending');
      await page.locator(`[data-task-id="${taskId}"]`).getByRole('button', { name: '合并', exact: true }).click();
      await taskStatus(page, taskId, 'merged');
      await expect(page.getByTestId('review-bar')).toBeVisible();
      await page.evaluate(() => {
        const api = window.brickloopEditorTest;
        api.action('view.fitAll');
        api.zoomReview(0.65);
      });
      await scrollMessages(page, false);
      await capture(app, page, 'image-task-merge');
      const report = page.locator('.image-report');
      await expect(report.locator('.image-round-timeline li')).toHaveCount(4);
      const roundDetails = report.locator('.image-round-timeline details');
      const showRounds = async (first: number) => {
        for (let index = 0; index < 4; index++) {
          const details = roundDetails.nth(index);
          const open = index === first || index === first + 1;
          if ((await details.evaluate((el) => (el as HTMLDetailsElement).open)) !== open)
            await details.locator('summary').click();
          await expect(details).toHaveJSProperty('open', open);
        }
      };
      await showRounds(0);
      await report.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await report.locator('.image-script-source').evaluate((el) => el.scrollIntoView({ block: 'end' }));
      await report.locator('.image-round-timeline').evaluate((el) => {
        const second = el.children[1]!;
        el.scrollTop += second.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom + 8;
      });
      await capture(app, page, 'image-round-timeline');
      await showRounds(2);
      await report.locator('.image-round-timeline').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await report.locator('.image-script-source').evaluate((el) => el.scrollIntoView({ block: 'end' }));
      await capture(app, page, 'image-round-script');
      await report.locator('.image-validation').evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await expect(page.locator('.image-reference-report')).toContainText('AI 推测');
      await expect(page.locator('.image-reference-report')).toContainText('未参与对比');
      await capture(app, page, 'image-task-report');
      await report.getByRole('button', { name: '导出 .io…', exact: true }).scrollIntoViewIfNeeded();
      await capture(app, page, 'image-report-export');
      await page.evaluate(() => window.brickloopEditorTest.reviewEnd());
      await page.getByRole('menuitem', { name: '工具', exact: true }).click();
      await page.getByRole('menuitem', { name: '马赛克…', exact: true }).click();
      await page
        .getByLabel('选择图片', { exact: true })
        .setInputFiles(path.join(root, 'packages/ai/test/ai-eval/references/01-front.png'));
      await expect(page.getByLabel('像素网格预览', { exact: true })).toBeVisible({ timeout: 45000 });
      await page.getByRole('combobox', { name: '零件样式', exact: true }).click();
      await page.locator('.ant-select-dropdown:visible').getByText('平滑板', { exact: true }).click();
      await capture(app, page, 'mosaic-preview');
    });
  } finally {
    await server.close();
  }
});
async function stableAnimation(page: Page) {
  await expect(page.locator('.animation-session')).toHaveAttribute('data-ready', 'true', { timeout: 60000 });
  await page.waitForFunction(() => {
    const dialogs = document.querySelectorAll('.ant-modal');
    return (
      dialogs.length > 0 &&
      [...dialogs].every((dialog) => {
        if (dialog.querySelector('[class*="ant-zoom-"]')) return false;
        for (let el: Element | null = dialog; el && el !== document.body; el = el.parentElement) {
          if (el.className.includes('ant-zoom-') || getComputedStyle(el).opacity !== '1') return false;
        }
        return getComputedStyle(dialog).transform === 'none';
      })
    );
  });
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(16, 16);
  await expect(page.locator('.ant-tooltip:visible')).toHaveCount(0);
  expect(await page.locator('.animation-stage').evaluate((stage) => stage.matches(':focus-visible'))).toBe(false);
}

test('搭建动画：村舍按层、说明书步骤与导出进度', async () => {
  await isolated('animation', async (app, page, directory) => {
    const result = await page.evaluate(async (code) => {
      const api = window.brickloopEditorTest;
      api.applyOps([{ type: 'meta.update', changes: { title: '庭院村舍' } }]);
      await api.mcpTool('beginTransaction', '使用说明动画场景');
      const result = await api.mcpTool('run_build_script', { scriptId: 'guide-cottage', code });
      await api.mcpTool('commitTransaction', {});
      api.select([]);
      await api.meshesReady();
      await api.assemblyReady();
      api.action('view.fitAll');
      return result;
    }, animationCottage);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(2000);
    expect(
      await page.evaluate(
        () => window.brickloopEditorTest.expanded().filter((p) => p.colorId === 'c:bright-red').length,
      ),
    ).toBeGreaterThan(300);
    await page.getByRole('menuitem', { name: '视图', exact: true }).click();
    await page.getByRole('menuitem', { name: '搭建动画…', exact: true }).click();
    await stableAnimation(page);
    const cottage = await page.evaluate(() => window.brickloopEditorTest.animation.seekMoving(0.3));
    expect(cottage.time / cottage.duration).toBeGreaterThan(0.28);
    expect(cottage.time / cottage.duration).toBeLessThan(0.32);
    expect(cottage.translucent).toBeGreaterThan(0);
    expect(cottage.settled).toBeGreaterThan(0);
    await expect(page.getByTestId('animation-group')).toContainText('层');
    await expect(page.locator('.animation-caption small')).toContainText('2000');
    await capture(app, page, 'animation-player');
    await page.getByRole('button', { name: '导出视频…', exact: true }).click();
    await stableAnimation(page);
    const options = page.locator('.animation-export-options');
    await expect(options).toContainText('1080p');
    await expect(options).toContainText('30 帧 / 秒');
    await expect(options).toContainText('MP4 · H.264');
    const exported = path.join(directory, '庭院村舍-搭建动画.mp4');
    await saveTo(app, exported);
    await page.getByRole('button', { name: '导出视频', exact: true }).click();
    const progress = page.getByTestId('animation-export-progress');
    await expect(progress).toBeVisible();
    await expect
      .poll(async () => Number(await progress.getByRole('progressbar').getAttribute('aria-valuenow')), {
        timeout: 120000,
      })
      .toBeGreaterThanOrEqual(15);
    await expect(progress).toContainText(/\d+ \/ \d+ 帧/);
    await expect(progress).toContainText('预计剩余');
    // Production UI replaces the settings with progress; retain that real state in the guide.
    await capture(app, page, 'animation-export');
    await expect(progress).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByText('已取消导出', { exact: true })).toBeVisible({ timeout: 30000 });
    expect((await readdir(directory)).filter((file) => file.startsWith(path.basename(exported)))).toEqual([]);
    const exportDialog = page.getByRole('dialog', { name: '导出搭建视频', exact: true });
    await exportDialog.getByRole('button', { name: '关闭', exact: true }).last().click();
    await expect(exportDialog).toBeHidden();
    await page.evaluate(() => window.brickloopEditorTest.animation.close());
    await page.evaluate(() => window.brickloopEditorTest.action('file.new'));
    await house(page);
    await page.evaluate(() => {
      const api = window.brickloopEditorTest;
      const doc = api.snapshot().document;
      const rows = Object.values(doc.models[doc.rootModelId]!.instances);
      const limits = [3, 7, 10, 11, 14, 20];
      limits.forEach((limit, index) => {
        if (index) api.command({ type: 'step.add' });
        const model = api.snapshot().document.models[doc.rootModelId]!;
        api.select(
          rows
            .filter(
              (row) => -row.transform[1]! / 8 <= limit && (index === 0 || -row.transform[1]! / 8 > limits[index - 1]!),
            )
            .map((row) => [row.id]),
        );
        api.command({ type: 'step.assign', stepId: model.stepIds.at(-1)! });
      });
      api.select([]);
    });
    await page.getByRole('menuitem', { name: '视图', exact: true }).click();
    await page.getByRole('menuitem', { name: '搭建动画…', exact: true }).click();
    await stableAnimation(page);
    await page.getByRole('combobox', { name: '拼装顺序', exact: true }).click();
    await page.locator('.ant-select-item-option-content').getByText('按说明书步骤', { exact: true }).click();
    await stableAnimation(page);
    const steps = await page.evaluate(() => window.brickloopEditorTest.animation.seekMoving(0.43, 'steps'));
    expect(steps.groups).toBe(6);
    expect(steps.coarseSteps).toBe(false);
    expect(steps.translucent).toBeGreaterThan(0);
    expect(steps.settled).toBeGreaterThan(0);
    await expect(page.getByTestId('animation-group')).toContainText(/第 [2-5] \/ 6 步/);
    await expect(page.getByText('该模型的步骤较粗', { exact: false })).toHaveCount(0);
    await capture(app, page, 'animation-steps');
    await writeFile(path.join(temporary, 'animation-scenes.json'), JSON.stringify({ cottage, steps }, null, 2));
    await page.evaluate(() => window.brickloopEditorTest.animation.close());
  });
});

test('发布版 MCP 配置与本机假客户端审批', async () => {
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, 'mcp-'));
  const pipe = `\\\\.\\pipe\\brickloop-mcp-guide-${randomUUID()}`;
  const { app, page } = await launch(directory, [], true, pipe);
  const client = new Client({ name: '教学客户端', version });
  try {
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe(version);
    await page.keyboard.press('Control+,');
    await page.getByRole('tab', { name: '外部智能体', exact: true }).click();
    await page.getByRole('checkbox', { name: '允许外部智能体连接', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '允许外部智能体连接', exact: true })).toBeChecked();
    await page.getByRole('tab', { name: 'Claude Code', exact: true }).click();
    const config = (
      JSON.parse((await page.locator('.ai-config:visible').textContent())!) as {
        mcpServers: { brickloop: { command: string; args: string[]; env: Record<string, string> } };
      }
    ).mcpServers.brickloop;
    await page.getByRole('tab', { name: 'Codex', exact: true }).click();
    await capture(app, page, 'mcp-settings');
    await closeDialog(page);
    await client.connect(
      new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...environment(), ...config.env, BRICKLOOP_MCP_PIPE: pipe },
        stderr: 'pipe',
      }),
    );
    const pending = client.callTool({ name: 'get_model_summary', arguments: {} });
    await expect(page.getByText('允许“教学客户端”连接？', { exact: true })).toBeVisible();
    await capture(app, page, 'mcp-approval');
    await page.getByRole('button', { name: '允许', exact: true }).click();
    expect((await pending).isError).not.toBe(true);
  } finally {
    await client.close();
    await app.close();
    await cleanup(directory);
  }
});

test('恢复对话框', async () => {
  await mkdir(temporary, { recursive: true });
  const directory = await teachingDirectory('恢复演示');
  const session = new DocumentSession(createDocument({ title: '未保存的三色积木墙' }));
  session.dispatch({
    type: 'part.add',
    partId: 'ld:3001',
    colorId: 'c:bright-red',
    transform: toLDraw(translation([0, -24, 0])),
  });
  const file = path.join(directory, '教学工程.brkl');
  await writeFile(file, packProject(session.document, createWorkspace(), {}));
  let running = await launch(directory, [file]);
  try {
    await running.page.evaluate(async () => {
      await window.brickloopEditorTest.seed(6);
      await window.brickloopEditorTest.flush();
    });
    const child = running.app.process();
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    await exited;
    running = await launch(directory);
    await expect(running.page.getByRole('dialog')).toContainText('恢复未保存的文档');
    await capture(running.app, running.page, 'recovery-dialog');
    await running.page.getByRole('button', { name: '恢复', exact: true }).click();
    // Recovery replaces the session asynchronously; wait before marking it saved for test cleanup.
    await expect(running.page.getByText('恢复未保存的文档', { exact: true })).toBeHidden();
    await expect(running.page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', '6');
  } finally {
    await running.page.evaluate(() => window.brickloopEditorTest.prepareClose()).catch(() => undefined);
    await running.app.close();
    await cleanup(directory);
  }
});

test.afterAll(async () => {
  const files = (await readdir(images)).filter((name) => name.endsWith('.png'));
  const chapters = (await readdir(path.dirname(images))).filter((name) => /^(?:\d\d-|附录).+\.md$/.test(name));
  const references = new Set<string>();
  for (const chapter of chapters) {
    const text = await readFile(path.join(path.dirname(images), chapter), 'utf8');
    expect(text).not.toContain('截图待更新');
    for (const match of text.matchAll(/!\[[^\]]*\]\(images\/([^)]+)\)/g)) references.add(match[1]!);
  }
  expect(
    files.filter((name) => !references.has(name)),
    'unreferenced PNG files',
  ).toEqual([]);
  expect(
    [...references].filter((name) => !files.includes(name)),
    'missing PNG files',
  ).toEqual([]);
  const bytes = (await Promise.all(files.map(async (name) => (await stat(path.join(images, name))).size))).reduce(
    (a, b) => a + b,
    0,
  );
  console.log(
    `User guide: ${generated.size} generated this run; ${files.length} PNG files, ${bytes} bytes (${(bytes / 1024 / 1024).toFixed(2)} MiB)`,
  );
  const inventory = await Promise.all(
    files.sort().map(async (name) => {
      const png = await readFile(path.join(images, name));
      const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
      expect(size).toEqual([1280, 800]);
      return {
        name,
        bytes: png.length,
        size,
        sha256: createHash('sha256').update(png).digest('hex'),
        generated: generated.has(name.slice(0, -4)),
      };
    }),
  );
  await writeFile(
    path.join(temporary, 'inventory.json'),
    JSON.stringify({ version, bytes, count: files.length, missing: [], unreferenced: [], files: inventory }, null, 2),
  );
  console.log(`References: ${files.length} PNG files, ${references.size} referenced files, 0 missing, 0 unreferenced`);
  expect(bytes).toBeLessThan(24_000_000);
  expect(files).toHaveLength(68);
  // Private checkouts also verify image IDs against the checklist, including filtered runs.
  const checklist = await readFile(path.join(root, 'docs/user-guide/screenshots.md'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (checklist === undefined) {
    console.log('Skipping screenshot checklist ID check: docs/user-guide/screenshots.md is absent from this checkout.');
  } else {
    for (const id of generated) expect(checklist).toContain(`\`${id}\``);
    console.log(`Checklist: ${generated.size} generated image IDs verified in docs/user-guide/screenshots.md`);
  }
});
