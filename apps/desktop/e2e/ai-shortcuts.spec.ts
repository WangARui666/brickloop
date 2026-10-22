import { expect } from '@playwright/test';
import { test } from './electron-test';
import type { Page } from '@playwright/test';
import type { ToolResult } from '@brickloop/ai';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { packProject } from '../../../packages/io/src/project';
import { shortcutStatisticsFixture } from './fixtures/ai-shortcut-statistics';
import { fakeModel, shortcutResponse } from './ai-model-fixture';
import type { ModelRequest } from './ai-model-fixture';
import { imageModelServer } from './image-model-fixture';
import {
  usageSession,
  launchUsage,
  closeUsage,
  cleanupUsage,
  reference,
  planAndStart,
  finishImageFlow,
  shot,
} from './real-usage-helpers';

async function seedProblems(page: Page) {
  return page.evaluate(async () => {
    const api = window.brickloopEditorTest;
    const catalog = await window.brickloop.assemblyCatalog();
    const factory = new Set(catalog.parts.filter((p) => p.factory).map((p) => p.id));
    const candidates = await window.brickloop.catalogSearch('3001', { includeAll: true });
    const nonFactory = candidates.find((p) => !factory.has(p.id) && p.id !== 'ld:3001');
    if (!nonFactory) throw new Error('Missing synthetic non-factory fixture part');
    const colors = await window.brickloop.catalogColors();
    const supported = catalog.parts.find((p) => p.id === 'ld:3001')!.colors;
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const distance = (hex: string) => rgb(hex).reduce((sum, v, i) => sum + (v - [201, 26, 9][i]!) ** 2, 0);
    const shades = colors.factory
      .filter((c) => supported.includes(c.id))
      .sort((a, b) => distance(a.rgb) - distance(b.rgb))
      .slice(0, 6);
    const nonColor = colors.all.find((c) => !catalog.colors.includes(c.id));
    if (shades.length !== 6 || !nonColor) throw new Error('Missing synthetic color fixtures');
    const positions = [
      [0, -24, 0],
      [10, -24, 0],
      [200, -24, 0],
      [210, -24, 0],
      [0, -160, 200],
    ];
    for (let i = 0; i < 15; i++) {
      const [x, y, z] = positions[i] ?? [400 + i * 100, -24, 0];
      if (
        !api.command({
          type: 'part.add',
          partId: i === 5 ? nonFactory.id : 'ld:3001',
          colorId: i === 6 ? nonColor.id : i >= 7 ? shades[(i - 7) % 6]!.id : 'c:bright-red',
          transform: [x!, y!, z!, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        })
      )
        throw new Error('Seed failed');
    }
    await api.meshesReady();
    const initial = api.expanded();
    api.select(initial.slice(-2).map((r) => r.path));
    if (!api.command({ type: 'submodel.create', name: '外围展示台' })) throw new Error('Submodel fixture failed');
    api.select(
      api
        .expanded()
        .slice(0, 13)
        .map((r) => r.path),
    );
    await api.meshesReady();
    await api.assemblyReady();
    api.action('view.fitAll');
    return {
      rows: api.expanded(),
      selected: api.snapshot().workspace.selection,
      factory: [...factory],
      colors: catalog.colors,
    };
  });
}
async function validate(page: Page) {
  const result = (await page.evaluate(() => window.brickloopEditorTest.aiTool('validate', {}))) as ToolResult;
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return (result.data as { issues: { kind: string; paths: string[][] }[] }).issues;
}
const labels = { repair: '检查并修复', factory: '换成工厂件', palette: '统一配色', explain: '解释模型' };
for (const key of ['repair', 'factory'] as const) {
  for (const scope of ['document', 'selection'] as const) {
    test(`M12-23 clean ${key} / ${scope}: local turn sends zero requests`, async () => {
      const model = await fakeModel();
      const session = await usageSession(model.endpoint);
      const { page } = session;
      try {
        await page.evaluate(async (scope) => {
          const api = window.brickloopEditorTest;
          await api.seed(1);
          api.select(scope === 'selection' ? [api.expanded()[0]!.path] : []);
        }, scope);
        expect(await validate(page)).toEqual([]);
        await page.getByRole('button', { name: labels[key], exact: true }).click();
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await expect(page.locator('.ai-turn')).toContainText('本地检查，未调用模型');
        await expect(page.locator('.ai-turn')).toContainText(scope === 'selection' ? '选中 1 件' : '整个文档');
        expect(model.requests).toHaveLength(0);
        const state = await page.evaluate(() => ({
          turns: window.brickloopEditorTest.aiState().turns,
          tasks: window.brickloopEditorTest.tasks(),
        }));
        expect(state.tasks).toEqual([]);
        expect(state.turns.at(-1)?.local?.shortcut).toBe(key);
        expect(state.turns.at(-1)?.result?.cost.amount).toBe(0);
        expect(state.turns.at(-1)?.result?.usage.outputTokens).toBe(0);
      } finally {
        await closeUsage(session.app);
        await model.close();
        await cleanupUsage(session.directory);
      }
    });
  }
  test(`M12-23 ${key}: ignores problems outside the selected submodel`, async () => {
    test.setTimeout(120000);
    const model = await fakeModel();
    const session = await usageSession(model.endpoint);
    try {
      const fixture = await seedProblems(session.page);
      expect((await validate(session.page)).length).toBeGreaterThan(0);
      const selected = fixture.rows.at(-1)!.path.slice(0, -1);
      expect(selected.length).toBeGreaterThan(0);
      await session.page.evaluate((selected) => window.brickloopEditorTest.select([selected]), selected);
      await session.page.getByRole('button', { name: labels[key], exact: true }).click();
      await session.page.getByRole('button', { name: '发送', exact: true }).click();
      await expect(session.page.locator('.ai-turn')).toContainText('本地检查，未调用模型');
      expect(model.requests).toHaveLength(0);
      expect(
        await session.page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)?.local?.paths),
      ).toEqual([selected]);
    } finally {
      await closeUsage(session.app);
      await model.close();
      await cleanupUsage(session.directory);
    }
  });
}

for (const scenario of ['edited', 'edited-back', 'failure'] as const) {
  test(`M12-23 ${scenario}: falls through to the model`, async () => {
    const model = await fakeModel();
    const session = await usageSession(model.endpoint);
    const { page } = session;
    try {
      await page.evaluate(() => window.brickloopEditorTest.seed(1));
      model.frames.push({ text: '已由模型检查。' });
      await page.getByRole('button', { name: '检查并修复', exact: true }).click();
      if (scenario === 'failure')
        await page.evaluate(() => sessionStorage.setItem('brickloop:test:precheck-failure', '1'));
      else {
        const input = page.getByRole('textbox', { name: '给 AI 助手的消息', exact: true });
        const original = await input.inputValue();
        await input.fill(original + ' 请再次核对。');
        if (scenario === 'edited-back') await input.fill(original);
      }
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(() => model.requests.length).toBeGreaterThan(0);
      await expect
        .poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)?.result?.reason))
        .toBe('completed');
      expect(await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)?.local)).toBeUndefined();
    } finally {
      await closeUsage(session.app);
      await model.close();
      await cleanupUsage(session.directory);
    }
  });
}

test('M12-23 local history survives save/reopen, enters context and rechecks the original scope', async () => {
  test.setTimeout(120000);
  const model = await fakeModel();
  const session = await usageSession(model.endpoint);
  let { app, page } = session;
  try {
    const rows = await page.evaluate(async () => {
      const api = window.brickloopEditorTest;
      await api.seed(2);
      const rows = api.expanded();
      api.select([rows[0]!.path]);
      return rows;
    });
    await page.getByRole('button', { name: '换成工厂件', exact: true }).click();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.ai-turn')).toContainText('本地检查，未调用模型');
    expect(model.requests).toHaveLength(0);
    const original = await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)!);
    const file = path.join(session.directory, 'local-history.brkl');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, file);
    await page.evaluate(() => window.brickloopEditorTest.save(true));
    const saved = unzipSync(await readFile(file));
    expect(JSON.parse(new TextDecoder().decode(saved['ai/history.jsonl']).trim())).toEqual(original);
    await page.evaluate(() => window.brickloopEditorTest.flush());
    await closeUsage(app);
    ({ app, page } = await launchUsage(session.directory));
    // closeUsage exits directly. Discard its recovery snapshot so this test
    // restores the saved project file, not the crash-recovery copy.
    const recovery = page.getByRole('dialog', { name: '恢复未保存的文档' });
    await expect(recovery).toContainText('local-history');
    await recovery.getByRole('button', { name: '丢弃', exact: true }).click();
    await expect(recovery).toBeHidden();
    await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
    await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
    await expect(page.locator('.ai-turn')).toContainText('本地检查，未调用模型');
    expect(await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1))).toEqual(original);
    expect(model.requests).toHaveLength(0);
    await page.evaluate((path) => window.brickloopEditorTest.select([path]), rows[1]!.path);
    model.frames.push(
      {
        calls: [{ name: 'set_color', arguments: { instanceIds: [rows[1]!.path.at(-1)], colorId: 'c:bright-yellow' } }],
      },
      { text: '保留原选区范围。' },
    );
    await page.getByRole('button', { name: '让 AI 再检查一次', exact: true }).click();
    await expect.poll(() => model.requests.length).toBeGreaterThanOrEqual(2);
    const request = model.requests[0] as ModelRequest;
    expect(request.messages).toContainEqual({
      role: 'assistant',
      content: [{ type: 'text', text: original.text }],
    });
    expect(request.messages).toContainEqual({
      role: 'user',
      content: [{ type: 'text', text: original.user }],
    });
    expect(JSON.stringify(model.requests[1])).toContain('OUT_OF_SCOPE');
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded())).toEqual(rows);
  } finally {
    await closeUsage(app);
    await model.close();
    await cleanupUsage(session.directory);
  }
});

test('M12-23 history disabled: local result stays visible but is absent after save/reopen', async () => {
  test.setTimeout(120000);
  const model = await fakeModel();
  const session = await usageSession(model.endpoint);
  let { app, page } = session;
  try {
    await page.getByRole('button', { name: 'AI 设置', exact: true }).click();
    const history = page.getByRole('checkbox', { name: '将对话记录保存在工程中', exact: true });
    await expect(history).toBeChecked();
    await history.click();
    await expect
      .poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().snapshot?.settings.history))
      .toBe(false);
    await expect(history).not.toBeChecked();
    await page
      .locator('.ai-settings-modal .ant-modal-footer')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await expect(page.locator('.ai-settings-modal')).toBeHidden();
    await page.evaluate(async () => {
      const api = window.brickloopEditorTest;
      await api.seed(1);
      api.select([]);
    });
    expect(await validate(page)).toEqual([]);
    await page.getByRole('button', { name: '换成工厂件', exact: true }).click();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.ai-turn')).toContainText('本地检查，未调用模型');
    expect(model.requests).toHaveLength(0);
    const turn = await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)!);
    expect(turn.local?.shortcut).toBe('factory');
    expect(await page.evaluate((id) => window.brickloopEditorTest.savedHistory(id), turn.documentId!)).toBe('');
    const file = path.join(session.directory, 'local-history-disabled.brkl');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, file);
    await page.evaluate(() => window.brickloopEditorTest.save(true));
    expect(unzipSync(await readFile(file))['ai/history.jsonl']).toBeUndefined();
    await page.evaluate(() => window.brickloopEditorTest.flush());
    await closeUsage(app);
    ({ app, page } = await launchUsage(session.directory));
    const recovery = page.getByRole('dialog', { name: '恢复未保存的文档' });
    await expect(recovery).toContainText('local-history-disabled');
    await recovery.getByRole('button', { name: '丢弃', exact: true }).click();
    await expect(recovery).toBeHidden();
    await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
    await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
    await expect(page.locator('.ai-panel')).toBeVisible();
    await expect(page.locator('.ai-turn')).toHaveCount(0);
    expect(await page.evaluate(() => window.brickloopEditorTest.aiState().turns)).toEqual([]);
    expect(await page.evaluate(() => window.brickloopEditorTest.aiState().snapshot?.settings.history)).toBe(false);
    expect(model.requests).toHaveLength(0);
  } finally {
    await closeUsage(app);
    await model.close();
    await cleanupUsage(session.directory);
  }
});

test('M12-5 selection tag enforces scope even when the model targets an unselected instance', async () => {
  test.setTimeout(120000);
  const model = await fakeModel();
  const session = await usageSession(model.endpoint);
  const { page } = session;
  try {
    const rows = await page.evaluate(async () => {
      const api = window.brickloopEditorTest;
      await api.seed(2);
      const rows = api.expanded();
      api.select([rows[0]!.path]);
      return rows;
    });
    model.frames.push(
      {
        calls: [{ name: 'set_color', arguments: { instanceIds: [rows[1]!.path.at(-1)], colorId: 'c:bright-yellow' } }],
      },
      { text: '选区外的请求被拒绝，保留原模型。' },
    );
    await page.getByRole('button', { name: '统一配色', exact: true }).click();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.ai-turn')).toContainText('无需统一，未调用模型');
    expect(model.requests).toHaveLength(0);
    await page.getByRole('button', { name: '让 AI 再检查一次', exact: true }).click();
    await expect.poll(() => model.requests.length).toBe(2);
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
    expect(JSON.stringify(model.requests[1])).toContain('OUT_OF_SCOPE');
    expect(await page.evaluate(() => window.brickloopEditorTest.expanded())).toEqual(rows);
    await expect(page.getByTestId('review-bar')).toHaveCount(0);
  } finally {
    await closeUsage(session.app);
    await model.close();
    await cleanupUsage(session.directory);
  }
});

async function seedStatistics(page: Page) {
  return page.evaluate(async () => {
    const api = window.brickloopEditorTest;
    for (const [index, colorId] of ['c:bright-red', 'c:bright-blue', 'c:bright-yellow'].entries()) {
      if (
        !api.command({
          type: 'part.add',
          partId: 'ld:3001',
          colorId,
          transform: [index * 100, -24, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        })
      )
        throw new Error('Statistics fixture failed');
    }
    await api.meshesReady();
    api.select(
      api
        .expanded()
        .slice(0, 2)
        .map((row) => row.path),
    );
    if (!api.command({ type: 'submodel.create', name: '双色模块' })) throw new Error('Submodel fixture failed');
    await api.meshesReady();
    const rows = api.expanded();
    const selected = rows.find((row) => row.path.length > 1)!.path.slice(0, -1);
    api.select([selected]);
    return { rows, selected };
  });
}

function splitLocalStatistics(user: string) {
  return { attachment: user.match(/\n\n<local-statistics>\n([\s\S]*)\n<\/local-statistics>$/)?.[1] };
}

function requestedText(value: unknown): string {
  const request = value as ModelRequest;
  const content = request.messages.filter((message) => message.role === 'user').at(-1)!.content;
  return typeof content === 'string'
    ? content
    : (content as { type: string; text?: string }[]).find((block) => block.type === 'text')!.text!;
}
function attachmentData(user: string) {
  const body = splitLocalStatistics(user).attachment!;
  expect(body).toContain('以下是本地统计，已与当前文档一致；除非需要更多细节，不必再调用工具取同样的数据');
  return JSON.parse(body.slice(body.indexOf('\n') + 1)) as {
    colorCount: number;
    colors: {
      id: string;
      name: string;
      count: number;
      factory: boolean;
      distribution: { modelPath: string[]; count: number }[];
      omittedDistribution: number;
    }[];
    summary: { partCount: number; colorCount: number };
    submodels: { path: string[]; name: string; partCount: number; colorCount: number }[];
    parts: { id: string; name: string; count: number }[];
  };
}

async function recordStatistics(page: Page, fixture: string) {
  const measurement = await page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem('brickloop:test:statistics-result')!) as {
        shortcut: string;
        scope: string;
        elapsedMs: number;
        summarizeCalls: number;
        attached: boolean;
      },
  );
  console.log('M12-28b statistics:', JSON.stringify({ fixture, ...measurement }));
  await test.info().attach(`M12-28b-${fixture}-${measurement.shortcut}-${measurement.scope}-timing`, {
    body: JSON.stringify({ fixture, ...measurement }, null, 2),
    contentType: 'application/json',
  });
  return measurement;
}

for (const scope of ['document', 'selection', 'empty'] as const) {
  test(`M12-28 palette ${scope}: local turn makes zero model requests`, async () => {
    const model = await fakeModel();
    const session = await usageSession(model.endpoint);
    const { page } = session;
    try {
      await page.evaluate(async (scope) => {
        const api = window.brickloopEditorTest;
        if (scope === 'empty') return;
        await api.seed(2);
        const paths = api.expanded().map((row) => row.path);
        api.select(paths);
        api.command({ type: 'color.set', colorId: 'c:bright-red' });
        if (scope === 'selection') {
          api.select([paths[1]!]);
          api.command({ type: 'color.set', colorId: 'c:bright-blue' });
        }
        api.select(scope === 'selection' ? [paths[0]!] : []);
      }, scope);
      await page.getByRole('button', { name: '统一配色', exact: true }).click();
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect(page.locator('.ai-turn')).toContainText('无需统一，未调用模型');
      await expect(page.locator('.ai-turn')).toContainText(`颜色数：${scope === 'empty' ? 0 : 1}`);
      await expect(page.locator('.ai-turn')).toContainText(scope === 'selection' ? '选中 1 件' : '整个文档');
      expect(model.requests).toHaveLength(0);
      expect(await page.evaluate(() => window.brickloopEditorTest.tasks())).toEqual([]);
      await expect(page.getByRole('button', { name: '让 AI 再检查一次', exact: true })).toBeVisible();
    } finally {
      await closeUsage(session.app);
      await model.close();
      await cleanupUsage(session.directory);
    }
  });
}

for (const key of ['palette', 'explain'] as const) {
  for (const scope of ['document', 'selection'] as const) {
    test(`M12-28 ${key} / ${scope}: first request contains scoped local statistics`, async () => {
      test.setTimeout(120000);
      const model = await fakeModel();
      const session = await usageSession(model.endpoint);
      const { page } = session;
      try {
        const fixture = await seedStatistics(page);
        if (scope === 'document')
          await page.locator('.ai-context .ant-tag').first().locator('.ant-tag-close-icon').click();
        model.frames.push({ text: '已收到本地统计。' });
        await page.getByRole('button', { name: labels[key], exact: true }).click();
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await expect.poll(() => model.requests.length).toBe(1);
        await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
        const user = requestedText(model.requests[0]!);
        const measurement = await recordStatistics(page, '3-parts-1-submodel');
        expect(measurement.summarizeCalls).toBe(0);
        expect(measurement.attached).toBe(true);
        expect(measurement.elapsedMs).toBeLessThan(1000);
        const data = attachmentData(user);
        const count = scope === 'selection' ? 2 : 3;
        if (key === 'palette') {
          expect(data.colorCount).toBe(count);
          expect(data.colors).toHaveLength(count);
          expect(data.colors.every((color) => color.count === 1 && color.factory && color.name)).toBe(true);
          expect(data.colors.some((color) => color.id === 'c:bright-yellow')).toBe(scope === 'document');
          for (const color of data.colors) {
            expect(color.distribution).toEqual([
              { modelPath: color.id === 'c:bright-yellow' ? [] : fixture.selected, count: 1 },
            ]);
            expect(color.omittedDistribution).toBe(0);
          }
          expect(user).toContain('replace_color(fromColorId, toColorId, modelPath)');
          if (scope === 'selection') {
            expect(user).toContain('范围锁');
            expect(user).toContain('batch');
            expect(user).toContain('set_color');
          }
        } else {
          expect(data.summary).toEqual({ partCount: count, colorCount: count });
          expect(data).not.toHaveProperty('boundsUnits');
          expect(user).toContain('Host-provided model summary');
          // The actual outgoing system prompt contains whole-document bounds even for a selection.
          const system = (model.requests[0] as ModelRequest).messages.find((message) => message.role === 'system')!;
          const summary = JSON.parse(String(system.content).split('Host-provided model summary:\n')[1]!) as {
            partCount: number;
            colorCount: number;
            bounds: { min: unknown; max: unknown };
          };
          expect(summary).toMatchObject({
            partCount: 3,
            colorCount: 3,
            bounds: { min: expect.any(Object), max: expect.any(Object) },
          });
          expect(data.submodels).toEqual([{ path: fixture.selected, name: '双色模块', partCount: 2, colorCount: 2 }]);
          expect(data.parts).toEqual([{ id: 'ld:3001', name: expect.any(String), count }]);
        }
        const tag = page.locator('.ai-user details');
        await expect(tag).toContainText('已附本地统计');
        await expect(tag.locator('pre')).toBeHidden();
        await tag.locator('summary').click();
        await expect(tag.locator('pre')).toHaveText(splitLocalStatistics(user).attachment!);
        const turn = await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)!);
        const saved = await page.evaluate((id) => window.brickloopEditorTest.savedHistory(id), turn.documentId!);
        expect(JSON.parse(saved.trim()).user).toBe(user);
        expect(turn.user).toBe(user);
        await test.info().attach(`M12-28b-${key}-${scope}-actual-request`, { body: user, contentType: 'text/plain' });
      } finally {
        await closeUsage(session.app);
        await model.close();
        await cleanupUsage(session.directory);
      }
    });
  }
}

test('M12-28b send shows loading while preparing statistics and fails open after one second', async () => {
  test.setTimeout(120000);
  const model = await fakeModel();
  const session = await usageSession(model.endpoint);
  const { page } = session;
  try {
    await seedStatistics(page);
    for (const delay of [600, 5000]) {
      await page.evaluate(
        (delay) => sessionStorage.setItem('brickloop:test:statistics-delay-ms', String(delay)),
        delay,
      );
      const before = model.requests.length;
      model.frames.push({ text: '加载状态验收。' });
      await page.getByRole('button', { name: '统一配色', exact: true }).click();
      const send = page.locator('.ai-composer-actions .ant-btn-primary');
      await send.click();
      await expect(send).toHaveClass(/ant-btn-loading/);
      expect(model.requests).toHaveLength(before);
      await expect.poll(() => model.requests.length).toBe(before + 1);
      await expect(send).not.toHaveClass(/ant-btn-loading/);
      await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
      const measurement = await recordStatistics(page, `delay-${delay}`);
      expect(measurement.attached).toBe(delay === 600);
      expect(measurement.summarizeCalls).toBe(0);
      expect(measurement.elapsedMs).toBeLessThan(5000);
      expect(requestedText(model.requests.at(-1))).toContain(delay === 600 ? '<local-statistics>' : '检查当前配色');
      if (delay === 5000) expect(requestedText(model.requests.at(-1))).not.toContain('<local-statistics>');
    }
  } finally {
    await closeUsage(session.app);
    await model.close();
    await cleanupUsage(session.directory);
  }
});

test('M12-28b measures real statistics on 2601 parts and 17 submodels', async () => {
  test.setTimeout(180000);
  const model = await fakeModel();
  const session = await usageSession(model.endpoint);
  const { page } = session;
  try {
    const fixture = shortcutStatisticsFixture();
    const file = path.join(session.directory, 'statistics-scale.brkl');
    await writeFile(file, packProject(fixture.document, fixture.workspace));
    await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
    await page.evaluate(() => window.brickloopEditorTest.meshesReady());
    // The first attachment must arrive without warming the geometry summary cache.
    model.frames.push({ text: '首次统计测量完成。' });
    await page.getByRole('button', { name: '解释模型', exact: true }).click();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => model.requests.length).toBe(1);
    await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
    const cold = await recordStatistics(page, '2601-parts-17-submodels-first');
    expect(cold.summarizeCalls).toBe(0);
    expect(cold.attached).toBe(true);
    expect(cold.elapsedMs).toBeLessThan(1000);
    const firstUser = requestedText(model.requests[0]);
    const firstData = attachmentData(firstUser);
    expect(firstData.summary).toEqual({ partCount: 2601, colorCount: 3 });
    expect(firstData).not.toHaveProperty('boundsUnits');
    await test
      .info()
      .attach('M12-28b-large-explain-first-actual-request', { body: firstUser, contentType: 'text/plain' });
    for (const key of ['explain', 'palette'] as const) {
      for (const scope of ['document', 'selection', 'partial'] as const) {
        await page.evaluate(
          (selection) => window.brickloopEditorTest.select(selection),
          scope === 'selection' ? fixture.selection : scope === 'partial' ? fixture.selection.slice(0, 9) : [],
        );
        const before = model.requests.length;
        model.frames.push({ text: '大模型统计已收到。' });
        await page.getByRole('button', { name: labels[key], exact: true }).click();
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await expect.poll(() => model.requests.length).toBe(before + 1);
        await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
        const measurement = await recordStatistics(
          page,
          scope === 'partial' ? '2601-parts-17-submodels-partial-1377-parts' : '2601-parts-17-submodels-warm',
        );
        expect(measurement.summarizeCalls).toBe(0);
        expect(measurement.attached).toBe(true);
        expect(measurement.elapsedMs).toBeLessThan(1000);
        const user = requestedText(model.requests.at(-1));
        const data = attachmentData(user);
        const modelCount = scope === 'partial' ? 9 : 17;
        if (key === 'explain') {
          expect(data.summary).toEqual({ partCount: modelCount * 153, colorCount: 3 });
          expect(data).not.toHaveProperty('boundsUnits');
          expect(data.submodels).toHaveLength(modelCount);
          expect(
            data.submodels.every((entry) => entry.partCount === 153 && entry.colorCount === 3 && !('bounds' in entry)),
          ).toBe(true);
          expect(data.parts[0]!.count).toBe(modelCount * 153);
        } else {
          expect(data.colors).toHaveLength(3);
          for (const color of data.colors) {
            expect(color.count).toBe(modelCount * 51);
            expect(color.distribution.length).toBeLessThanOrEqual(10);
            expect(color.omittedDistribution + color.distribution.length).toBe(modelCount);
            expect(color.distribution.every((entry) => entry.count === 51)).toBe(true);
          }
        }
        await test
          .info()
          .attach(`M12-28b-large-${key}-${scope}-actual-request`, { body: user, contentType: 'text/plain' });
      }
    }
  } finally {
    await closeUsage(session.app);
    await model.close();
    await cleanupUsage(session.directory);
  }
});

for (const scenario of ['edited', 'edited-back', 'image', 'reference', 'failure'] as const) {
  test(`M12-28 ${scenario}: sends normally without local statistics`, async () => {
    const model = await fakeModel();
    const session = await usageSession(model.endpoint);
    const { page } = session;
    try {
      await seedStatistics(page);
      model.frames.push({ text: '照常回答。' });
      await page.getByRole('button', { name: '解释模型', exact: true }).click();
      const input = page.getByRole('textbox', { name: '给 AI 助手的消息', exact: true });
      const original = await input.inputValue();
      if (scenario === 'failure')
        await page.evaluate(() => sessionStorage.setItem('brickloop:test:statistics-failure', '1'));
      else if (scenario === 'image') await page.getByLabel('添加图片', { exact: true }).setInputFiles(reference);
      else {
        await input.fill(original + (scenario === 'reference' ? ' @双色模块' : ' 请仔细解释。'));
        if (scenario === 'edited-back') await input.fill(original);
      }
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect.poll(() => model.requests.length).toBe(1);
      await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
      expect(requestedText(model.requests[0]!)).not.toContain('<local-statistics>');
      await expect(page.locator('.ai-user details')).toHaveCount(0);
    } finally {
      await closeUsage(session.app);
      await model.close();
      await cleanupUsage(session.directory);
    }
  });
}

test('M12-28 save/reopen preserves local palette turns, statistics labels and context', async () => {
  test.setTimeout(180000);
  const model = await fakeModel();
  const session = await usageSession(model.endpoint);
  let { app, page } = session;
  try {
    await page.getByRole('button', { name: '统一配色', exact: true }).click();
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.ai-turn')).toContainText('无需统一，未调用模型');
    expect(model.requests).toHaveLength(0);
    const local = await page.evaluate(() => window.brickloopEditorTest.aiState().turns[0]!);
    await seedStatistics(page);
    for (const key of ['palette', 'explain'] as const) {
      model.frames.push({ text: '保存统计回合。' });
      await page.getByRole('button', { name: labels[key], exact: true }).click();
      await page.getByRole('button', { name: '发送', exact: true }).click();
      await expect(page.locator('.ai-user details')).toHaveCount(key === 'palette' ? 1 : 2);
      await expect.poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running)).toBe(false);
    }
    const file = path.join(session.directory, 'palette-statistics.brkl');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, file);
    await page.evaluate(() => window.brickloopEditorTest.save(true));
    const history = new TextDecoder().decode(unzipSync(await readFile(file))['ai/history.jsonl']);
    const saved = history
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { user: string });
    expect(saved).toHaveLength(3);
    expect(saved[0]).toEqual(local);
    expect(saved[1]!.user).toBe(requestedText(model.requests[0]!));
    expect(saved[2]!.user).toBe(requestedText(model.requests[1]!));
    await page.evaluate(() => window.brickloopEditorTest.flush());
    await closeUsage(app);
    ({ app, page } = await launchUsage(session.directory));
    const recovery = page.getByRole('dialog', { name: '恢复未保存的文档' });
    await expect(recovery).toContainText('palette-statistics');
    await recovery.getByRole('button', { name: '丢弃', exact: true }).click();
    await expect(recovery).toBeHidden();
    await page.evaluate((file) => window.brickloopEditorTest.open(file), file);
    await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
    await expect(page.locator('.ai-turn').first()).toContainText('无需统一，未调用模型');
    await expect(page.locator('.ai-user details')).toHaveCount(2);
    await page.locator('.ai-user details summary').first().click();
    await expect(page.locator('.ai-user details pre').first()).toHaveText(
      splitLocalStatistics(saved[1]!.user).attachment!,
    );
    await expect(page.getByTestId('ai-context-bar')).toContainText('3 轮');
    model.frames.push({ text: '强制复查完成。' });
    await page.getByRole('button', { name: '让 AI 再检查一次', exact: true }).click();
    await expect.poll(() => model.requests.length).toBe(3);
    expect(requestedText(model.requests[2]!)).toBe(local.user);
    expect((model.requests[2] as ModelRequest).messages).toContainEqual({
      role: 'assistant',
      content: [{ type: 'text', text: local.text }],
    });
  } finally {
    await closeUsage(app);
    await model.close();
    await cleanupUsage(session.directory);
  }
});
for (const scope of ['document', 'selection'] as const) {
  for (const key of ['repair', 'factory', 'palette', 'explain'] as const) {
    test(`M12-5 shortcut ${key} / ${scope}: verify actual tool results and document`, async () => {
      test.setTimeout(180000);
      const model = await fakeModel(shortcutResponse);
      const session = await usageSession(model.endpoint);
      const { page } = session;
      try {
        const fixture = await seedProblems(page);
        const issuesBefore = await validate(page);
        expect(issuesBefore.filter((i) => i.kind === 'collision')).toHaveLength(2);
        expect(issuesBefore.filter((i) => i.kind === 'floating')).toHaveLength(1);
        expect(issuesBefore.some((i) => i.kind === 'non_factory_part')).toBe(true);
        expect(issuesBefore.some((i) => i.kind === 'non_factory_color')).toBe(true);
        expect(new Set(fixture.rows.map((r) => r.colorId)).size).toBeGreaterThan(5);
        await page.keyboard.press('F7');
        const problemsBefore = await page.locator('.check-item').count();
        expect(problemsBefore).toBeGreaterThan(0);
        await page.keyboard.press('Control+k');
        await expect(page.locator('.ai-context')).toContainText('已选 13 件');
        if (scope === 'document') {
          await page.locator('.ai-context .ant-tag').first().locator('.ant-tag-close-icon').click();
          await page.locator('.ai-context .ant-tag').first().locator('.ant-tag-close-icon').click();
          await expect(page.locator('.ai-context .ant-tag')).toHaveCount(0);
        }
        const before = await page.evaluate(() => ({
          document: window.brickloopEditorTest.normalized(),
          undo: window.brickloopEditorTest.snapshot().history.length,
        }));
        await page.getByRole('button', { name: labels[key], exact: true }).click();
        await expect(page.getByRole('textbox', { name: '给 AI 助手的消息', exact: true })).not.toBeEmpty();
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await expect.poll(() => model.requests.length).toBeGreaterThan(0);
        const request = JSON.stringify(model.requests[0]);
        if (scope === 'document') {
          expect(request).not.toContain('software-provided reference data');
          expect(request).not.toContain('activeModelPath');
          expect(request).not.toContain('"selection"');
        } else {
          expect(request).toContain('software-provided reference data');
          for (const path of fixture.selected) expect(request).toContain(path.at(-1)!);
          expect(request).toContain('activeModelPath');
        }
        await expect
          .poll(() => page.evaluate(() => window.brickloopEditorTest.aiState().running), { timeout: 90000 })
          .toBe(false);
        const turn = await page.evaluate(() => window.brickloopEditorTest.aiState().turns.at(-1)!);
        expect(turn.result?.reason).toBe('completed');
        expect(turn.events.filter((e) => e.type === 'tool_result' && !e.result.ok)).toEqual([]);
        const after = await page.evaluate(() => window.brickloopEditorTest.expanded());
        if (scope === 'selection') {
          const outside = fixture.rows.filter((r) => !fixture.selected.some((p) => p.join('/') === r.path.join('/')));
          expect(after.filter((r) => outside.some((o) => o.path.join('/') === r.path.join('/')))).toEqual(outside);
        }
        const issuesAfter = await validate(page);
        if (key === 'repair') {
          expect(issuesAfter.filter((i) => ['collision', 'floating'].includes(i.kind))).toEqual([]);
          await page.keyboard.press('F7');
          expect(await page.locator('.check-item').count()).toBeLessThan(problemsBefore);
          await page.keyboard.press('Control+k');
          await expect(page.getByTestId('review-bar')).toContainText('删除 3');
          await shot(page, `shortcut-${key}-${scope}`);
          await page.getByTestId('review-bar').getByRole('button', { name: '撤销整轮', exact: true }).click();
          expect(await page.evaluate(() => window.brickloopEditorTest.expanded())).toEqual(fixture.rows);
          expect(await validate(page)).toEqual(issuesBefore);
        } else if (key === 'factory') {
          expect(
            issuesAfter.filter((i) => ['non_factory_part', 'non_factory_color', 'unavailable_color'].includes(i.kind)),
          ).toEqual([]);
          expect(after.every((r) => fixture.factory.includes(r.partId) && fixture.colors.includes(r.colorId))).toBe(
            true,
          );
          expect(after.map((r) => r.matrix).sort()).toEqual(fixture.rows.map((r) => r.matrix).sort());
          await page.keyboard.press('F7');
          await expect(page.locator('.check-item').filter({ hasText: /非工厂/ })).toHaveCount(0);
          await shot(page, `shortcut-${key}-${scope}`);
        } else if (key === 'palette') {
          expect(after).toHaveLength(fixture.rows.length);
          expect(after.map(({ path, partId, matrix }) => ({ path, partId, matrix }))).toEqual(
            fixture.rows.map(({ path, partId, matrix }) => ({ path, partId, matrix })),
          );
          expect(new Set(after.map((r) => r.colorId)).size).toBeLessThan(
            new Set(fixture.rows.map((r) => r.colorId)).size,
          );
          expect(after.every((r) => fixture.colors.includes(r.colorId))).toBe(true);
          const review = await page.evaluate(() => window.brickloopEditorTest.review()!);
          expect(review.items.length).toBeGreaterThan(0);
          for (const item of review.items) expect(item.kinds).toEqual(['recolored']);
          await shot(page, `shortcut-${key}-${scope}`);
          const row = page.locator('[data-review-key]').first();
          const rejected = await row.getAttribute('data-review-key');
          await row.getByRole('button', { name: '拒绝', exact: true }).click();
          await expect(page.locator(`[data-review-key="${rejected}"]`)).toHaveAttribute(
            'data-review-state',
            'rejected',
          );
          const restored = await page.evaluate(() => window.brickloopEditorTest.expanded());
          expect(
            restored.filter((r) =>
              fixture.rows.some((b) => b.path.join('/') === r.path.join('/') && b.colorId === r.colorId),
            ).length,
          ).toBeGreaterThan(
            after.filter((r) =>
              fixture.rows.some((b) => b.path.join('/') === r.path.join('/') && b.colorId === r.colorId),
            ).length,
          );
        } else {
          const event = turn.events.find((e) => e.type === 'tool_result' && e.call.name === 'get_model_summary');
          if (event?.type !== 'tool_result' || !event.result.ok) throw new Error('No real summary');
          const summary = event.result.data as { partCount: number; models: { name: string }[]; bounds: unknown };
          expect(summary.partCount).toBe(fixture.rows.length);
          expect(summary.models.some((m) => m.name === '外围展示台')).toBe(true);
          expect(turn.text).toContain(JSON.stringify(summary, null, 2));
          expect(await page.evaluate(() => window.brickloopEditorTest.normalized())).toBe(before.document);
          expect(await page.evaluate(() => window.brickloopEditorTest.snapshot().history.length)).toBe(before.undo);
          await expect(page.getByTestId('review-bar')).toHaveCount(0);
          await shot(page, `shortcut-${key}-${scope}`);
        }
      } finally {
        await closeUsage(session.app);
        await model.close();
        await cleanupUsage(session.directory);
      }
    });
  }
  test(`M12-5 shortcut reference / ${scope}: complete reference workflow`, async () => {
    test.setTimeout(300000);
    const model = await imageModelServer();
    model.controls.delay = 150;
    const session = await usageSession(model.endpoint);
    try {
      const { page } = session;
      if (scope === 'selection') {
        await page.evaluate(async () => {
          await window.brickloopEditorTest.seed(2);
          window.brickloopEditorTest.select(window.brickloopEditorTest.expanded().map((r) => r.path));
          window.brickloopEditorTest.command({ type: 'transform.translate', delta: [1000, 0, 0] });
          window.brickloopEditorTest.select([window.brickloopEditorTest.expanded()[0]!.path]);
        });
        await expect(page.locator('.ai-context')).toContainText('已选 1 件');
      } else await page.locator('.ai-context .ant-tag').first().locator('.ant-tag-close-icon').click();
      const outside = await page.evaluate(() => window.brickloopEditorTest.expanded());
      await page.getByRole('button', { name: '按参考图生成', exact: true }).click();
      await page.getByLabel('选择参考图', { exact: true }).setInputFiles(reference);
      await planAndStart(page, '快捷指令参考图小房子');
      await finishImageFlow(session, `shortcut-reference-${scope}`, 1);
      const after = await session.page.evaluate(() => window.brickloopEditorTest.expanded());
      expect(after.filter((r) => outside.some((b) => b.path.join('/') === r.path.join('/')))).toEqual(outside);
    } finally {
      await closeUsage(session.app);
      await model.close();
      await cleanupUsage(session.directory);
    }
  });
}
