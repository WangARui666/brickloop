/* global window, structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, stat, writeFile, rm, symlink, rmdir, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { tsImport } from 'tsx/esm/api';
import { desktopRequire, root } from './release-utils.mjs';
import { createAppDataGuard } from './appdata-guard.mjs';

const { expect } = desktopRequire('@playwright/test');
const { launchElectron } = await tsImport('../apps/desktop/e2e/electron-launch.ts', import.meta.url);
const { importIo, packProject, unpackProject } = await tsImport('../packages/io/src/index.ts', import.meta.url);
const { ulid } = await tsImport('../packages/core/src/index.ts', import.meta.url);
const { inspectAnimationMp4 } = await tsImport('../apps/desktop/e2e/animation-mp4.ts', import.meta.url);
const { imageModelServer } = await tsImport('../apps/desktop/e2e/image-model-fixture.ts', import.meta.url);
const instructionRequire = createRequire(path.join(root, 'packages/instructions/package.json'));
const { getDocument } = await import(pathToFileURL(instructionRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const { PDFDocument, PDFDict, PDFName, PDFRawStream } = instructionRequire('pdf-lib');
const { version } = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'));
const base = path.join(root, '.devdata/packaged-smoke');
const imageOnly = process.argv.includes('--image-only');
const evidence = path.join(root, imageOnly ? '.devdata/e2e-results/m12-5/packaged' : 'dist/release-evidence');
await mkdir(base, { recursive: true });
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(path.join(base, 'run-'));
const executable = path.resolve(
  process.argv.find((arg) => arg.startsWith('--executable='))?.slice('--executable='.length) ??
    path.join(root, 'dist/win-unpacked/Brickloop.exe'),
);
const projectPath = path.join(evidence, '交付冒烟工程.brkl');
const ioPath = path.join(evidence, '交付冒烟工程.io');
const pdfPath = path.join(evidence, '交付冒烟说明书.pdf');
const env = { ...process.env, BRICKLOOP_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
delete env.BRICKLOOP_EVAL_API_KEY;
delete env.BRICKLOOP_AI_EVAL;
const results = [];
const errors = [];
let app, page, report;
const pass = (name, detail) => {
  results.push({ name, passed: true, detail });
  console.log(`PASS ${name}: ${detail}`);
};
async function launch(args = []) {
  app = await launchElectron({ executablePath: executable, args, env, timeout: 30000 });
  page = await app.firstWindow({ timeout: 30000 });
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page).toHaveTitle(/Brickloop/, { timeout: 30000 });
  await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', { timeout: 90000 });
}
async function saveTo(destination) {
  if (![directory, evidence].includes(path.dirname(path.resolve(destination))))
    throw new Error('Unexpected smoke output path');
  await rm(destination, { force: true });
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, destination);
}
async function saved(file) {
  await expect
    .poll(async () => (await stat(file).catch(() => ({ size: 0 }))).size, { timeout: 120000 })
    .toBeGreaterThan(100);
}
async function exportMenu(name) {
  await page.getByRole('menuitem', { name: '文件', exact: true }).click();
  await page.getByRole('menuitem', { name: '导出', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function imageWorkflow() {
  const server = await imageModelServer();
  server.controls.delay = 150;
  try {
    await page.getByRole('menuitem', { name: '文件', exact: true }).click();
    await page.getByRole('menuitem', { name: /^新建/ }).click();
    await page.keyboard.press('Control+k');
    await page.getByRole('button', { name: 'AI 设置', exact: true }).click();
    await page.getByRole('button', { name: '使用 API Key', exact: false }).first().click();
    const provider = page.locator('.ai-provider-modal');
    await provider.getByRole('searchbox').fill('自定义');
    await provider.locator('.ai-preset').click();
    await provider.getByRole('textbox', { name: '服务地址', exact: true }).fill(server.endpoint);
    await provider.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(provider.getByRole('button', { name: '保存', exact: true })).toBeEnabled({ timeout: 30000 });
    await provider.getByRole('button', { name: '保存', exact: true }).click();
    const snapshot = await page.evaluate(() => window.brickloop.aiSnapshot());
    expect(snapshot.settings.providers.some((p) => p.type === 'compatible' && p.endpoint === server.endpoint)).toBe(
      true,
    );
    await page.evaluate(async () => {
      const state = await window.brickloop.aiSnapshot();
      await window.brickloop.aiSaveSettings({ ...state.settings, localOnly: true, history: true });
    });
    await page
      .locator('.ai-settings-modal .ant-modal-footer')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await page.getByRole('button', { name: '按参考图生成', exact: true }).click();
    await page
      .getByLabel('选择参考图', { exact: true })
      .setInputFiles(path.join(root, 'packages/ai/test/ai-eval/references/01-front.png'));
    await page.getByRole('textbox', { name: '描述', exact: true }).fill('免安装版合成参考小房子');
    await page.getByRole('button', { name: '生成计划', exact: true }).click();
    await expect(page.locator('.image-plan-modal')).toBeVisible();
    await page.getByRole('textbox', { name: '部件名称', exact: true }).first().fill('免安装版主体');
    await page.getByRole('button', { name: '开始搭建', exact: true }).click();
    await expect(page.locator('.image-task-card')).toBeVisible();
    const reportSection = page.locator('.image-report').last();
    await expect(reportSection).toBeVisible({ timeout: 120000 });
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', '2');
    await expect(reportSection).toContainText('2 件');
    await page.getByTestId('review-bar').getByRole('button', { name: '全部保留', exact: true }).click();
    await reportSection.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, 'image-workflow-report.png') });
    const imageIo = path.join(evidence, '看图冒烟.io');
    await saveTo(imageIo);
    await reportSection.getByRole('button', { name: '导出 .io…', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '导出', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('导出报告', { timeout: 45000 });
    const colors = await page.evaluate(() => window.brickloop.catalogColors());
    const imported = importIo(await readFile(imageIo), { colors: colors.all });
    expect(imported.report.errors).toEqual([]);
    expect(imported.report.counts.parts).toBe(2);
    await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
    const imageProject = path.join(evidence, '看图冒烟.brkl');
    await saveTo(imageProject);
    await page.locator('.document-title').click();
    await page.keyboard.press('Control+s');
    await saved(imageProject);
    const archive = unpackProject(await readFile(imageProject));
    expect(archive.doc).toBeTruthy();
    const history = Buffer.from(archive.assets['ai/history.jsonl']).toString('utf8');
    expect(history).toContain('免安装版主体');
    expect(history).toContain('免安装版合成参考小房子');
    expect(history).toContain('"partCount":2');
    expect(server.requests.some((r) => JSON.stringify(r.messages).includes('data:image/png;base64,'))).toBe(true);
    pass(
      '看图搭建完整流程（本机假服务）',
      `真实自定义服务表单、合成 PNG、修改计划、报告、全部保留、.io 读回 2 件、保存 .brkl 与报告记录；运行版本 ${await app.evaluate(({ app }) => app.getVersion())}`,
    );
  } finally {
    await server.close();
  }
}
const checkAppData = await createAppDataGuard();
try {
  await launch();
  if (imageOnly) {
    await imageWorkflow();
    report = { passed: true, results, executable, pageErrors: errors, installerExecuted: false, userDataCleaned: true };
  } else {
    const paths = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      executable: app.getPath('exe'),
      resources: process.resourcesPath,
      userData: app.getPath('userData'),
      sessionData: app.getPath('sessionData'),
      version: app.getVersion(),
    }));
    expect(paths.packaged).toBe(true);
    expect(paths.version).toBe(version);
    expect(paths.userData).toBe(path.join(directory, 'config'));
    expect(paths.sessionData).toBe(path.join(directory, 'session'));
    await expect
      .poll(
        () =>
          stat(path.join(directory, 'session/Local State')).then(
            () => true,
            () => false,
          ),
        { timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toBe(true);
    await assert.rejects(stat(path.join(directory, 'cache/session')), { code: 'ENOENT' });
    pass('会话目录位置', 'session/Local State 存在，cache/session 不存在');
    expect(paths.resources).toBe(path.join(root, 'dist/win-unpacked/resources'));
    expect(await page.evaluate(() => typeof window.brickloopEditorTest)).toBe('undefined');
    await page.getByRole('textbox', { name: '搜索零件名称或编号' }).fill('3001');
    const part = page.locator('[data-part-id="ld:3001"]');
    await expect(part).toContainText('砖 2×4');
    await expect(part.locator('img')).toBeVisible({ timeout: 30000 });
    pass('启动与零件库', '生产构建、独立数据目录、3001 名称及缩略图可用');
    await part.click();
    const viewport = page.locator('.brickloop-viewport');
    const box = await viewport.boundingBox();
    if (!box) throw new Error('Viewport has no bounds');
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.6);
    await expect(viewport).toHaveAttribute('data-part-count', '1', { timeout: 15000 });
    await page.keyboard.press('Escape');
    await saveTo(projectPath);
    await page.keyboard.press('Control+s');
    await saved(projectPath);
    const savedProject = unpackProject(await readFile(projectPath));
    expect(savedProject.doc).toBeTruthy();
    const document = savedProject.doc;
    const instances = Object.values(document.models[document.rootModelId].instances);
    expect(instances).toHaveLength(1);
    expect(instances[0].ref).toMatchObject({ kind: 'part', partId: 'ld:3001' });
    pass('放置与保存 .brkl', '真实界面放置 1 个 3001，@brickloop/io 解包确认');
    await saveTo(ioPath);
    await exportMenu('Studio .io');
    await page.getByRole('dialog').getByRole('button', { name: '导出', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('导出报告', { timeout: 45000 });
    await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
    const context = await page.evaluate(async () => ({
      parts: await window.brickloop.catalogSearch('3001', { includeAll: true }),
      colors: (await window.brickloop.catalogColors()).all,
    }));
    const io = importIo(await readFile(ioPath), context);
    expect(io.doc).toBeTruthy();
    expect(io.report.errors).toHaveLength(0);
    expect(io.report.counts.parts).toBe(1);
    const imported = Object.values(io.doc.models[io.doc.rootModelId].instances)[0];
    expect(imported.ref).toEqual(instances[0].ref);
    expect(imported.colorId).toEqual(instances[0].colorId);
    expect(imported.transform).toEqual(instances[0].transform);
    pass('导出与读回 .io', '使用 @brickloop/io 校验零件、颜色、位置，未改 Studio .info 常量');
    await page.locator('#library-panel .ant-segmented').getByText('宏', { exact: true }).click();
    await expect(page.locator('[data-macro-id]')).toHaveCount(6);
    await expect(page.locator('[data-macro-id="builtin.table"] img')).toBeVisible({ timeout: 120000 });
    const patterns = await page.evaluate(() => window.brickloop.patternGroups());
    expect(patterns).toHaveLength(7);
    expect(patterns.every((group) => group.count > 0)).toBe(true);
    await page.getByRole('button', { name: '桌子', exact: true }).dblclick();
    await expect(viewport).toHaveAttribute('data-placing', 'true');
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7);
    await page.waitForTimeout(500);
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.7);
    await expect(viewport).toHaveAttribute('data-part-count', '16', { timeout: 30000 });
    await page.keyboard.press('Escape');
    pass('宏与图案资源', '6 个内置宏；桌子插入 15 件；7 个图案分组均非空');
    await saveTo(pdfPath);
    await exportMenu('说明书 PDF…');
    await page.getByRole('dialog').getByRole('button', { name: '导出', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('说明书已保存', { timeout: 180000 });
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).last().click();
    const pdfBytes = await readFile(pdfPath);
    const pdf = await PDFDocument.load(pdfBytes);
    const embedded = pdf.context
      .enumerateIndirectObjects()
      .filter(
        ([, value]) =>
          value instanceof PDFDict &&
          ['FontFile', 'FontFile2', 'FontFile3'].some((key) => value.lookup(PDFName.of(key)) instanceof PDFRawStream),
      );
    expect(embedded.length).toBeGreaterThanOrEqual(2);
    const pdfTask = getDocument({ data: Uint8Array.from(pdfBytes), useSystemFonts: false });
    const parsed = await pdfTask.promise;
    let extracted = '';
    for (let index = 1; index <= parsed.numPages; index++) {
      const pdfPage = await parsed.getPage(index);
      await pdfPage.getOperatorList();
      extracted += (await pdfPage.getTextContent()).items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join(' ');
    }
    await pdfTask.destroy();
    expect(extracted).toMatch(/步骤|第.*步/);
    expect(extracted).toMatch(/零件/);
    pass('说明书 PDF', `${pdf.getPageCount()} 页，${embedded.length} 个嵌入字体描述符，PDF.js 无系统字体提取中文成功`);
    await page.getByRole('menuitem', { name: '视图', exact: true }).click();
    await page.getByRole('menuitem', { name: '搭建动画…', exact: true }).click();
    await expect(page.locator('.animation-session')).toHaveAttribute('data-ready', 'true', { timeout: 60000 });
    const durationText = await page.locator('.animation-time').innerText();
    const duration = Number(durationText.match(/\/\s*([\d.]+)/)?.[1]);
    expect(duration).toBeGreaterThan(0);
    await page.getByRole('button', { name: '导出视频…', exact: true }).click();
    await expect(page.locator('.animation-export-options')).toContainText('MP4 · H.264');
    const animationPath = path.join(evidence, '交付冒烟搭建动画.mp4');
    await saveTo(animationPath);
    await page.getByRole('button', { name: '导出视频', exact: true }).click();
    await saved(animationPath);
    const animation = inspectAnimationMp4(await readFile(animationPath));
    expect(animation.boxes).toEqual(expect.arrayContaining(['ftyp', 'moov']));
    expect(animation.codec).toMatch(/^avc1\./);
    expect(Math.abs(animation.duration - duration)).toBeLessThanOrEqual(0.1);
    await page
      .getByRole('dialog', { name: '导出搭建视频', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .last()
      .click();
    await page.locator('.build-animation-dialog .ant-modal-close').click();
    pass(
      '搭建动画导出',
      `MP4 · H.264，ftyp / moov 完整，${animation.codec} 视频轨，${animation.duration.toFixed(3)} 秒（播放器 ${duration.toFixed(1)} 秒）`,
    );
    await page.getByRole('menuitem', { name: '帮助', exact: true }).click();
    await page.getByRole('menuitem', { name: '关于 Brickloop', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(version);
    await page.getByRole('tab', { name: '开源许可' }).click();
    await expect(page.locator('.license-list')).toContainText('LDraw.org Parts Library');
    await expect(page.locator('.license-list')).toContainText('Noto Sans SC');
    await page.getByRole('textbox', { name: '搜索名称或许可' }).fill('Noto');
    await page.getByText('查看许可与署名').click();
    await expect(page.locator('.license-list')).toContainText('SIL OPEN FONT LICENSE');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).last().click();
    pass('关于与许可', `${version}、LDraw 署名及 Noto Sans SC OFL 正文可见`);
    await page.locator('.document-title').click();
    await page.keyboard.press('Control+,');
    await page.getByRole('tab', { name: 'AI 助手', exact: true }).click();
    await expect(page.locator('.ai-provider-item')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '用账号登录', exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: '使用 API Key', exact: false })).toBeVisible();
    pass('AI 设置', '页面打开，无已保存服务，显示账号登录和 API Key 两种方式');
    await page.getByRole('button', { name: '使用 API Key', exact: false }).click();
    const provider = page.locator('.ai-provider-modal');
    await provider.getByRole('searchbox').fill('DeepSeek');
    await expect(provider.locator('.ai-preset')).toHaveCount(1);
    await provider.locator('.ai-preset').click();
    await expect(provider.getByLabel('API 密钥', { exact: true })).toBeVisible();
    await expect(provider.getByLabel('API 密钥', { exact: true })).toHaveValue('');
    await expect(provider.locator('input:visible')).toHaveCount(1);
    await expect(provider.getByRole('button', { name: '去获取 API Key ↗', exact: true })).toBeVisible();
    await expect(provider.getByRole('button', { name: '测试连接', exact: true })).toBeVisible();
    await expect(provider.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
    await expect(provider.getByRole('textbox', { name: '服务地址', exact: true })).toBeHidden();
    await expect(provider.getByRole('combobox', { name: '模型', exact: true })).toBeHidden();
    await expect(provider.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await provider.getByRole('button', { name: '取消', exact: true }).click();
    await expect(provider).toBeHidden();
    await expect(page.locator('.ai-provider-item')).toHaveCount(0);
    pass('AI 接入设置', '空状态两种方式、DeepSeek 预设与精简 Key 表单可用；未输入 Key、未测试连接，取消后未保存服务');
    await page.getByRole('tab', { name: '外部智能体', exact: true }).click();
    const shim = path.join(root, 'dist/win-unpacked/brickloop-mcp.cmd');
    const codex = await page.locator('.ai-config:visible').textContent();
    expect(codex).toContain('[mcp_servers.brickloop]');
    const command = JSON.parse(codex.match(/^command = (.+)$/m)[1]);
    expect(path.normalize(command)).toBe(executable);
    expect(codex).toContain('env = { ELECTRON_RUN_AS_NODE = "1" }');
    const args = JSON.parse(codex.match(/^args = (.+)$/m)[1]);
    expect(args).toHaveLength(1);
    expect(path.normalize(args[0])).toBe(path.join(root, 'dist/win-unpacked/resources/app.asar/out/main/mcp-shim.js'));
    await page.getByRole('tab', { name: 'Claude Code', exact: true }).click();
    const claude = JSON.parse(await page.locator('.ai-config:visible').textContent());
    expect(claude.mcpServers.brickloop).toEqual({ type: 'stdio', command, args, env: { ELECTRON_RUN_AS_NODE: '1' } });
    expect((await stat(shim)).isFile()).toBe(true);
    // Exercise the release launcher through the official SDK; initialize does not request editor access.
    const { Client } = desktopRequire('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = desktopRequire('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 'release-smoke', version: version });
    try {
      await client.connect(
        new StdioClientTransport({
          command,
          args,
          env: { ...env, ...claude.mcpServers.brickloop.env },
          stderr: 'pipe',
        }),
      );
      expect(client.getServerVersion()).toMatchObject({ name: 'brickloop-mcp', version: version });
      expect((await client.listTools()).tools.some((tool) => tool.name === 'place_part')).toBe(true);
    } finally {
      await client.close();
    }
    const alias = path.join(directory, 'MCP entry with spaces');
    await symlink(path.dirname(executable), alias, 'junction');
    const spacedClient = new Client({ name: 'release-spaces-smoke', version: version });
    try {
      await spacedClient.connect(
        new StdioClientTransport({
          command: path.join(alias, 'Brickloop.exe'),
          args: [path.join(alias, 'resources/app.asar/out/main/mcp-shim.js')],
          env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
          stderr: 'pipe',
        }),
      );
      expect(spacedClient.getServerVersion()?.version).toBe(version);
      expect((await spacedClient.listTools()).tools.some((tool) => tool.name === 'place_part')).toBe(true);
    } finally {
      await spacedClient.close();
      assert(path.dirname(alias) === directory && (await lstat(alias)).isSymbolicLink(), 'Unexpected MCP junction');
      await rmdir(alias); // Remove only the verified junction itself; never traverse the release directory.
    }
    pass('MCP 发布配置', 'Codex TOML 与 Claude JSON 一致；直接发布入口及含空格路径均完成 SDK initialize / tools/list');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).last().click();
    await saveTo(path.join(directory, '桌子.brkl'));
    await page.locator('.document-title').click();
    await page.keyboard.press('Control+Shift+s');
    await saved(path.join(directory, '桌子.brkl'));
    await expect(page).not.toHaveTitle(/^•/);
    await app.close();
    app = undefined;
    const secondDocument = structuredClone(document);
    secondDocument.documentId = ulid();
    secondDocument.meta.title = '第二个关联工程';
    const secondPath = path.join(directory, '含空格 second project.brkl');
    await writeFile(secondPath, packProject(secondDocument, savedProject.workspace, savedProject.assets));
    await launch([projectPath]);
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', '1', { timeout: 30000 });
    await expect(page.locator('.document-title')).toContainText(path.basename(projectPath).replace(/\.brkl$/i, ''));
    pass('首次启动文件参数', 'win-unpacked/Brickloop.exe <工程.brkl> 自动打开保存工程');
    const child = spawn(executable, [`--user-data-dir=${directory}`, secondPath], {
      env,
      windowsHide: true,
      stdio: 'ignore',
    });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    await expect(page.locator('.document-title')).toContainText(path.basename(secondPath).replace(/\.brkl$/i, ''), {
      timeout: 30000,
    });
    expect(await exited).toBe(0);
    expect(app.windows()).toHaveLength(1);
    await expect(page.locator('.document-tab')).toHaveCount(2);
    pass('第二次启动文件参数', '真实第二进程退出，已有窗口打开含空格路径工程，两个文档标签');
    await imageWorkflow();
    expect(errors).toEqual([]);
    await page.screenshot({ path: path.join(evidence, 'packaged-smoke.png'), scale: 'css' });
    report = { passed: true, results, paths, pageErrors: errors, installerExecuted: false, userDataCleaned: true };
  }
} catch (error) {
  if (page && !page.isClosed())
    await page.screenshot({ path: path.join(evidence, 'smoke-failure.png') }).catch(() => {});
  await writeFile(
    path.join(evidence, 'smoke-report.json'),
    `${JSON.stringify({ passed: false, results, error: String(error), installerExecuted: false }, null, 2)}\n`,
  );
  throw error;
} finally {
  try {
    if (app) {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    }
    assert.equal(path.dirname(path.resolve(directory)), base, 'Unsafe smoke cleanup path');
    await rm(directory, { recursive: true, force: true });
  } finally {
    await checkAppData();
  }
}
await rm(path.join(evidence, 'smoke-failure.png'), { force: true });
await writeFile(path.join(evidence, 'smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`);
