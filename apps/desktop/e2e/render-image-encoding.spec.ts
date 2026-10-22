import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import type { ImageBlock } from '@brickloop/ai';
import { packProject } from '../../../packages/io/src/project';
import { aiWriteScaleFixture } from './fixtures/ai-write-scale';
import { guideHouseScript } from './guide-house-fixture';
import { imageModelServer } from './image-model-fixture';
import { livenessSession } from './ai-model-fixture';
import { completedReport } from './real-usage-helpers';

const baselineFile = new URL('./fixtures/render-image-encoding-baseline.json', import.meta.url);
const recording = process.env.BRICKLOOP_RECORD_RENDER_BASELINE === '1';
type Sample = { name: string; mime: string; bytes: number; sha256: string; width: number; height: number };
type Measurement = {
  scenes: { name: string; images: Sample[]; metrics: Record<string, unknown> }[];
  workflow: { requestBytes: number[]; images: Sample[][]; totalBytes: number; roundCount: number };
};

// Run this identical harness against the unchanged test build and the implementation.
// The opt-in recording mode only writes measurements, never changes application behavior.
test('M12-27: offline render encoding, exact comparison metrics and request bytes', async () => {
  test.setTimeout(300000);
  const server = await imageModelServer();
  const session = await livenessSession(server.endpoint);
  const { page } = session;
  const measurement: Measurement = {
    scenes: [],
    workflow: { requestBytes: [], images: [], totalBytes: 0, roundCount: 0 },
  };
  const samples = async (images: ImageBlock[], names: string[]) =>
    page.evaluate(
      async ({ images, names }) =>
        Promise.all(
          images.map(async (block, index) => {
            const image = new Image();
            image.src = `data:${block.mime};base64,${block.base64}`;
            await image.decode();
            const digest = await crypto.subtle.digest(
              'SHA-256',
              Uint8Array.from(atob(block.base64), (character) => character.charCodeAt(0)),
            );
            return {
              name: names[index]!,
              mime: block.mime,
              bytes: block.base64.length,
              sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
              width: image.naturalWidth,
              height: image.naturalHeight,
            };
          }),
        ),
      { images, names },
    );
  try {
    const reference = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 768;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 768, 768);
      const pixels = ctx.getImageData(0, 0, 768, 768);
      let seed = 27;
      for (let y = 150; y < 650; y++)
        for (let x = 180; x < 590; x++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const noise = (seed >>> 24) % 40;
          pixels.data.set([150 + noise, 70 + noise, 25 + noise, 255], (y * 768 + x) * 4);
        }
      ctx.putImageData(pixels, 0, 0);
      return { type: 'image' as const, mime: 'image/png' as const, base64: canvas.toDataURL().split(',')[1]! };
    });
    for (const name of ['house', '1500-parts']) {
      if (name === 'house') {
        const result = await page.evaluate(async (code) => {
          const api = window.brickloopEditorTest;
          await api.aiTool('beginTransaction', 'M12-27 house');
          const result = await api.aiTool('run_build_script', { scriptId: 'house', code, mode: 'replace' });
          await api.aiTool('commitTransaction', null);
          return result;
        }, guideHouseScript(4));
        expect(result).toMatchObject({ ok: true });
      } else {
        const fixture = aiWriteScaleFixture();
        const file = path.join(session.directory, '1500-parts.brkl');
        await writeFile(file, packProject(fixture.document, fixture.workspace, {}));
        await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
        expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(1500);
      }
      await page.evaluate(() => window.brickloopEditorTest.meshesReady());
      const result = await page.evaluate(async (reference) => {
        const api = window.brickloopEditorTest;
        await api.aiTool('beginTransaction', 'M12-27 images');
        const call = async (name: string, input: unknown) => {
          const result = (await api.aiTool(name, input)) as { ok: boolean; data: Record<string, unknown> };
          if (!result.ok) throw new Error(JSON.stringify(result));
          return result.data;
        };
        const views = await call('render_views', {
          views: ['front', 'isometric', 'left', 'top'],
          width: 768,
          height: 768,
          transparent: false,
        });
        const transparent = await call('render_views', {
          views: ['isometric'],
          width: 768,
          height: 768,
          transparent: true,
        });
        const ref = await call('add_reference_image', {
          name: 'M12-27 reference',
          image: reference,
          view: 'isometric',
        });
        const { images, comparisonImage, ...metrics } = await call('compare_to_reference', {
          referenceId: ref.referenceId,
          view: 'isometric',
        });
        await api.aiTool('commitTransaction', null);
        return {
          images: [
            ...(views.images as ImageBlock[]),
            ...(transparent.images as ImageBlock[]),
            ...(images as ImageBlock[]),
            comparisonImage as ImageBlock,
          ],
          metrics,
        };
      }, reference);
      measurement.scenes.push({
        name,
        metrics: result.metrics,
        images: await samples(result.images, [
          'front',
          'isometric',
          'left',
          'top',
          'transparent',
          'reference',
          'comparison-render',
          'composite',
        ]),
      });
      expect(result.images[4]!.mime).toBe('image/png');
      if (!recording) {
        for (const index of [1, 5, 6, 7]) expect(result.images[index]!.mime).toBe('image/jpeg');
      }
    }
    // Real look-and-build workflow using only the loopback fake provider. Round two
    // carries the preceding round's render/comparison images through the wire codec.
    await page.evaluate(() => window.brickloopEditorTest.action('file.new'));
    server.controls.guideHouse = true;
    const task = await page.evaluate(
      async ({ reference, providerId }) =>
        window.brickloopEditorTest.imageStart({
          providerId,
          model: 'offline-model',
          directStart: true,
          budget: { rounds: 6, toolCalls: 400, durationMs: 180000 },
          input: {
            description: '红顶小屋',
            viewMode: 'fixed',
            priority: 'appearance',
            images: [{ name: 'house.png', image: reference, view: 'front' }],
            targetSize: 'medium',
            palette: { source: 'factory' },
            parts: { source: 'factory' },
            style: '',
          },
        }),
      { reference, providerId: session.providerId },
    );
    expect(task).toBeTruthy();
    const report = await completedReport(page);
    expect(report.reason).toBe('completed');
    expect(report.rounds.length).toBeGreaterThanOrEqual(2);
    measurement.workflow.roundCount = report.rounds.length;
    measurement.workflow.requestBytes = server.requestBytes;
    measurement.workflow.totalBytes = server.requestBytes.reduce((a, b) => a + b, 0);
    for (const request of server.requests) {
      const images = request.messages.flatMap((message) =>
        typeof message.content === 'string'
          ? []
          : message.content.flatMap((block) => {
              const match = block.image_url?.url.match(/^data:(image\/\w+);base64,(.+)$/);
              return match ? [{ type: 'image' as const, mime: match[1] as ImageBlock['mime'], base64: match[2]! }] : [];
            }),
      );
      measurement.workflow.images.push(
        await samples(
          images,
          images.map((_, i) => String(i)),
        ),
      );
    }
    expect(server.requests.length).toBeGreaterThan(3);
    if (recording) await writeFile(baselineFile, JSON.stringify(measurement, null, 2) + '\n');
    else {
      const baseline = JSON.parse(await readFile(baselineFile, 'utf8')) as Measurement;
      for (const [index, scene] of measurement.scenes.entries()) {
        expect(scene.metrics).toEqual(baseline.scenes[index]!.metrics);
        expect(scene.images.map(({ width, height }) => [width, height])).toEqual(
          baseline.scenes[index]!.images.map(({ width, height }) => [width, height]),
        );
      }
      expect(measurement.workflow.requestBytes).toHaveLength(baseline.workflow.requestBytes.length);
      expect(measurement.workflow.totalBytes).toBeLessThanOrEqual(baseline.workflow.totalBytes * 0.6);
      const lastImages = measurement.workflow.images.at(-1)!;
      expect(lastImages.length).toBeGreaterThan(3);
      expect(lastImages[1]!.mime).toBe('image/jpeg');
      expect(lastImages[2]!.mime).toBe('image/jpeg');
    }
    console.log('M12-27 measurements', JSON.stringify(measurement));
    await writeFile(
      path.resolve('../../.devdata/tmp/m12-27-' + (recording ? 'before' : 'after') + '.json'),
      JSON.stringify(measurement, null, 2) + '\n',
    );
  } finally {
    await session.close();
    await server.close();
  }
});
