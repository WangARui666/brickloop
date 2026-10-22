import { afterEach, expect, it, vi } from 'vitest';
import { createI18n } from '@brickloop/i18n';
import {
  createLocalTurn,
  precheckIsClean,
  precheckShortcut,
  runLocalPrecheck,
} from '../src/renderer/src/ai-local-precheck';
import { contextHistory, emptyContextMarks, turnContextStatus } from '../src/renderer/src/ai-context';
import { success } from '../src/renderer/src/ai-editor-host';

afterEach(() => vi.useRealTimers());
const clean = success({ issues: [] });
const selected = [['group']];

it.each([
  'collision',
  'collisionUnknown',
  'floating',
  'connectivity',
  'non_factory_part',
  'non_factory_color',
  'unavailable_color',
  'duplicate',
  'missingGeometry',
  'unreviewedConnectors',
  'offGrid',
])('counts %s only when a normalized instance path is within the selection', (kind) => {
  const issue = (paths: string[][]) => success({ issues: [{ kind, paths, severity: 'info' }] });
  expect(precheckIsClean(issue([['outside']]), null)).toBe(false);
  expect(precheckIsClean(issue([['outside']]), selected)).toBe(true);
  expect(precheckIsClean(issue([['group', 'child']]), selected)).toBe(false);
  expect(precheckIsClean(issue([['outside'], ['group', 'child']]), selected)).toBe(false);
  expect(precheckIsClean(issue([['group-other']]), selected)).toBe(true);
  expect(precheckIsClean(issue([]), selected)).toBe(false);
});

it('fails open for unknown kinds, cycle document paths, malformed results and unlocated uncertainty', () => {
  for (const issue of [
    { kind: 'future', paths: [['outside']] },
    { kind: 'cycle', path: ['models', 'outside'] },
    { kind: 'collisionUnknown', paths: [] },
    { kind: 'unreviewedConnectors' },
    { kind: 'floating', path: ['outside'] },
    { kind: 'floating', paths: [['outside'], []] },
    null,
  ])
    expect(precheckIsClean(success({ issues: [issue] }), selected)).toBe(false);
  for (const result of [
    null,
    {},
    { ok: false },
    success({}),
    success({ issues: 'none' }),
    { ...clean, warnings: ['uncertain'] },
  ])
    expect(precheckIsClean(result, selected)).toBe(false);
  expect(precheckIsClean(clean, [])).toBe(false);
  expect(precheckIsClean(clean, null)).toBe(true);
  expect(precheckIsClean(clean, selected)).toBe(true);
});

it.each(['zh-CN', 'en'] as const)(
  'only prechecks original shortcuts without images or references in %s',
  (language) => {
    const t = createI18n({ language }).t;
    const prompts = {
      repair: t('aiUi.prompts.repair'),
      factory: t('aiUi.prompts.factory'),
      palette: t('aiUi.prompts.palette'),
      explain: t('aiUi.prompts.explain'),
    };
    for (const key of ['repair', 'factory', 'palette', 'explain'] as const) {
      expect(precheckShortcut(key, prompts[key], prompts, [], [])).toBe(key);
      expect(precheckShortcut(key, prompts[key] + ' ', prompts, [], [])).toBeNull();
      expect(precheckShortcut(null, prompts[key], prompts, [], [])).toBeNull();
      expect(precheckShortcut(key, prompts[key], prompts, [{}], [])).toBeNull();
      expect(precheckShortcut(key, prompts[key], prompts, [], [{}])).toBeNull();
      expect(
        precheckShortcut(key, prompts[key] + '@part', { ...prompts, [key]: prompts[key] + '@part' }, [], []),
      ).toBeNull();
    }
  },
);

it('passes check filters to the shared validate and fails open on throws, errors and the 20 second deadline', async () => {
  const validate = vi.fn().mockResolvedValue(clean);
  expect(await runLocalPrecheck(validate, 'factory', null)).toBe(true);
  expect(validate).toHaveBeenLastCalledWith({ checks: ['non_factory_part', 'non_factory_color'] });
  expect(await runLocalPrecheck(validate, 'repair', null)).toBe(true);
  expect(validate).toHaveBeenLastCalledWith({});
  expect(
    await runLocalPrecheck(
      () => {
        throw new Error('engine');
      },
      'repair',
      null,
    ),
  ).toBe(false);
  expect(await runLocalPrecheck(async () => ({ ok: false }), 'repair', null)).toBe(false);
  vi.useFakeTimers();
  let finish: (value: unknown) => void = () => undefined;
  const pending = runLocalPrecheck(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    'repair',
    null,
  );
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await pending).toBe(false);
  finish(clean);
  expect(vi.getTimerCount()).toBe(0);
});

it('makes a completed, zero-cost local turn with exactly the visible user/assistant history', () => {
  const local = { shortcut: 'factory' as const, paths: selected, selection: true, modelContext: false };
  const turn = createLocalTurn('document', 'Factory check', 'Local check; all zero.', local);
  expect(turn.local).toEqual(local);
  expect(turn.local?.paths).not.toBe(selected);
  expect(turn.selectionCount).toBe(1);
  expect(turn.result).toMatchObject({
    reason: 'completed',
    cost: { amount: 0 },
    toolCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  expect(turnContextStatus(turn, emptyContextMarks())).toEqual({ included: true });
  expect(contextHistory([turn], emptyContextMarks())).toEqual([
    { role: 'user', content: [{ type: 'text', text: turn.user }] },
    { role: 'assistant', content: [{ type: 'text', text: turn.text }] },
  ]);
});
