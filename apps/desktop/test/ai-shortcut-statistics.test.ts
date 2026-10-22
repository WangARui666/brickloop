import { afterEach, expect, it, vi } from 'vitest';
import { createDocument, createModel, expandInstances, pathStartsWith, validateDocument } from '@brickloop/core';
import type { ModelDef, Instance } from '@brickloop/core';
import type { ColorDef } from '@brickloop/catalog';
import { aggregateBom } from '@brickloop/io';
import { estimateInputTokens } from '@brickloop/ai';
import { deltaE2000, rgbToLab } from '@brickloop/mosaic/color';
import { createI18n } from '@brickloop/i18n';
import {
  buildShortcutStatistics,
  createLocalTurn,
  runShortcutStatistics,
  splitLocalStatistics,
} from '../src/renderer/src/ai-local-precheck';
import type { ShortcutStatisticsServices } from '../src/renderer/src/ai-local-precheck';
import { contextHistory, emptyContextMarks } from '../src/renderer/src/ai-context';
import { mutationTargets, SelectionScope } from '../src/renderer/src/ai-scope';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function translateFor(language: 'zh-CN' | 'en') {
  const { t } = createI18n({ language });
  return (key: string, values: Record<string, string | number> = {}) => t(key, values);
}
const t = translateFor('zh-CN');
const color = (id: number, rgb: string): ColorDef => ({
  id: `ld:${id}`,
  rgb,
  edgeRgb: '#000000',
  nameZh: `颜色${id}`,
  legoName: `Color ${id}`,
  legoColorId: id,
  ldrawCode: id,
  finish: 'solid',
  alpha: 1,
});
const palette = [
  color(1, '#ff0000'),
  color(2, '#fe0000'),
  color(3, '#0000ff'),
  color(4, '#00ff00'),
  color(5, '#ffffff'),
  color(6, '#000000'),
];
function add(model: ModelDef, id: string, colorId: string, ref: Instance['ref'] = { kind: 'part', partId: 'ld:3001' }) {
  const stepId = model.stepIds[0]!;
  model.instances[id] = { id, ref, colorId, stepId, groupId: null, transform: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] };
  model.steps[stepId]!.instanceIds.push(id);
}
function services(): ShortcutStatisticsServices & { summarize: ReturnType<typeof vi.fn> } {
  return {
    bom: vi.fn(async (doc) => aggregateBom(doc, { colors: palette })),
    summarize: vi.fn(() => {
      throw new Error('Statistics must not request geometry summaries');
    }),
    colors: vi.fn(async () => ({ all: palette, factory: palette.slice(0, 2) })),
  };
}
interface Data {
  scope: string;
  colorCount: number;
  colors: {
    id: string;
    name: string;
    count: number;
    factory: boolean;
    distribution: { modelPath: string[]; count: number }[];
    omittedDistribution: number;
  }[];
  distributionScope: string;
  colorDifference: string;
  pairs: { colors: string[]; deltaE: number }[];
  summary: { partCount: number; colorCount: number };
  submodels: { path: string[]; name: string; partCount: number; colorCount: number }[];
  parts: { id: string; name: string; count: number }[];
  omitted: Record<string, number>;
  note?: string;
}
function decode(attachment: string): Data {
  const body = splitLocalStatistics('prompt' + attachment).attachment!;
  return JSON.parse(body.slice(body.indexOf('\n') + 1)) as Data;
}
const tokens = (attachment: string) =>
  estimateInputTokens('', [{ role: 'user', content: [{ type: 'text', text: attachment }] }], []);

it.each([0, 1])('makes a local palette turn for %i colors, saved as ordinary zero-cost context', async (count) => {
  const doc = createDocument();
  if (count) add(doc.models[doc.rootModelId]!, 'a', 'ld:1');
  const api = services();
  const result = await buildShortcutStatistics('palette', doc, null, api, t, 'zh-CN');
  expect(result).toEqual({ colorCount: count });
  expect(api.summarize).not.toHaveBeenCalled();
  expect(api.colors).not.toHaveBeenCalled();
  const user = t('aiUi.prompts.palette');
  const text = t('aiUi.localCheck.palette', { scope: t('aiUi.localCheck.document'), count });
  const turn = createLocalTurn(doc.documentId, user, text, {
    shortcut: 'palette',
    paths: null,
    selection: true,
    modelContext: true,
  });
  expect(turn.result).toMatchObject({ toolCalls: 0, cost: { amount: 0 }, usage: { inputTokens: 0, outputTokens: 0 } });
  expect(turn.text).toContain(`颜色数：${count}`);
  expect(turn.text).toContain('无需统一，未调用模型');
  expect(contextHistory([turn], emptyContextMarks())).toEqual([
    { role: 'user', content: [{ type: 'text', text: user }] },
    { role: 'assistant', content: [{ type: 'text', text }] },
  ]);
});

it('uses occurrence counts and catalog factory flags, and orders the closest ten CIEDE2000 pairs', async () => {
  const doc = createDocument(),
    root = doc.models[doc.rootModelId]!;
  palette.forEach((c, i) => add(root, String(i), c.id));
  add(root, 'again', 'ld:1');
  const attachment = (await buildShortcutStatistics('palette', doc, null, services(), t, 'zh-CN')).attachment!;
  const data = decode(attachment);
  expect(data.colorCount).toBe(6);
  expect(data.colors).toEqual(
    palette.map((c, i) => ({
      id: c.id,
      name: c.nameZh,
      count: i === 0 ? 2 : 1,
      factory: i < 2,
      distribution: [{ modelPath: [], count: i === 0 ? 2 : 1 }],
      omittedDistribution: 0,
    })),
  );
  expect(data.pairs).toHaveLength(10);
  expect(data.pairs[0]).toEqual({
    colors: ['ld:1', 'ld:2'],
    deltaE: Number(deltaE2000(rgbToLab([255, 0, 0]), rgbToLab([254, 0, 0])).toFixed(3)),
  });
  expect(data.pairs.map((pair) => pair.deltaE)).toEqual(data.pairs.map((pair) => pair.deltaE).sort((a, b) => a - b));
  expect(data.colorDifference).toBe('CIEDE2000 (sRGB D65)');
  expect(data.omitted).toEqual({ colors: 0, pairs: 5 });
  expect(data.note).toBe(t('aiUi.localStatistics.omitted'));
  expect(attachment).toContain(t('aiUi.localStatistics.intro'));
  expect(tokens(attachment)).toBeLessThanOrEqual(4000);
});

it('keeps repeated submodel occurrences, nested selection, inheritance and world transforms distinct', async () => {
  const doc = createDocument(),
    root = doc.models[doc.rootModelId]!,
    child = createModel('Shared');
  doc.models[child.id] = child;
  add(child, 'leaf', 'inherit');
  add(child, 'other', 'ld:3');
  add(root, 'a', 'ld:1', { kind: 'model', modelId: child.id });
  add(root, 'b', 'ld:2', { kind: 'model', modelId: child.id });
  root.instances.b!.transform[0] = 200;
  const before = structuredClone(doc);
  const api = services();
  const selected = [['a', 'leaf'], ['b'], ['b', 'leaf']];
  const data = decode((await buildShortcutStatistics('explain', doc, selected, api, t, 'zh-CN')).attachment!);
  const scoped = vi.mocked(api.bom).mock.calls[0]![0];
  expect(validateDocument(scoped)).toEqual([]);
  const geometry = ({ colorId, worldMatrix }: ReturnType<typeof expandInstances>[number]) => ({ colorId, worldMatrix });
  expect(expandInstances(scoped).map(geometry)).toEqual(
    expandInstances(doc)
      .filter((row) => selected.some((path) => pathStartsWith(row.path, path)))
      .map(geometry),
  );
  expect(data.summary).toEqual({ partCount: 3, colorCount: 3 });
  expect(data).not.toHaveProperty('boundsUnits');
  expect(api.summarize).toHaveBeenCalledTimes(0);
  expect(data.submodels).toEqual([
    { path: ['a'], name: 'Shared', partCount: 1, colorCount: 1 },
    { path: ['b'], name: 'Shared', partCount: 2, colorCount: 2 },
  ]);
  expect(data.parts).toEqual([{ id: 'ld:3001', name: 'ld:3001', count: 3 }]);
  expect(doc).toEqual(before);
  const single = await buildShortcutStatistics('palette', doc, [['a', 'leaf']], services(), t, 'zh-CN');
  expect(single).toEqual({ colorCount: 1 });
});

it('bounds submodels at 50 and part types at 30, aggregates colors by part ID and records omissions', async () => {
  const doc = createDocument(),
    root = doc.models[doc.rootModelId]!;
  for (let i = 0; i < 52; i++) {
    const model = createModel(`M${i}`);
    doc.models[model.id] = model;
    add(model, 'p', 'ld:1', { kind: 'part', partId: `ld:${i % 32}` });
    add(root, `m${i}`, 'ld:1', { kind: 'model', modelId: model.id });
  }
  add(root, 'extra', 'ld:2', { kind: 'part', partId: 'ld:0' });
  const api = services();
  const attachment = (await buildShortcutStatistics('explain', doc, null, api, t, 'zh-CN')).attachment!;
  const data = decode(attachment);
  expect(api.summarize).toHaveBeenCalledTimes(0);
  expect(data.summary).toEqual({ partCount: 53, colorCount: 2 });
  expect(data.submodels.length).toBeLessThanOrEqual(50);
  expect(data.parts.length).toBeLessThanOrEqual(30);
  expect(data.parts[0]).toEqual({ id: 'ld:0', name: 'ld:0', count: 3 });
  expect(data.parts.map((p) => p.count)).toEqual(data.parts.map((p) => p.count).sort((a, b) => b - a));
  expect(data.omitted.submodels! + data.submodels.length).toBe(52);
  expect(data.omitted.parts! + data.parts.length).toBe(32);
  expect(data.note).toBeTruthy();
  expect(tokens(attachment)).toBeLessThanOrEqual(4000);
});

it('uses the original BOM for a whole-document selection and counts without a geometry summary', async () => {
  const doc = createDocument(),
    root = doc.models[doc.rootModelId]!;
  add(root, 'a', 'ld:1');
  add(root, 'b', 'ld:2');
  const api = services();
  const result = await buildShortcutStatistics('explain', doc, [['a'], ['b']], api, t, 'zh-CN');
  expect(api.summarize).toHaveBeenCalledTimes(0);
  expect(api.bom).toHaveBeenCalledExactlyOnceWith(doc);
  expect(decode(result.attachment!).summary).toEqual({ partCount: 2, colorCount: 2 });
});

it.each(['zh-CN', 'en'] as const)(
  'explains where document bounds are provided, including empty scopes, in %s',
  async (language) => {
    const api = services();
    const translate = translateFor(language);
    const result = await buildShortcutStatistics('explain', createDocument(), null, api, translate, language);
    expect(decode(result.attachment!).summary).toEqual({ partCount: 0, colorCount: 0 });
    expect(decode(result.attachment!)).not.toHaveProperty('boundsUnits');
    expect(api.summarize).toHaveBeenCalledTimes(0);
    expect(result.attachment).toContain(translate('aiUi.localStatistics.explainHint'));
    expect(result.attachment).toContain('Host-provided model summary');
    expect(result.attachment).toContain('bounds');
  },
);

it.each(['zh-CN', 'en'] as const)(
  'enforces the 4000-token budget with long Unicode names and localized text in %s',
  async (language) => {
    const doc = createDocument(),
      root = doc.models[doc.rootModelId]!;
    palette.forEach((c, i) => add(root, String(i), c.id));
    const api = services();
    api.colors = async () => ({
      all: palette.map((c) => ({ ...c, nameZh: '很长的颜色名'.repeat(2000), legoName: 'Long name '.repeat(2000) })),
      factory: [],
    });
    const translate = translateFor(language);
    const attachment = (await buildShortcutStatistics('palette', doc, null, api, translate, language)).attachment!;
    expect(tokens(attachment)).toBeLessThanOrEqual(4000);
    const data = decode(attachment);
    expect(data.omitted.colors! + data.colors.length).toBe(6);
    expect(data.omitted.colors).toBeGreaterThan(0);
    expect(data.note).toBe(translate('aiUi.localStatistics.omitted'));
    expect(attachment).toContain(translate('aiUi.localStatistics.intro'));
    expect(splitLocalStatistics('edited prompt')).toEqual({ prompt: 'edited prompt' });
  },
);

it('fails open on statistics errors, stale documents and the one-second deadline, and aborts late services', async () => {
  const doc = createDocument(),
    api = services();
  api.bom = async () => {
    throw new Error('BOM failed');
  };
  expect(
    await runShortcutStatistics(
      (check) => buildShortcutStatistics('explain', doc, null, api, t, 'zh-CN', check),
      () => true,
    ),
  ).toBeNull();
  expect(
    await runShortcutStatistics(
      async () => ({ colorCount: 1 }),
      () => false,
    ),
  ).toBeNull();
  vi.useFakeTimers();
  let finish: (value: { colorCount: number }) => void = () => undefined;
  let observedSignal: AbortSignal | undefined;
  const pending = runShortcutStatistics(
    (_check, signal) => {
      observedSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    () => true,
  );
  await vi.advanceTimersByTimeAsync(999);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBeNull();
  expect(observedSignal?.aborted).toBe(true);
  finish({ colorCount: 1 });
  expect(vi.getTimerCount()).toBe(0);
});

it('caps each color at the ten largest direct-owner distributions and records omissions', async () => {
  const doc = createDocument(),
    root = doc.models[doc.rootModelId]!;
  add(root, 'root-part', 'ld:2');
  for (let i = 1; i <= 12; i++) {
    const child = createModel(`Model ${i}`);
    doc.models[child.id] = child;
    add(root, `m${i}`, 'ld:1', { kind: 'model', modelId: child.id });
    for (let n = 0; n < i; n++) add(child, `p${n}`, 'inherit');
  }
  const api = services();
  const result = await buildShortcutStatistics('palette', doc, null, api, t, 'zh-CN');
  const data = decode(result.attachment!);
  const red = data.colors.find((color) => color.id === 'ld:1')!;
  expect(red.count).toBe(78);
  expect(red.distribution).toEqual(
    Array.from({ length: 10 }, (_, i) => ({ modelPath: [`m${12 - i}`], count: 12 - i })),
  );
  expect(red.omittedDistribution).toBe(2);
  expect(data.distributionScope).toBe('direct-parts');
  expect(data.note).toBe(t('aiUi.localStatistics.omitted'));
  expect(api.bom).not.toHaveBeenCalled();
  expect(api.summarize).not.toHaveBeenCalled();
  expect(result.attachment).toContain(t('aiUi.localStatistics.paletteHint'));
});

it('reports nested selection distributions without double-counting and explains the actual shared scope lock', async () => {
  const doc = createDocument(),
    root = doc.models[doc.rootModelId]!,
    shared = createModel('Shared');
  doc.models[shared.id] = shared;
  add(shared, 'leaf', 'ld:1');
  add(shared, 'blue', 'ld:2');
  for (const name of ['a', 'b']) add(root, name, 'ld:1', { kind: 'model', modelId: shared.id });
  add(root, 'outside', 'ld:1');
  const result = await buildShortcutStatistics('palette', doc, [['a']], services(), t, 'zh-CN');
  const data = decode(result.attachment!);
  expect(data.colors.map((color) => color.distribution)).toEqual([
    [{ modelPath: ['a'], count: 1 }],
    [{ modelPath: ['a'], count: 1 }],
  ]);
  expect(result.attachment).toContain(t('aiUi.localStatistics.selectionHint'));
  const targets = mutationTargets(
    'replace_color',
    { fromColorId: 'ld:1', toColorId: 'ld:2', modelPath: ['a'] },
    doc,
    [],
    () => [],
  );
  expect(targets).toEqual([['a', 'leaf']]);
  expect(new SelectionScope(doc, [['a']]).check(targets)?.code).toBe('OUT_OF_SCOPE');
  expect(new SelectionScope(doc, [['a'], ['b']]).check(targets)).toBeUndefined();
  for (const language of ['zh-CN', 'en'] as const) {
    const translate = translateFor(language);
    expect(translate('aiUi.localStatistics.paletteHint')).toContain('replace_color(fromColorId, toColorId, modelPath)');
    expect(translate('aiUi.localStatistics.selectionHint')).toContain('batch');
    expect(translate('aiUi.localStatistics.selectionHint')).toContain('set_color');
  }
});

it('yields during a large scope walk and stops before services when the document changes between chunks', async () => {
  const doc = createDocument(),
    root = doc.models[doc.rootModelId]!;
  for (let i = 0; i < 2000; i++) add(root, String(i), 'ld:1');
  const api = services();
  vi.useFakeTimers();
  let unchanged = true,
    checkpoints = 0;
  setTimeout(() => {
    unchanged = false;
  }, 0);
  const pending = runShortcutStatistics(
    (check) =>
      buildShortcutStatistics('explain', doc, null, api, t, 'zh-CN', () => {
        checkpoints++;
        check();
      }),
    () => unchanged,
  );
  await vi.runAllTimersAsync();
  expect(await pending).toBeNull();
  expect(checkpoints).toBeLessThan(1000);
  const stoppedAt = checkpoints;
  await vi.advanceTimersByTimeAsync(5000);
  expect(checkpoints).toBe(stoppedAt);
  expect(api.bom).not.toHaveBeenCalled();
  expect(api.summarize).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
