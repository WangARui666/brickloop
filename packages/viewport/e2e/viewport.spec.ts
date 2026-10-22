import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from '../../../apps/desktop/e2e/electron-test';
import { launchElectron } from '../../../apps/desktop/e2e/electron-launch';
import type { ElectronApplication, Page } from '@playwright/test';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const desktop = path.join(repo, 'apps/desktop');
const dataRoot = path.join(repo, '.devdata/e2e');
const output = path.join(desktop, '../../.devdata/e2e-results/screenshots');

async function pixels(application: ElectronApplication, page: Page, name: string) {
  // Measure the 3D image; text antialiasing in breadcrumbs is not part of the brick bounds.
  const picture = await page.locator('.brickloop-viewport > canvas').screenshot({
    path: path.join(output, name),
    scale: 'css',
    style: '.context-breadcrumb, .shared-notice, .preview-label { visibility: hidden !important; }',
  });
  return application.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap(); // Electron on Windows returns BGRA.
    let sum = 0,
      squared = 0,
      count = 0,
      xTotal = 0,
      yTotal = 0;
    let minX = width,
      maxX = 0,
      minY = height,
      maxY = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const index = 4 * (y * width + x);
        const b = bitmap[index]!,
          g = bitmap[index + 1]!,
          r = bitmap[index + 2]!;
        const value = (r + g + b) / 3;
        sum += value;
        squared += (r * r + g * g + b * b) / 3;
        // Saturated brick red excludes the more neutral red of the X axis and indicator.
        if (r > 80 && r > g * 4 && r > b * 4) {
          count++;
          xTotal += x;
          yTotal += y;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    return {
      variance: squared / (width * height) - (sum / (width * height)) ** 2,
      count,
      centerX: xTotal / count / width,
      centerY: yTotal / count / height,
      brickWidth: (maxX - minX) / width,
      brickHeight: (maxY - minY) / height,
      shortSideFraction: Math.max(maxX - minX, maxY - minY) / Math.min(width, height),
    };
  }, picture.toString('base64'));
}

async function expectLayout(page: Page) {
  const layout = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.inspector-heading, .status-group, .toolbar, .ant-tree-title')];
    return {
      fits: document.body.scrollWidth <= innerWidth && document.body.scrollHeight <= innerHeight,
      clipped: items.filter((item) => item.scrollWidth > item.clientWidth + 1).map((item) => item.textContent),
      header: document.querySelector('.inspector-heading')!.getBoundingClientRect().height,
      treeHeights: [...document.querySelectorAll('.ant-tree-treenode')].map(
        (item) => item.getBoundingClientRect().height,
      ),
    };
  });
  expect(layout.fits).toBe(true);
  expect(layout.clipped).toEqual([]);
  expect(layout.header).toBe(36);
  expect(layout.treeHeights.every((height) => height === 24)).toBe(true);
  await expect(page.locator('.inspector-heading').getByText(/AI/)).toBeVisible();
  await expect(page.getByTestId('axis-indicator')).toBeVisible();
}

async function chooseProjection(page: Page, mode: '正交' | '透视') {
  await page.getByRole('menuitem', { name: '视图', exact: true }).click();
  await page.getByRole('menuitem', { name: '投影方式', exact: true }).click();
  await page.getByRole('menuitem', { name: mode, exact: true }).click();
  await expect(page.getByRole('menuitem', { name: mode, exact: true })).toBeHidden();
}

for (const fallback of [false, true]) {
  test(`3D-${fallback ? '02' : '01'} ${fallback ? 'WebGL2 回退' : '默认后端'}：取景、相机、静止渲染与布局`, async () => {
    await mkdir(dataRoot, { recursive: true });
    await mkdir(output, { recursive: true });
    const directory = await mkdtemp(path.join(dataRoot, 'viewport-'));
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    const application = await launchElectron({
      args: [...(fallback ? ['--disable-gpu', '--enable-unsafe-swiftshader'] : []), desktop],
      env: { ...env, BRICKLOOP_DATA_DIR: directory },
    });
    try {
      const page = await application.firstWindow();
      const surface = page.locator('.brickloop-viewport');
      await expect(surface).toHaveAttribute('data-render-count', /[1-9]/, { timeout: 20000 });
      await expect(page.getByRole('combobox', { name: '选择模式', exact: true })).toBeEnabled();
      const backend = await surface.getAttribute('data-backend');
      expect(['webgpu', 'webgl2']).toContain(backend);
      if (fallback) expect(backend).toBe('webgl2');
      const prefix = fallback ? 'viewport-webgl2' : 'viewport';
      await expect(page.locator('.status-bar')).toContainText('零件数 0');
      await page.getByRole('textbox', { name: '搜索零件名称或编号' }).fill('3001');
      await page.locator('[data-part-id="ld:3001"]').click();
      await expect(surface).toHaveAttribute('data-placing', 'true');
      await expect(page.locator('.preview-message')).toHaveCount(0);
      await page.getByTestId('viewport-host').click();
      await expect(surface).toHaveAttribute('data-part-count', '1');
      await page.keyboard.press('Escape');
      await expect(page.locator('.viewport-label, .panel-description')).toHaveCount(0);
      await expectLayout(page);
      await page.screenshot({ path: path.join(output, `${prefix}-1440x900.png`), scale: 'css' });

      const area = (await page.getByTestId('viewport-host').boundingBox())!;
      // Both right and middle mouse buttons pan, and fit-all restores a centered image.
      for (const button of ['right', 'middle'] as const) {
        const before = Number(await surface.getAttribute('data-render-count'));
        await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
        await page.mouse.down({ button });
        await page.mouse.move(area.x + area.width / 2 + 80, area.y + area.height / 2 + 40, { steps: 5 });
        await page.mouse.up({ button });
        await expect.poll(async () => Number(await surface.getAttribute('data-render-count'))).toBeGreaterThan(before);
      }
      await page.getByRole('menuitem', { name: '视图', exact: true }).click();
      await page.getByRole('menuitem', { name: /适配全部/ }).click();
      await expect(page.getByRole('menuitem', { name: /适配全部/ })).toBeHidden();
      const fit = await pixels(application, page, `${prefix}-fit-all.png`);
      expect(fit.variance).toBeGreaterThan(200);
      expect(fit.count).toBeGreaterThan(500);
      expect(Math.abs(fit.centerX - 0.5)).toBeLessThan(0.1);
      expect(Math.abs(fit.centerY - 0.5)).toBeLessThan(0.1);
      expect(fit.shortSideFraction).toBeGreaterThan(0.4);
      expect(fit.shortSideFraction).toBeLessThan(0.47);

      const renders = await surface.getAttribute('data-render-count');
      await page.waitForTimeout(350); // Measures an idle interval, not a rendering readiness delay.
      await expect(surface).toHaveAttribute('data-render-count', renders!);

      await chooseProjection(page, '正交');
      await expect(surface).toHaveAttribute('data-projection', 'ortho');
      const ortho = await pixels(application, page, `${prefix}-ortho.png`);
      expect(Math.abs(ortho.brickWidth - fit.brickWidth)).toBeLessThan(0.15);
      await chooseProjection(page, '透视');
      const roundtrip = await pixels(application, page, `${prefix}-perspective.png`);
      expect(Math.abs(roundtrip.brickWidth - fit.brickWidth)).toBeLessThan(0.02);

      for (const [key, preset] of [
        ['Numpad1', 'front'],
        ['Numpad3', 'right'],
        ['Numpad7', 'top'],
      ] as const) {
        await page.keyboard.press(key);
        await expect(surface).toHaveAttribute('data-preset', preset);
        const image = await pixels(application, page, `${prefix}-${preset}.png`);
        expect(image.count).toBeGreaterThan(500);
        expect(Math.abs(image.centerX - 0.5)).toBeLessThan(0.1);
        expect(Math.abs(image.centerY - 0.5)).toBeLessThan(0.1);
        expect(image.shortSideFraction).toBeGreaterThan(0.4);
        expect(image.shortSideFraction).toBeLessThan(0.47);
      }
      for (const [label, preset] of [
        ['后视图', 'back'],
        ['左视图', 'left'],
        ['底视图', 'bottom'],
        ['等轴测', 'iso'],
      ] as const) {
        await page.getByRole('menuitem', { name: '视图', exact: true }).click();
        await page.getByRole('menuitem', { name: '预设视角', exact: true }).click();
        await page.getByRole('menuitem', { name: new RegExp(label) }).click();
        await expect(surface).toHaveAttribute('data-preset', preset);
        await expect(page.getByRole('menuitem', { name: new RegExp(label) })).toBeHidden();
      }
      const beforeOrbit = Number(await surface.getAttribute('data-render-count'));
      await page.keyboard.down('Alt');
      await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
      await page.mouse.down();
      await page.mouse.move(area.x + area.width / 2 + 40, area.y + area.height / 2 + 20, { steps: 5 });
      await page.mouse.up();
      await page.keyboard.up('Alt');
      await expect
        .poll(async () => Number(await surface.getAttribute('data-render-count')))
        .toBeGreaterThan(beforeOrbit);
      const beforeZoom = Number(await surface.getAttribute('data-render-count'));
      await page.mouse.wheel(0, -120);
      await expect
        .poll(async () => Number(await surface.getAttribute('data-render-count')))
        .toBeGreaterThan(beforeZoom);
      await page.keyboard.press('Control+0');

      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1100, 700));
      await expect
        .poll(async () => (await page.getByTestId('viewport-host').boundingBox())!.width)
        .toBeLessThan(area.width);
      await page.keyboard.press('Control+0');
      await expectLayout(page);
      await page.screenshot({ path: path.join(output, `${prefix}-1100x700.png`), scale: 'css' });
      await page.getByRole('menuitem', { name: '帮助', exact: true }).click();
      await page.getByRole('menuitem', { name: '语言', exact: true }).click();
      await page.getByRole('menuitem', { name: 'English', exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'View', exact: true })).toBeVisible();
      await page.getByTestId('viewport-host').click();
      await expect(page.getByRole('menuitem', { name: 'Language', exact: true })).toBeHidden();
      await expectLayout(page);
      await page.screenshot({ path: path.join(output, `${prefix}-en-1100x700.png`), scale: 'css' });
      await writeFile(
        path.join(desktop, `../../.devdata/e2e-results/${prefix}-metrics.json`),
        JSON.stringify({ backend, fallback, fit, ortho, roundtrip, idleFrames: renders }, null, 2),
      );
      console.log(
        `Viewport backend=${backend}; variance=${fit.variance.toFixed(2)}; center=(${fit.centerX.toFixed(3)}, ${fit.centerY.toFixed(3)}); short-side=${(fit.shortSideFraction * 100).toFixed(1)}%`,
      );
    } finally {
      await (
        await application.firstWindow()
      ).evaluate(() =>
        (window as unknown as { brickloopEditorTest: { prepareClose(): void } }).brickloopEditorTest.prepareClose(),
      );
      await application.close();
      if (path.dirname(directory) === dataRoot) await rm(directory, { recursive: true, force: true });
    }
  });
}
