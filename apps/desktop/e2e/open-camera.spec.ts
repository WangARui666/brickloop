import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import type { ElectronApplication, Page } from '@playwright/test';
import { createDocument, createWorkspace, ulid } from '@brickloop/core';
import type { Workspace } from '@brickloop/core';
import { packProject } from '../../../packages/io/src/project';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { launchElectron } from './electron-launch';
import type { EditorTestApi } from '../src/renderer/src/editor-test-api';

declare global {
  interface Window {
    brickloopEditorTest: EditorTestApi;
  }
}
const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataRoot = path.resolve(desktop, '../../.devdata/e2e');
const savedCamera: Workspace['camera'] & { span: number } = {
  mode: 'ortho',
  position: [0, -12, 0],
  target: [0, -12, 7450],
  up: [0, -1, 0],
  fov: 35,
  span: 6000,
};
type Fixture = 'saved' | 'default' | 'missing' | 'corrupt' | 'offscreen';

async function fixture(directory: string, kind: Fixture, suffix = '') {
  const doc = createDocument({ title: `${kind}${suffix}` });
  const model = doc.models[doc.rootModelId]!;
  for (let index = 0; index < 900; index++) {
    const id = ulid();
    model.instances[id] = {
      id,
      ref: { kind: 'part', partId: 'ld:3001' },
      colorId: 'c:bright-red',
      transform: [((index % 30) - 15) * 100, 0, 6000 + Math.floor(index / 30) * 100, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      stepId: model.stepIds[0]!,
      groupId: null,
    };
    model.steps[model.stepIds[0]!]!.instanceIds.push(id);
  }
  const workspace = createWorkspace();
  if (kind === 'saved') workspace.camera = savedCamera;
  if (kind === 'offscreen')
    workspace.camera = {
      ...savedCamera,
      position: [100000, -12, 0],
      target: [100000, -12, 7450],
    };
  let bytes = packProject(doc, workspace);
  if (kind === 'missing' || kind === 'corrupt') {
    const members = unzipSync(bytes);
    if (kind === 'missing') delete members['workspace.json'];
    else members['workspace.json'] = strToU8('{broken');
    bytes = zipSync(members);
  }
  const file = path.join(directory, `${kind}${suffix}.brkl`);
  await writeFile(file, bytes);
  return file;
}

async function launch(directory: string, files: string[] = []) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron({
    args: [desktop, ...files],
    env: { ...env, BRICKLOOP_DATA_DIR: directory },
    timeout: 30_000,
  });
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => !!window.brickloopEditorTest)).toBe(true);
    await expect(page.locator('[data-library-ready]')).toHaveAttribute('data-library-ready', 'true', {
      timeout: 45_000,
    });
    return { app, page };
  } catch (error) {
    await app.close();
    throw error;
  }
}
async function stop(app: ElectronApplication) {
  const page = await app.firstWindow();
  if (!page.isClosed())
    await page.evaluate(() => {
      window.brickloopEditorTest.releaseMeshes();
      window.brickloopEditorTest.prepareClose();
    });
  await app.close();
}
async function ready(page: Page) {
  await page.evaluate(() => window.brickloopEditorTest.meshesReady());
  await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.openingCamera().pending)).toBeNull();
  expect((await page.evaluate(() => window.brickloopEditorTest.snapshot())).state.missingMeshes).toEqual([]);
}
async function expectCamera(page: Page, expected = savedCamera) {
  const camera = await page.evaluate(() => window.brickloopEditorTest.camera());
  expect(camera.mode).toBe(expected.mode);
  for (const key of ['position', 'target', 'up'] as const)
    camera[key].forEach((value, index) => expect(value).toBeCloseTo(expected[key][index]!, 3));
  expect(camera.span).toBeCloseTo(expected.span, 3);
  expect(camera.fov).toBeCloseTo(expected.fov, 3);
}
async function expectFit(page: Page) {
  const visibility = await page.evaluate(() => window.brickloopEditorTest.cameraVisibility());
  expect(visibility).toMatchObject({ intersects: true, contained: true });
  const rect = await page.locator('.brickloop-viewport > canvas').boundingBox();
  const camera = await page.evaluate(() => window.brickloopEditorTest.camera());
  // The existing iso fit uses 45% of the viewport's short side. Require at least 40%.
  expect(
    Math.max(visibility!.width * rect!.width, visibility!.height * rect!.height) / Math.min(rect!.width, rect!.height),
    JSON.stringify({ visibility, rect, camera }),
  ).toBeGreaterThanOrEqual(0.4);
  expect(camera.mode).toBe('perspective');
  expect(camera.fov).toBe(35);
  const direction = camera.position.map((value, index) => value - camera.target[index]!);
  expect(direction[0]).toBeGreaterThan(0);
  expect(direction[1]).toBeCloseTo(-direction[0]!, 3);
  expect(direction[2]).toBeCloseTo(-direction[0]!, 3);
}
async function withDirectory(action: (directory: string) => Promise<void>) {
  await mkdir(dataRoot, { recursive: true });
  const directory = await mkdtemp(path.join(dataRoot, 'open-camera-'));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('P06(a)(b)(c): saved camera, default/missing/corrupt workspace, offscreen camera and tab switching', async () => {
  test.setTimeout(120_000);
  await withDirectory(async (directory) => {
    const { app, page } = await launch(path.join(directory, 'user'));
    try {
      const ids: string[] = [];
      for (const kind of ['saved', 'default', 'missing', 'corrupt', 'offscreen'] as const) {
        const file = await fixture(directory, kind);
        await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
        await ready(page);
        if (kind === 'saved') {
          await expectCamera(page);
          // This fixture is entirely beyond the far plane computed before meshes arrive.
          expect(await page.evaluate(() => window.brickloopEditorTest.cameraVisibility())).toMatchObject({
            contained: true,
          });
        } else await expectFit(page);
        ids.push((await page.evaluate(() => window.brickloopEditorTest.snapshot())).document.documentId);
        // Reports for the deliberately damaged workspace do not block the next test open.
        const ok = page.getByRole('dialog').getByRole('button', { name: '确定', exact: true });
        if (await ok.count()) await ok.click();
      }
      await page.evaluate(() => window.brickloopEditorTest.preset('top'));
      const moved = await page.evaluate(() => window.brickloopEditorTest.camera());
      await page.evaluate((id) => window.brickloopEditorTest.switch(id), ids[0]!);
      await ready(page);
      await expectCamera(page);
      await page.evaluate((id) => window.brickloopEditorTest.switch(id), ids.at(-1)!);
      await ready(page);
      await expectCamera(page, moved);
    } finally {
      await stop(app);
    }
  });
});

for (const kind of ['saved', 'default', 'missing'] as const)
  test(`P06(d): first launch in an empty user directory, ${kind} project in launch arguments`, async () => {
    test.setTimeout(90_000);
    await withDirectory(async (directory) => {
      const file = await fixture(directory, kind);
      const { app, page } = await launch(path.join(directory, 'new-user'), [file]);
      try {
        await expect
          .poll(() => page.evaluate(() => window.brickloopEditorTest.snapshot().document.meta.title))
          .toBe(kind);
        await ready(page);
        if (kind === 'saved') await expectCamera(page);
        else await expectFit(page);
      } finally {
        await stop(app);
      }
    });
  });

test('P06(d): binding a viewport after the project and meshes exist restores or fits the active tab', async () => {
  test.setTimeout(90_000);
  await withDirectory(async (directory) => {
    const { app, page } = await launch(path.join(directory, 'user'));
    try {
      for (const kind of ['saved', 'default'] as const) {
        await page.evaluate(() => window.brickloopEditorTest.bindCameraViewport(false));
        await page.evaluate((file) => window.brickloopEditorTest.open(file), await fixture(directory, kind));
        await page.evaluate(() => window.brickloopEditorTest.meshesReady());
        expect(await page.evaluate(() => window.brickloopEditorTest.openingCamera().pending?.meshesReady)).toBe(true);
        await page.evaluate(() => window.brickloopEditorTest.bindCameraViewport(true));
        await ready(page);
        if (kind === 'saved') await expectCamera(page);
        else await expectFit(page);
      }
    } finally {
      await stop(app);
    }
  });
});

test('P06(e): rotation, pan, zoom, presets and Ctrl+0 during mesh loading cancel automatic camera changes', async () => {
  test.setTimeout(120_000);
  await withDirectory(async (directory) => {
    const { app, page } = await launch(path.join(directory, 'user'));
    try {
      for (const gesture of ['rotate', 'pan', 'zoom', 'preset', 'fit'] as const) {
        await page.evaluate(() => window.brickloopEditorTest.holdMeshes());
        await page.evaluate(
          (file) => window.brickloopEditorTest.open(file),
          await fixture(directory, gesture === 'zoom' ? 'offscreen' : 'default', gesture),
        );
        await expect
          .poll(() => page.evaluate(() => window.brickloopEditorTest.openingCamera().waitingMeshes))
          .toBeGreaterThan(0);
        const rect = (await page.locator('.brickloop-viewport > canvas').boundingBox())!;
        const x = rect.x + rect.width / 2,
          y = rect.y + rect.height / 2;
        await page.mouse.move(x, y);
        if (gesture === 'rotate' || gesture === 'pan') {
          if (gesture === 'rotate') await page.keyboard.down('Alt');
          await page.mouse.down({ button: gesture === 'pan' ? 'right' : 'left' });
          await page.mouse.move(x + 70, y + 30, { steps: 6 });
          await page.mouse.up({ button: gesture === 'pan' ? 'right' : 'left' });
          if (gesture === 'rotate') await page.keyboard.up('Alt');
        } else if (gesture === 'zoom') await page.mouse.wheel(0, -240);
        else if (gesture === 'preset') await page.evaluate(() => window.brickloopEditorTest.preset('front'));
        else {
          await page.locator('.document-title').click();
          await page.keyboard.press('Control+0');
        }
        await expect
          .poll(() => page.evaluate(() => window.brickloopEditorTest.openingCamera().pending?.touched ?? true))
          .toBe(true);
        const touched = await page.evaluate(() => window.brickloopEditorTest.camera());
        await page.evaluate(() => window.brickloopEditorTest.releaseMeshes());
        await ready(page);
        await expectCamera(page, touched);
      }
    } finally {
      await stop(app);
    }
  });
});

test('A-96: multi-open imports fit on first activation, background loading does not move the active camera', async () => {
  test.setTimeout(90_000);
  await withDirectory(async (directory) => {
    const files: string[] = [];
    const ldraw =
      '0 FILE model.ldr\n0 Camera import fixture\n' +
      Array.from(
        { length: 100 },
        (_, i) => `1 4 ${(i % 10) * 100} 0 ${6000 + Math.floor(i / 10) * 100} 1 0 0 0 1 0 0 0 1 3001.dat`,
      ).join('\n');
    for (const extension of ['ldr', 'mpd', 'io']) {
      const file = path.join(directory, `import.${extension}`);
      await writeFile(file, extension === 'io' ? zipSync({ 'model.ldr': strToU8(ldraw) }) : ldraw);
      files.push(file);
    }
    const { app, page } = await launch(path.join(directory, 'user'));
    try {
      await page.evaluate(() => window.brickloopEditorTest.holdMeshes());
      await app.evaluate(({ dialog }, files) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
      }, files);
      await page.evaluate(() => window.brickloopEditorTest.open());
      const ids = (await page.evaluate(() => window.brickloopEditorTest.snapshot())).state.tabs.map((tab) => tab.id);
      expect(ids).toHaveLength(3);
      await page.evaluate(() => window.brickloopEditorTest.preset('top'));
      const touched = await page.evaluate(() => window.brickloopEditorTest.camera());
      await page.evaluate(() => window.brickloopEditorTest.releaseMeshes());
      await ready(page);
      await expectCamera(page, touched);
      for (const id of ids.slice(0, 2)) {
        await page.evaluate((id) => window.brickloopEditorTest.switch(id), id);
        await ready(page);
        await expectFit(page);
      }
      await page.evaluate((id) => window.brickloopEditorTest.switch(id), ids[2]!);
      await ready(page);
      await expectCamera(page, touched);
    } finally {
      await stop(app);
    }
  });
});
