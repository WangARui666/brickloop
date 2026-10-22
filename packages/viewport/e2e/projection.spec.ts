import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from '../../../apps/desktop/e2e/electron-test';
import { launchElectron } from '../../../apps/desktop/e2e/electron-launch';
import type { ElectronApplication, Page } from '@playwright/test';
import type { Command, InstancePath, Vec3 } from '@brickloop/core';
import type { ViewPreset } from '../src/framing';

interface TestWindow {
  brickloopEditorTest: {
    project(point: Vec3): { x: number; y: number };
    seed(count: number): Promise<void>;
    expanded(): { path: InstancePath }[];
    select(paths: InstancePath[]): void;
    enter(path: InstancePath): void;
    command(command: Command): void;
    preset(preset: ViewPreset): void;
    action(action: string): void;
    prepareClose(): void;
  };
}
const root = fileURLToPath(new URL('../../..', import.meta.url));
const desktop = path.join(root, 'apps/desktop');
const output = path.join(desktop, '../../.devdata/e2e-results/screenshots/m7-2d');

async function colors(app: ElectronApplication, page: Page, name: string) {
  await page.mouse.move(8, 8);
  const points = await page.evaluate(() =>
    [0, 100, 200, 300].map((x) => (window as unknown as TestWindow).brickloopEditorTest.project([x, -12, -20])),
  );
  const picture = await page.screenshot({ path: path.join(output, `${name}.png`), scale: 'css' });
  return app.evaluate(
    ({ nativeImage }, { data, points }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
      const { width } = image.getSize();
      const bitmap = image.toBitmap();
      return points.map((point) => {
        const rgb = [0, 0, 0];
        for (let y = -2; y <= 2; y++)
          for (let x = -2; x <= 2; x++) {
            const offset = 4 * ((Math.round(point.y) + y) * width + Math.round(point.x) + x);
            rgb[0]! += bitmap[offset + 2]! / 25;
            rgb[1]! += bitmap[offset + 1]! / 25;
            rgb[2]! += bitmap[offset]! / 25;
          }
        return rgb;
      });
    },
    { data: picture.toString('base64'), points },
  );
}

for (const fallback of [false, true])
  test(`M7-2d ${fallback ? 'WebGL2' : 'WebGPU'} axial projection, picking and context pixels`, async () => {
    test.setTimeout(180_000);
    await mkdir(path.join(root, '.devdata/e2e'), { recursive: true });
    await mkdir(output, { recursive: true });
    const directory = await mkdtemp(path.join(root, '.devdata/e2e/projection-'));
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await launchElectron({
      args: [...(fallback ? ['--disable-gpu', '--enable-unsafe-swiftshader'] : []), desktop],
      env: { ...env, BRICKLOOP_DATA_DIR: directory },
    });
    const page = await app.firstWindow();
    const surface = page.locator('.brickloop-viewport');
    try {
      await expect.poll(() => page.evaluate(() => !!(window as unknown as TestWindow).brickloopEditorTest)).toBe(true);
      await page.evaluate(async () => {
        const api = (window as unknown as TestWindow).brickloopEditorTest;
        await api.seed(4);
        const paths = api.expanded().map((row) => row.path);
        ['c:bright-red', 'c:bright-yellow', 'c:bright-blue', 'c:white'].forEach((colorId, index) => {
          api.select([paths[index]!]);
          api.command({ type: 'color.set', colorId });
        });
        api.select([]);
      });
      for (const preset of ['front', 'back', 'left', 'right', 'top', 'bottom'] as const) {
        await page.evaluate((preset) => (window as unknown as TestWindow).brickloopEditorTest.preset(preset), preset);
        await expect(surface).toHaveAttribute('data-projection', 'ortho');
        const point = await page.evaluate(() =>
          (window as unknown as TestWindow).brickloopEditorTest.project([0, -12, 0]),
        );
        await page.mouse.move(point.x, point.y);
        await expect(surface).toHaveAttribute('data-hover-path', /[0-9A-Z]{26}/);
      }
      await page.evaluate(() => (window as unknown as TestWindow).brickloopEditorTest.preset('front'));
      const point = await page.evaluate(() =>
        (window as unknown as TestWindow).brickloopEditorTest.project([100, -12, 0]),
      );
      await page.mouse.click(point.x, point.y);
      await expect(surface).toHaveAttribute('data-selected-count', '1');
      await page.mouse.wheel(0, -120);
      await expect(surface).toHaveAttribute('data-projection', 'ortho');
      await page.evaluate(() => (window as unknown as TestWindow).brickloopEditorTest.action('view.fitAll'));
      await page.evaluate(() => (window as unknown as TestWindow).brickloopEditorTest.select([]));
      const area = (await surface.boundingBox())!;
      await page.mouse.move(area.x + 10, area.y + 50);
      await page.mouse.down();
      await page.mouse.move(area.x + area.width - 10, area.y + area.height - 10, { steps: 5 });
      await page.mouse.up();
      await expect(surface).toHaveAttribute('data-selected-count', '4');
      await page.evaluate(() => (window as unknown as TestWindow).brickloopEditorTest.select([]));
      const normal = await colors(app, page, `${fallback ? 'webgl2' : 'webgpu'}-normal`);
      await page.evaluate(() => {
        (window as unknown as TestWindow).brickloopEditorTest.command({ type: 'step.add' });
        (window as unknown as TestWindow).brickloopEditorTest.action('view.steps');
      });
      await page.getByRole('slider', { name: '当前步骤' }).fill('2');
      await expect(surface).toHaveAttribute('data-step-dimmed-count', '4');
      const dimmed = await colors(app, page, `${fallback ? 'webgl2' : 'webgpu'}-dimmed`);
      const luminance = (rgb: number[]) => rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      for (let i = 0; i < 4; i++) expect(luminance(dimmed[i]!)).toBeLessThan(luminance(normal[i]!) * 0.82);
      const [red, yellow, blue, white] = dimmed;
      expect(red![0]).toBeGreaterThan(red![1]! * 1.5);
      expect(yellow![0]).toBeGreaterThan(yellow![2]! * 1.5);
      expect(yellow![1]).toBeGreaterThan(yellow![2]! * 1.5);
      expect(blue![2]).toBeGreaterThan(blue![0]! * 1.5);
      expect(Math.max(...white!) - Math.min(...white!)).toBeLessThan(45);
      await writeFile(
        path.join(output, `${fallback ? 'webgl2' : 'webgpu'}-pixels.json`),
        JSON.stringify({ normal, dimmed }, null, 2) + '\n',
      );
      await page.getByRole('button', { name: '退出逐步查看', exact: true }).click();
      await page.evaluate(() => {
        const api = (window as unknown as TestWindow).brickloopEditorTest;
        api.select([api.expanded()[3]!.path]);
        api.command({ type: 'submodel.create', name: '白色模块' });
        api.enter(api.expanded()[3]!.path.slice(0, 1));
        api.select([]);
      });
      await expect(surface).toHaveAttribute('data-step-dimmed-count', '3');
      const context = await colors(app, page, `${fallback ? 'webgl2' : 'webgpu'}-context`);
      for (let i = 0; i < 3; i++) expect(Math.abs(luminance(context[i]!) - luminance(dimmed[i]!))).toBeLessThan(3);
      expect(Math.abs(luminance(context[3]!) - luminance(normal[3]!))).toBeLessThan(3);
      await page.evaluate(() => (window as unknown as TestWindow).brickloopEditorTest.enter([]));
      await page.keyboard.down('Alt');
      await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
      await page.mouse.down();
      await page.mouse.move(area.x + area.width / 2 + 60, area.y + area.height / 2 + 20, { steps: 5 });
      await page.mouse.up();
      await page.keyboard.up('Alt');
      await expect(surface).toHaveAttribute('data-projection', 'perspective');
      await page.evaluate(() => (window as unknown as TestWindow).brickloopEditorTest.preset('iso'));
      await expect(surface).toHaveAttribute('data-projection', 'perspective');
    } finally {
      await page
        .evaluate(() => (window as unknown as TestWindow).brickloopEditorTest.prepareClose())
        .catch(() => undefined);
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
