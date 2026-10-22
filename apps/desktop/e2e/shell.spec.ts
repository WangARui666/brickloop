import { RELEASE_CHANNELS } from '../src/shared/release-api';
import { ANIMATION_CHANNELS } from '../src/shared/animation-api';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import type { ElectronApplication, Page } from '@playwright/test';
import type { DesktopApi } from '../src/shared/api';
import { LIBRARY_CHANNELS } from '../src/shared/library-api';
import { MACRO_CHANNELS } from '../src/shared/macro-api';
import { PROJECT_CHANNELS } from '../src/shared/project-api';
import { ASSEMBLY_CHANNELS } from '../src/shared/assembly-api';

const desktopRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { version } = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8')) as { version: string };
const dataRoot = path.resolve(desktopRoot, '../../.devdata/e2e');
const screenshots = path.join(desktopRoot, '../../.devdata/e2e-results/screenshots');
let directory: string;
let application: ElectronApplication | undefined;
let page: Page | undefined;

async function launch() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  // A parent Node-mode launch must not accidentally start this Electron instance as Node.
  delete env.ELECTRON_RUN_AS_NODE;
  application = await launchElectron({
    args: [desktopRoot],
    env: { ...env, BRICKLOOP_DATA_DIR: directory },
    timeout: 20_000,
  });
  page = await application.firstWindow();

  await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-render-count', /[1-9]/, { timeout: 20000 });
  await expect(page.getByRole('combobox', { name: /选择模式|Selection mode/, exact: true })).toBeEnabled();
  await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', { timeout: 30000 });
  return page;
}

async function close() {
  await application?.close();
  application = undefined;
  page = undefined;
}

async function chooseLanguage(window: Page, from: 'zh-CN' | 'en', to: 'zh-CN' | 'en') {
  await window.getByRole('menuitem', { name: from === 'zh-CN' ? '帮助' : 'Help', exact: true }).click();
  await window.getByRole('menuitem', { name: from === 'zh-CN' ? '语言' : 'Language', exact: true }).click();
  await window.getByRole('menuitem', { name: to === 'zh-CN' ? '简体中文' : 'English', exact: true }).click();
  await expect(window.getByRole('menuitem', { name: to === 'zh-CN' ? '文件' : 'File', exact: true })).toBeVisible();
  await expect(window.getByRole('menuitem', { name: to === 'zh-CN' ? '编辑' : 'Edit', exact: true })).toBeVisible();
  await window.getByTestId('viewport-host').click();
  await expect(window.getByRole('menuitem', { name: to === 'zh-CN' ? '语言' : 'Language', exact: true })).toBeHidden();
}

test.beforeEach(async () => {
  if (path.resolve(process.env.BRICKLOOP_DATA_DIR ?? '') !== dataRoot) throw new Error('Run e2e through pnpm e2e');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(screenshots, { recursive: true });
  directory = await mkdtemp(path.join(dataRoot, 'case-'));
});

// Electron tests manage their own page; requesting the browser fixture would launch Chromium.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  try {
    if (page && !page.isClosed())
      await page.screenshot({ path: path.join(screenshots, `${testInfo.title.slice(0, 5)}-final.png`) });
  } finally {
    await close();
    if (directory && path.dirname(directory) === dataRoot) await rm(directory, { recursive: true, force: true });
  }
});

test('UI-01 首次启动为简体中文，外壳布局与进程安全配置正确', async () => {
  const window = await launch();
  await expect(window).toHaveTitle(/积环/);
  await expect(window.getByRole('menuitem', { name: '文件', exact: true })).toBeVisible();
  await expect(window.getByRole('menuitem', { name: '编辑', exact: true })).toBeVisible();
  await expect(window.locator('.status-bar')).toContainText('零件数 0');
  await expect(window.locator('.status-bar')).toContainText('网格 1 格');
  await expect(window.getByTestId('viewport-host')).toBeVisible();
  await expect(window.getByText('222 个零件', { exact: true })).toBeVisible();
  await window.screenshot({ path: path.join(screenshots, 'ui-01-zh-CN.png') });

  const info = await window.evaluate(() => (globalThis as unknown as { brickloop: DesktopApi }).brickloop.getAppInfo());
  expect(info).toEqual({ name: 'Brickloop（积环）', version, dataDirectory: path.join(directory, 'config') });
  expect(
    await window.evaluate(() => Object.keys((globalThis as unknown as { brickloop: DesktopApi }).brickloop).sort()),
  ).toEqual(
    [
      'getAppInfo',
      'reloadRenderer',
      'getSettings',
      'setLanguage',
      'onCloseRequested',
      'onRecoveryError',
      'onOpenFiles',
      ...Object.keys(RELEASE_CHANNELS),
      ...Object.keys(ANIMATION_CHANNELS),
      'droppedFilePath',
      'onAiNotice',
      'onEditorRequest',
      ...Object.keys(AI_CHANNELS),
      ...Object.keys(LIBRARY_CHANNELS),
      ...Object.keys(PROJECT_CHANNELS),
      ...Object.keys(ASSEMBLY_CHANNELS),
      ...Object.keys(MACRO_CHANNELS),
    ].sort(),
  );
  expect(await window.evaluate(() => ({ node: 'process' in globalThis, require: 'require' in globalThis }))).toEqual({
    node: false,
    require: false,
  });
  const preferences = await application!.evaluate(({ BrowserWindow }) => {
    const browserWindow = BrowserWindow.getAllWindows()[0]!;
    // Electron's diagnostic method is not in its public declarations; used only by this test.
    const contents = browserWindow.webContents as typeof browserWindow.webContents & {
      getLastWebPreferences(): { contextIsolation: boolean; sandbox: boolean; nodeIntegration: boolean };
    };
    const { contextIsolation, sandbox, nodeIntegration } = contents.getLastWebPreferences();
    return {
      contextIsolation,
      sandbox,
      nodeIntegration,
      size: browserWindow.getSize(),
      minimum: browserWindow.getMinimumSize(),
      title: browserWindow.getTitle(),
    };
  });
  expect(preferences).toMatchObject({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    minimum: [1100, 700],
    title: '未命名 1 — Brickloop（积环）',
  });
  // Windows fractional display scaling can round the physical frame by one DIP.
  expect(Math.abs(preferences.size[0]! - 1440)).toBeLessThanOrEqual(1);
  expect(Math.abs(preferences.size[1]! - 900)).toBeLessThanOrEqual(1);

  await expect(window.getByRole('toolbar').getByRole('button', { name: '选择', exact: true })).toBeEnabled();
  await expect(window.getByRole('toolbar').getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await window.getByRole('menuitem', { name: '文件', exact: true }).click();
  await expect(window.getByRole('menuitem', { name: /新建.*Ctrl\+N/ })).not.toHaveAttribute('aria-disabled', 'true');
  await window.getByTestId('viewport-host').click();
  await window.locator('.inspector-heading').getByText('结构', { exact: true }).click();
  await expect(window.getByText('暂无模型结构与步骤')).toBeVisible();
  await window.locator('.inspector-heading').getByText('AI 助手', { exact: true }).click();
  await expect(window.getByText('描述想修改的内容，一起完成模型。')).toBeVisible();
  await expect(window.getByRole('button', { name: '添加服务商', exact: true })).toBeVisible();
  await window.locator('.inspector-heading').getByText('色板', { exact: true }).click();

  const fullWidth = (await window.getByTestId('viewport-host').boundingBox())!.width;
  await window.getByRole('button', { name: '折叠零件库', exact: true }).click();
  await window.getByRole('button', { name: '折叠右侧面板', exact: true }).click();
  expect((await window.getByTestId('viewport-host').boundingBox())!.width).toBeGreaterThan(fullWidth);
  await window.getByRole('button', { name: '展开零件库', exact: true }).click();
  await window.getByRole('button', { name: '展开右侧面板', exact: true }).click();
  const resize = window.getByRole('separator', { name: '调整零件库宽度', exact: true });
  await resize.focus();
  await resize.press('ArrowRight');
  await expect(resize).toHaveAttribute('aria-valuenow', '288');
  await resize.press('ArrowLeft');
  await expect(resize).toHaveAttribute('aria-valuenow', '280');
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1100, 700));
  await expect(window.locator('.status-bar')).toBeVisible();
  await expect(window.locator('.inspector-heading').getByText('AI 助手', { exact: true })).toBeVisible();
  await window.screenshot({ path: path.join(screenshots, 'ui-01-min-size.png') });
});

test('UI-02 通过菜单即时切换英文和中文，重启后保留最后选择', async () => {
  let window = await launch();
  await chooseLanguage(window, 'zh-CN', 'en');
  await expect(window).toHaveTitle('Untitled 1 — Brickloop');
  await expect(window.locator('html')).toHaveAttribute('lang', 'en');
  await expect(window.locator('.status-bar')).toContainText('Parts 0');
  await expect(window.getByText('222 parts', { exact: true })).toBeVisible();
  await window.screenshot({ path: path.join(screenshots, 'ui-02-en.png') });
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1100, 700));
  await expect(window.locator('.inspector-heading').getByText('AI assistant', { exact: true })).toBeVisible();
  await window.screenshot({ path: path.join(screenshots, 'ui-02-en-min-size.png') });
  expect(JSON.parse(await readFile(path.join(directory, 'config/settings.json'), 'utf8'))).toEqual({ language: 'en' });
  await close();

  window = await launch();
  await expect(window.getByRole('menuitem', { name: 'File', exact: true })).toBeVisible();
  await window.screenshot({ path: path.join(screenshots, 'ui-02-restart-en.png') });
  await chooseLanguage(window, 'en', 'zh-CN');
  await expect(window).toHaveTitle(/积环/);
  expect(JSON.parse(await readFile(path.join(directory, 'config/settings.json'), 'utf8'))).toEqual({
    language: 'zh-CN',
  });
  await close();

  window = await launch();
  await expect(window.getByRole('menuitem', { name: '文件', exact: true })).toBeVisible();
  await expect(window.locator('.status-bar')).toContainText('零件数');
  await window.screenshot({ path: path.join(screenshots, 'ui-02-restart-zh-CN.png') });
});
import { AI_CHANNELS } from '../src/shared/ai-api';
