import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './electron-test';
import { packProject } from '../../../packages/io/src/project';
import { fakeModel, livenessSession } from './ai-model-fixture';
import { aiWriteScaleFixture } from './fixtures/ai-write-scale';

// Default e2e coverage: deterministic, offline, and small enough for the regular suite.
test('M12-14: 1500-part writes stay fast, preserve review diffs and undo the whole turn', async () => {
  test.setTimeout(180000);
  const model = await fakeModel();
  const session = await livenessSession(model.endpoint);
  const { page } = session;
  try {
    const fixture = aiWriteScaleFixture();
    const file = path.join(session.directory, 'ai-write-scale.brkl');
    await writeFile(
      file,
      packProject(fixture.document, fixture.workspace, {}, { savedAt: '2026-10-20T00:00:00.000Z' }),
    );
    await page.evaluate(async (file) => {
      await window.brickloopEditorTest.open(file);
      await window.brickloopEditorTest.meshesReady();
      await window.brickloopEditorTest.assemblyReady();
    }, file);
    const before = await page.evaluate(() => window.brickloopEditorTest.snapshot().document);
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded().length)).toBe(1500);
    const single = { instanceIds: fixture.instanceIds.slice(120, 125), colorId: 'c:black' };
    const timings = await page.evaluate(
      async ({ operations, single }) => {
        const api = window.brickloopEditorTest;
        await api.aiTool('beginTransaction', 'M12-14 scale');
        const start = performance.now();
        const batch = await api.aiTool('batch', { operations, atomic: true });
        const batchMs = performance.now() - start;
        const next = performance.now();
        const result = await api.aiTool('set_color', single);
        const singleMs = performance.now() - next;
        await api.aiTool('commitTransaction', null);
        return { batch, result, batchMs, singleMs };
      },
      { operations: fixture.operations, single },
    );
    expect(timings.batch).toMatchObject({
      ok: true,
      data: { rolledBack: false, results: fixture.operations.map(() => ({ ok: true, data: { changed: 5 } })) },
    });
    expect(timings.result).toMatchObject({ ok: true, data: { changed: 5 } });
    const changed = await page.evaluate(() => ({
      rows: window.brickloopEditorTest.expanded(),
      history: window.brickloopEditorTest.snapshot().history,
    }));
    expect(changed.rows).toHaveLength(1500);
    expect(changed.rows.filter((row) => row.colorId === 'c:black')).toHaveLength(125);
    expect(changed.history).toHaveLength(1);
    expect(changed.history[0]!.source).toBe('ai');
    await page.evaluate(() => window.brickloopEditorTest.action('edit.undo'));
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().document)).toEqual(before);

    // Identical five-instance operations early and late in one transaction. Keep
    // a modest scheduling allowance when comparing sub-second samples.
    const individual = await page.evaluate(async (operations) => {
      const api = window.brickloopEditorTest;
      await api.aiTool('beginTransaction', 'M12-14 sequential');
      const samples: number[] = [];
      const results: unknown[] = [];
      for (const operation of operations) {
        const start = performance.now();
        results.push(await api.aiTool(operation.tool, operation.arguments));
        samples.push(performance.now() - start);
      }
      const start = performance.now();
      const move = await api.aiTool('move', {
        instanceIds: operations[0]!.arguments.instanceIds,
        delta: { x: 0.5, z: 0, level: 0 },
      });
      const moveMs = performance.now() - start;
      await api.aiTool('commitTransaction', null);
      return { samples, results, move, moveMs };
    }, fixture.operations);
    for (const result of individual.results) expect(result).toMatchObject({ ok: true, data: { changed: 5 } });
    expect(individual.move).toMatchObject({ ok: true, data: { changed: 5 } });
    await page.evaluate(() => window.brickloopEditorTest.action('edit.undo'));
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().document)).toEqual(before);

    // The same workload through the real AI task/review path, using a local scripted provider.
    model.frames.push(
      { calls: [{ name: 'batch', arguments: { operations: fixture.operations, atomic: true } }] },
      { calls: [{ name: 'set_color', arguments: single }] },
      { text: 'Synthetic colour changes complete.' },
    );
    await page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill('Apply the synthetic scale fixture colours.');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByTestId('review-bar')).toBeVisible({ timeout: 60000 });
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.tasks().at(-1)?.status)).toBe('merged');
    const review = await page.evaluate(() => window.brickloopEditorTest.review());
    expect(review?.items).toHaveLength(125);
    expect(review?.items.every((item) => item.kinds.length === 1 && item.kinds[0] === 'recolored')).toBe(true);
    expect(review?.items.map((item) => item.instanceId).sort()).toEqual(fixture.instanceIds.slice(0, 125).sort());
    expect(review?.canUndo).toBe(true);
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length)).toBe(1);
    expect(
      await page.evaluate(
        () => window.brickloopEditorTest.expanded().filter((row) => row.colorId === 'c:black').length,
      ),
    ).toBe(125);
    await page.getByTestId('review-bar').getByRole('button', { name: '撤销整轮', exact: true }).click();
    expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().document)).toEqual(before);

    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    console.log(
      'M12-14 timings (ms)',
      JSON.stringify({
        batch24: timings.batchMs,
        single5: timings.singleMs,
        move5: individual.moveMs,
        first: individual.samples[0],
        last: individual.samples[23],
        samples: individual.samples,
      }),
    );
    // Wide enough for concurrent CI load, still far below the reported ~14 seconds per operation.
    expect(timings.batchMs).toBeLessThan(15000);
    expect(timings.singleMs).toBeLessThan(2000);
    expect(individual.moveMs).toBeLessThan(2000);
    expect(individual.samples[23]!).toBeLessThan(Math.max(250, individual.samples[0]! * 2));
    expect(median(individual.samples.slice(-6))).toBeLessThan(
      Math.max(250, median(individual.samples.slice(0, 6)) * 2),
    );
  } finally {
    await session.app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await session.close();
    await model.close();
  }
});
