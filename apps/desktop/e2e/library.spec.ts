import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { launchElectron } from './electron-launch';
import { setStableContentSize } from './window-size';
import type { ElectronApplication, Page } from '@playwright/test';
import { buildCatalogIndex, importPack, readColors, writePack } from '@brickloop/catalog';
import type { DesktopApi } from '../src/shared/api';
import type { MeshResult } from '../src/shared/library-api';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repo = path.resolve(desktop, '../..');
const dataRoot = path.join(repo, '.devdata/e2e');
const output = path.join(desktop, '../../.devdata/e2e-results');

async function mesh(
  page: Page,
): Promise<{ cacheHit: boolean; durationMs: number; roundtripMs: number; vertices: number }> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = crypto.randomUUID();
        const start = performance.now();
        function listener(event: MessageEvent<{ request?: string }>) {
          if (event.data.request !== request || !event.ports[0]) return;
          window.removeEventListener('message', listener);
          const port = event.ports[0];
          port.onmessage = (message: MessageEvent<{ result: MeshResult }>) => {
            const result = message.data.result;
            port.close();
            resolve({
              cacheHit: result.cacheHit,
              durationMs: result.durationMs,
              roundtripMs: performance.now() - start,
              vertices: result.mesh.batches.reduce((sum, batch) => sum + batch.positions.length / 3, 0),
            });
          };
          port.start();
        }
        window.addEventListener('message', listener);
        (window as unknown as { brickloopMeshRequest(request: string, id: string): void }).brickloopMeshRequest(
          request,
          'ld:3001',
        );
      }),
  );
}
async function pixels(app: ElectronApplication, page: Page, name: string) {
  const buffer = await page
    .getByTestId('viewport-host')
    .screenshot({ path: path.join(output, 'screenshots', name), scale: 'css' });
  return app.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    const bitmap = image.toBitmap();
    let sum = 0,
      squared = 0,
      red = 0,
      blue = 0;
    for (let index = 0; index < bitmap.length; index += 4) {
      const b = bitmap[index]!,
        g = bitmap[index + 1]!,
        r = bitmap[index + 2]!;
      const value = (r + g + b) / 3;
      sum += value;
      squared += (r * r + g * g + b * b) / 3;
      if (r > 80 && r > g * 1.8 && r > b * 1.8) red++;
      if (b > 80 && b > r * 1.8 && b > g * 1.2) blue++;
    }
    const count = bitmap.length / 4;
    return { variance: squared / count - (sum / count) ** 2, red, blue };
  }, buffer.toString('base64'));
}

test('UI-03 零件搜索、预览、色板、模板导出、错误行导入与切回示例包', async () => {
  test.setTimeout(180_000);
  await mkdir(dataRoot, { recursive: true });
  await mkdir(path.join(output, 'screenshots'), { recursive: true });
  const directory = await mkdtemp(path.join(dataRoot, 'library-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const started = performance.now();
  const application = await launchElectron({
    args: [desktop],
    env: { ...env, BRICKLOOP_DATA_DIR: directory },
    timeout: 20_000,
  });
  application.process().stdout?.on('data', (data: Buffer) => console.log(data.toString().trim()));
  try {
    const page = await application.firstWindow();

    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45000,
    });
    const coldStartupMs = performance.now() - started;
    console.log('Library ready', coldStartupMs);
    const firstMesh = await mesh(page);
    const cachedMesh = await mesh(page);
    expect(firstMesh.cacheHit).toBe(false);
    expect(cachedMesh.cacheHit).toBe(true);
    expect(firstMesh.vertices).toBeGreaterThan(100);
    expect(cachedMesh.vertices).toBe(firstMesh.vertices);
    const search = page.getByRole('textbox', { name: '搜索零件名称或编号' });
    await search.fill('3001');
    const part = page.locator('[data-part-id="ld:3001"]');
    await expect(part).toContainText('砖 2×4');
    await part.click();
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-placing', 'true');
    await expect(page.locator('.brickloop-viewport')).toHaveAttribute('data-part-count', '0');
    await expect(page.locator('.preview-message')).toHaveCount(0);
    await expect(part.locator('img')).toBeVisible({ timeout: 30000 });
    const neutralThumbnail = await part.locator('img').getAttribute('src');
    await page.getByTestId('viewport-host').hover();
    const red = await pixels(application, page, 'm1-3-red-preview.png');
    expect(red.variance).toBeGreaterThan(200);
    expect(red.red).toBeGreaterThan(500);
    await page.locator('[data-color-id="c:bright-blue"]').first().click();
    await expect(page.locator('.preview-message')).toHaveCount(0);
    await expect(page.locator('[data-color-id="c:bright-blue"]').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(part.locator('img')).toHaveAttribute('src', neutralThumbnail!);
    await page.getByTestId('viewport-host').hover();
    const blue = await pixels(application, page, 'm1-3-blue-preview.png');
    expect(blue.blue).toBeGreaterThan(red.blue + 500);
    expect(blue.red).toBeLessThan(red.red / 2);
    await page.getByRole('button', { name: '收藏当前颜色', exact: true }).click();
    await expect(page.getByRole('button', { name: '取消收藏当前颜色', exact: true })).toBeVisible();
    expect(JSON.parse(await readFile(path.join(directory, 'config/settings.json'), 'utf8'))).toMatchObject({
      favoriteColors: ['c:bright-blue'],
    });
    await page.getByRole('button', { name: '取消收藏当前颜色', exact: true }).click();
    await expect(page.getByRole('button', { name: '收藏当前颜色', exact: true })).toBeVisible();
    await page.locator('[data-color-id="c:bright-red"]').first().click();
    const colorHeading = page.locator('.current-color-heading');
    await expect(colorHeading.locator('strong')).toHaveText('亮红');
    await expect(colorHeading.locator('strong')).toHaveAttribute('lang', 'zh-CN');
    await expect(colorHeading.locator('strong + div')).toHaveText('Bright Red');
    await expect(colorHeading.locator('strong + div')).toHaveAttribute('lang', 'en');
    await expect(page.locator('[data-color-id="c:bright-red"]').first()).toHaveAccessibleName('亮红');
    await page.locator('[data-color-id="c:bright-red"]').first().hover();
    await expect(page.getByRole('tooltip')).toHaveText('亮红 · Bright Red · DEMO-005');
    await search.fill('');
    await expect(page.getByText('222 个零件', { exact: true })).toBeVisible();
    await expect(page.locator('.part-tile img').first()).toBeVisible({ timeout: 30000 });
    await setStableContentSize(application, page, 1440, 900);
    await expect
      .poll(async () => (await page.locator('.part-tile').count()) - (await page.locator('.part-tile img').count()), {
        timeout: 45000,
      })
      .toBe(0);
    await page.screenshot({ path: path.join(output, 'screenshots/m1-3-1440x900.png'), scale: 'css' });
    await setStableContentSize(application, page, 1100, 700);
    await page.screenshot({ path: path.join(output, 'screenshots/m1-3-1100x700.png'), scale: 'css' });
    expect(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth && document.body.scrollHeight <= innerHeight),
    ).toBe(true);
    const detail = await page.locator('.color-detail').boundingBox();
    const panel = await page.locator('.inspector-panel').boundingBox();
    expect(detail!.y + detail!.height).toBeLessThanOrEqual(panel!.y + panel!.height + 1);

    await page.getByRole('menuitem', { name: '帮助', exact: true }).click();
    await page.getByRole('menuitem', { name: '语言', exact: true }).click();
    await page.getByRole('menuitem', { name: 'English', exact: true }).click();
    await expect(colorHeading.locator('strong')).toHaveText('Bright Red');
    await expect(colorHeading.locator('strong')).toHaveAttribute('lang', 'en');
    await expect(colorHeading.locator('strong + div')).toHaveText('亮红');
    await expect(colorHeading.locator('strong + div')).toHaveAttribute('lang', 'zh-CN');
    await colorHeading.click();
    await expect(page.locator('[data-color-id="c:bright-red"]').first()).toHaveAccessibleName('Bright Red');
    await page.locator('[data-color-id="c:bright-red"]').first().hover();
    await expect(page.getByRole('tooltip')).toHaveText('Bright Red · 亮红 · DEMO-005');
    await page.locator('[data-color-id="c:transparent-fluorescent-green"]').first().click();
    await expect(colorHeading.locator('strong')).toHaveText('Transparent Fluorescent Green');
    await expect(colorHeading.locator('strong')).toHaveAttribute('title', 'Transparent Fluorescent Green');
    const nameBox = await colorHeading.locator('strong').boundingBox();
    const starBox = await colorHeading.getByRole('button').boundingBox();
    expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(starBox!.x);
    await expect(colorHeading.locator('strong')).toHaveCSS('text-overflow', 'ellipsis');
    await page.locator('.color-detail').screenshot({ path: path.join(output, 'screenshots/m9-5d-color-en.png') });
    await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Language', exact: true }).click();
    await page.getByRole('menuitem', { name: '简体中文', exact: true }).click();
    await expect(colorHeading.locator('strong + div')).toHaveText('Transparent Fluorescent Green');
    await colorHeading.click();
    await page.locator('[data-color-id="c:bright-red"]').first().click();
    await expect(colorHeading.locator('strong')).toHaveText('亮红');
    await page.locator('.color-detail').screenshot({ path: path.join(output, 'screenshots/m9-5d-color-zh.png') });

    await page.getByText('全部', { exact: true }).click();
    await expect(page.getByText('20463 个零件', { exact: true })).toBeVisible();
    const scroll = await page.getByTestId('part-grid').evaluate(async (element) => {
      const frames: number[] = [];
      let previous = performance.now();
      for (let frame = 0; frame < 120; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const now = performance.now();
        frames.push(now - previous);
        previous = now;
        element.scrollTop = frame * 160;
      }
      frames.sort((a, b) => a - b);
      return {
        frames: frames.length,
        p50Ms: frames[60],
        p95Ms: frames[114],
        maxMs: frames[119],
        over33ms: frames.filter((time) => time > 33.4).length,
        mountedTiles: element.querySelectorAll('.part-tile').length,
      };
    });
    expect(scroll.mountedTiles).toBeLessThan(60);
    await page.getByText('工厂件', { exact: true }).click();

    await page.getByRole('button', { name: '示例包', exact: true }).click();
    const template = path.join(directory, 'blank.brklpack');
    await application.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
    }, template);
    await page.getByRole('button', { name: '导出空白模板', exact: true }).click();
    await expect(page.getByText(`模板已保存至 ${template}`)).toBeVisible();
    expect((await readFile(template)).byteLength).toBeGreaterThan(1000);

    const library = path.join(repo, 'library/ldraw');
    const catalog = await buildCatalogIndex({ libraryDir: library });
    const colors = await readColors(path.join(library, 'LDConfig.ldr'));
    const imported = await importPack(template, { catalog, colors });
    expect(imported.pack).toBeDefined();
    const pack = imported.pack!;
    pack.manifest = { ...pack.manifest, id: 'e2e-review', name: '测试工厂', source: '界面验收测试' };
    pack.parts.push({ ...pack.parts[0]!, partId: 'ld:3002', legoNo: '3002', ldrawFile: '3002.dat', factoryNo: '' });
    const fixture = path.join(directory, 'one-error.brklpack');
    await writePack(fixture, pack);
    await application.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, fixture);
    await page.getByRole('button', { name: '导入数据包', exact: true }).click();
    await expect(page.getByRole('log')).toContainText('第 4 行');
    await expect(page.getByRole('log')).toContainText('工厂编号');
    await page.screenshot({ path: path.join(output, 'screenshots/m1-3-import-error.png'), scale: 'css' });
    await page.getByRole('button', { name: '忽略错误行导入', exact: true }).click();
    await expect(page.getByText('与当前包的差异：测试工厂')).toBeVisible();
    await page.screenshot({ path: path.join(output, 'screenshots/m1-3-import-diff.png'), scale: 'css' });
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.locator('[data-pack-id="e2e-review"]')).toContainText('已启用');
    await expect(page.locator('.result-count')).toHaveText('1 个零件');
    await page.locator('[data-pack-id="demo"]').getByRole('button', { name: '启用', exact: true }).click();
    await expect(page.locator('[data-pack-id="demo"]')).toContainText('已启用');
    await expect(page.locator('.result-count')).toHaveText('222 个零件');
    await page.screenshot({ path: path.join(output, 'screenshots/m1-3-pack-manager.png'), scale: 'css' });
    await page.keyboard.press('Escape');
    const status = await page.evaluate(() =>
      (window as unknown as { brickloop: DesktopApi }).brickloop.catalogStatus(),
    );
    const metrics = { coldStartupMs, catalogReadyMs: status.startupMs, firstMesh, cachedMesh, scroll, red, blue };
    await writeFile(path.join(output, 'm1-3-performance.json'), JSON.stringify(metrics, null, 2));
    console.log('M1-3 performance', JSON.stringify(metrics));
  } finally {
    await application.close();
    if (path.dirname(directory) === dataRoot) await rm(directory, { recursive: true, force: true });
  }
});
