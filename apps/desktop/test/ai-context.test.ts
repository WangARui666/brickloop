import { describe, expect, it } from 'vitest';
import { createDocument, type Instance } from '@brickloop/core';
import {
  calculateCeiling,
  compressHistory,
  createEditorTools,
  emptyUsage,
  imageTokenEstimate,
  InputTokenMeter,
  presetCapabilities,
  runAgentTurn,
  estimateInputTokens,
} from '@brickloop/ai';
import { fakeHost, collect } from '../../../packages/ai/test/helpers';
import type { AgentResult, Message, ModelCapabilities, WorkflowReport } from '@brickloop/ai';
import type { SavedTurn } from '../src/shared/ai-api';
import { conversationPrompt } from '../src/shared/ai-context-prompt';
import {
  contextHistory,
  contextTurns,
  contextWindow,
  emptyContextMarks,
  estimateContext,
  formatContextTokens,
  parseContextMarks,
  serializeContextMarks,
  turnContextStatus,
  failedTurnSummary,
  saveContextCheckpoint,
  clearContextMarks,
  retainedEditContext,
} from '../src/renderer/src/ai-context';

function chat(reason?: AgentResult['reason']): SavedTurn {
  return {
    id: 'chat',
    user: 'User A',
    text: 'Answer A',
    events: [],
    images: [],
    ...(reason
      ? {
          result: {
            reason,
            text: 'Answer A',
            history: [],
            usage: emptyUsage(),
            cost: { amount: 0, currency: 'USD', label: '' },
            toolCalls: 0,
            elapsedMs: 1,
            unresolvedIssues: [],
          },
        }
      : {}),
  };
}
function image(reason: WorkflowReport['reason'], transaction: WorkflowReport['transaction'] = 'committed'): SavedTurn {
  return {
    ...chat(),
    id: 'image',
    images: [{ type: 'image', mime: 'image/png', base64: 'aW1hZ2U=' }],
    report: {
      reason,
      transaction,
      summaryZh: 'Image task summary',
      rounds: [],
      script: null,
      plan: null,
      buildabilitySkipped: false,
      components: [],
      partCount: 0,
      colorCount: 0,
      validation: { checked: true, issues: [] },
      checks: [],
      comparisons: [],
      references: [],
      latestRender: [],
      unfinished: [],
      interjections: [],
      toolCalls: 0,
      elapsedMs: 1,
      usage: emptyUsage(),
    },
  };
}
describe('A-103 turn inclusion', () => {
  it.each(['completed', 'tool_budget'] as const)('includes chat %s', (reason) => {
    expect(turnContextStatus(chat(reason), emptyContextMarks())).toEqual({ included: true });
  });
  it.each([
    ['error', 'failed'],
    ['cancelled', 'stopped'],
    ['max_tokens', 'truncated'],
    ['time_budget', 'budget'],
    ['input_budget', 'budget'],
    ['daily_cost_limit', 'budget'],
    [undefined, 'failed'],
  ] as const)('excludes chat %s, including legacy turns', (reason, excluded) => {
    expect(turnContextStatus(chat(reason), emptyContextMarks())).toEqual({ included: false, reason: excluded });
  });
  it.each(['completed', 'round_budget', 'time_budget', 'tool_budget'] as const)(
    'only includes committed image %s',
    (reason) => {
      expect(turnContextStatus(image(reason), emptyContextMarks())).toEqual({ included: true });
      for (const transaction of ['none', 'commit_failed'] as const)
        expect(turnContextStatus(image(reason, transaction), emptyContextMarks())).toEqual({
          included: false,
          reason: 'image_failed',
        });
    },
  );
  it.each(['user_stopped', 'error', 'input_budget', 'daily_cost_limit', 'engine_unavailable'] as const)(
    'excludes image %s',
    (reason) => {
      expect(turnContextStatus(image(reason), emptyContextMarks())).toEqual({
        included: false,
        reason: reason === 'user_stopped' ? 'stopped' : 'image_failed',
      });
    },
  );
  it.each(['merged', 'pending_merge'] as const)(
    'excludes failed turns without recorded retained edits (%s)',
    (status) => {
      const failedChat = chat('error'),
        failedImage = image('error', 'committed');
      const tasks = { chat: { status }, image: { status } };
      expect(turnContextStatus(failedChat, emptyContextMarks())).toEqual({ included: false, reason: 'failed' });
      expect(turnContextStatus(failedImage, emptyContextMarks())).toEqual({ included: false, reason: 'image_failed' });
      expect(contextTurns([failedChat, failedImage], emptyContextMarks(), tasks)).toEqual([]);
      expect(contextHistory([failedChat, failedImage], emptyContextMarks(), tasks)).toEqual([]);
    },
  );
  it('gives marks priority over saved outcomes', () => {
    expect(turnContextStatus(chat('completed'), { ...emptyContextMarks(), discardedTurnIds: ['chat'] })).toEqual({
      included: false,
      reason: 'discarded',
    });
    expect(
      turnContextStatus(chat('completed'), {
        ...emptyContextMarks(),
        discardedTurnIds: ['chat'],
        clearedTurnIds: ['chat'],
      }),
    ).toEqual({ included: false, reason: 'cleared' });
  });
});

describe('A-123 persisted checkpoints', () => {
  const turns = [
    { ...chat('completed'), id: 'first', user: 'first' },
    { ...chat('completed'), id: 'second', user: 'second' },
    { ...chat('completed'), id: 'third', user: 'third' },
  ];
  it('round trips a cut inside a turn, keeps the prefix stable, and clears it with a new conversation', () => {
    const checkpoint = {
      summary: '[较早上下文摘要]\n蓝色屋顶',
      createdAt: '2026-10-20T08:00:00.000Z',
      coveredMessages: 3,
    };
    const marks = saveContextCheckpoint(turns, emptyContextMarks(), checkpoint);
    expect(marks.checkpoint).toEqual({
      summary: checkpoint.summary,
      createdAt: checkpoint.createdAt,
      coveredTurnIds: ['first', 'second'],
      throughTurnId: 'second',
      throughMessage: 1,
    });
    const restored = parseContextMarks(serializeContextMarks(marks));
    expect(restored).toEqual({ warning: false, marks });
    const history = contextHistory(turns, restored.marks);
    expect(history.slice(1)).toEqual(contextHistory(turns, emptyContextMarks()).slice(3));
    const appended = [...turns, { ...chat('completed'), id: 'fourth', user: 'fourth' }];
    expect(contextHistory(appended, marks).slice(0, history.length)).toEqual(history);
    const cleared = clearContextMarks(
      marks,
      turns.map((turn) => turn.id),
    );
    expect(cleared).not.toHaveProperty('checkpoint');
    expect(contextHistory(turns, cleared)).toEqual([]);
  });
  it('updates an existing checkpoint using the projected history position', () => {
    const first = saveContextCheckpoint(turns, emptyContextMarks(), {
      summary: 'old',
      createdAt: 'first',
      coveredMessages: 3,
    });
    const next = saveContextCheckpoint(turns, first, {
      summary: 'updated',
      createdAt: 'next',
      coveredMessages: 3,
    });
    expect(next.checkpoint).toMatchObject({
      summary: 'updated',
      throughTurnId: 'third',
      throughMessage: 1,
      coveredTurnIds: ['first', 'second', 'third'],
    });
    expect(contextHistory(turns, next)).toHaveLength(2);
  });
  it('invalidates checkpoints when a covered turn is discarded or missing after reopening', () => {
    const marks = saveContextCheckpoint(turns, emptyContextMarks(), {
      summary: 'stale checkpoint',
      createdAt: 'now',
      coveredMessages: 4,
    });
    expect(JSON.stringify(contextHistory(turns, { ...marks, discardedTurnIds: ['first'] }))).not.toContain(
      'stale checkpoint',
    );
    expect(JSON.stringify(contextHistory(turns.slice(1), marks))).not.toContain('stale checkpoint');
  });
  it('reads legacy marks and ignores a malformed checkpoint without losing exclusions', () => {
    const marks = { ...emptyContextMarks(), clearedTurnIds: ['old'] };
    expect(parseContextMarks(JSON.stringify(marks))).toEqual({ warning: false, marks });
    expect(parseContextMarks(JSON.stringify({ ...marks, checkpoint: null }))).toEqual({ warning: true, marks });
  });
});

describe('A-124 retained failed edits', () => {
  const retainedEdits = { added: 3, modified: 2, deleted: 1, submodels: ['roof (屋顶)'] };
  it('counts actual net part edits once and records affected models', () => {
    const before = createDocument({ title: '屋顶' });
    const model = before.models[before.rootModelId]!;
    const instance = (id: string): Instance => ({
      id,
      ref: { kind: 'part', partId: 'ld:3001' },
      colorId: 'c:bright-red',
      transform: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      stepId: model.stepIds[0]!,
      groupId: null,
    });
    model.instances = { moved: instance('moved'), deleted: instance('deleted') };
    model.steps[model.stepIds[0]!]!.instanceIds = ['moved', 'deleted'];
    const after = structuredClone(before);
    const changed = after.models[after.rootModelId]!;
    changed.instances.moved!.colorId = 'c:bright-blue';
    changed.instances.moved!.transform[0] = 20;
    delete changed.instances.deleted;
    changed.instances.added = instance('added');
    changed.steps[changed.stepIds[0]!]!.instanceIds = ['moved', 'added'];
    expect(retainedEditContext(before, after)).toEqual({
      retainedEdits: { added: 1, modified: 1, deleted: 1, submodels: [`${model.id} (屋顶)`] },
    });
    expect(retainedEditContext(before, structuredClone(before))).toBeUndefined();
  });
  it.each(['chat', 'image'])('replays failed %s as text with request, error and exact edit counts', (kind) => {
    const turn = kind === 'chat' ? chat('error') : image('error');
    const error = { category: 'quota_exceeded' as const, code: 'INSUFFICIENT_BALANCE', message: 'failed' };
    if (turn.result) turn.result.error = error;
    if (turn.report) turn.report.failure = { stage: 'round', error };
    turn.context = { retainedEdits };
    expect(turnContextStatus(turn, emptyContextMarks())).toEqual({ included: true, summary: true });
    const history = contextHistory([turn], emptyContextMarks());
    expect(history).toHaveLength(1);
    expect(history[0]!.content).toEqual([{ type: 'text', text: failedTurnSummary(turn) }]);
    const serialized = JSON.stringify(history);
    for (const value of [turn.user, 'quota_exceeded', 'INSUFFICIENT_BALANCE', '屋顶', 'added', 'modified', 'deleted'])
      expect(serialized).toContain(value);
    expect(serialized).not.toContain('tool_call');
    expect(serialized).not.toContain('base64');
    const restored = JSON.parse(JSON.stringify(turn)) as SavedTurn;
    expect(contextHistory([restored], emptyContextMarks())).toEqual(history);
    expect(contextHistory([turn], { ...emptyContextMarks(), discardedTurnIds: [turn.id] })).toEqual([]);
  });
  it('excludes a failed turn with zero net edits and keeps stopped turns excluded', () => {
    const noEdits = { retainedEdits: { added: 0, modified: 0, deleted: 0, submodels: [] } };
    expect(contextHistory([{ ...chat('error'), context: noEdits }], emptyContextMarks())).toEqual([]);
    expect(contextHistory([{ ...chat('cancelled'), context: { retainedEdits } }], emptyContextMarks())).toEqual([]);
  });
});
describe('context resource', () => {
  it('round trips only marks without touching the history format', () => {
    const marks = {
      ...emptyContextMarks(),
      clearedTurnIds: ['a', 'a'],
      discardedTurnIds: ['b'],
      clearedAt: '2026-10-20T08:00:00.000Z',
    };
    expect(parseContextMarks(serializeContextMarks(marks))).toEqual({
      warning: false,
      marks: { ...marks, clearedTurnIds: ['a'] },
    });
  });
  it.each([
    undefined,
    '',
    '{',
    'null',
    '[]',
    '{"version":2,"clearedTurnIds":[],"discardedTurnIds":[]}',
    '{"version":1,"clearedTurnIds":[],"discardedTurnIds":[1]}',
    '{"version":1,"clearedTurnIds":"a","discardedTurnIds":[]}',
    '{"version":1,"clearedTurnIds":[],"discardedTurnIds":[],"clearedAt":3}',
    '{"version":1}',
  ])('tolerates %s', (source) => {
    expect(parseContextMarks(source)).toEqual({ marks: emptyContextMarks(), warning: true });
  });
});
it('assembles exactly the included history in order, with image summaries and no image blocks', () => {
  const turns = [
    chat('completed'),
    { ...chat('completed'), id: 'cleared' },
    chat('error'),
    image('completed'),
    { ...chat('tool_budget'), id: 'discarded' },
    { ...chat('completed'), id: 'active' },
    { ...chat('completed'), id: 'queued' },
    { ...chat('completed'), id: 'last', user: 'Last' },
  ];
  const marks = { ...emptyContextMarks(), clearedTurnIds: ['cleared'], discardedTurnIds: ['discarded'] };
  const tasks = { active: { status: 'running' as const }, queued: { status: 'queued' as const } };
  expect(contextTurns(turns, marks, tasks).map((t) => t.id)).toEqual(['chat', 'image', 'last']);
  expect(contextHistory(turns, marks, tasks)).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'User A' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Answer A' }] },
    {
      role: 'user',
      content: [{ type: 'text', text: '看图搭建任务（软件记录，仅供参考）：User A（参考图 1 张，未附上）' }],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Image task summary' }] },
    { role: 'user', content: [{ type: 'text', text: 'Last' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Answer A' }] },
  ]);
});
describe('A-104 next-request estimate', () => {
  const caps: ModelCapabilities & { imageTokens: number } = {
    vision: true,
    tools: true,
    reasoning: true,
    maxContext: 128000,
    contextWindow: 128000,
    imageTokens: 768,
  };
  it.each([null, 0, -1, 1000000])('reads known positive context window %s', (value) => {
    expect(contextWindow({ ...caps, contextWindow: value })).toBe(
      typeof value === 'number' && value > 0 ? value : null,
    );
  });
  it.each([null, 32000, 1000000])('matches compression and provider image estimates (window %s)', (window) => {
    const capabilities = { ...caps, contextWindow: window };
    const summary = { partCount: 10000, activeModelPath: [], selection: [['excluded']] };
    const history: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Old request '.repeat(12000) },
          { type: 'image', mime: 'image/png', base64: 'aW1hZ2U=' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Old answer '.repeat(12000) }] },
    ];
    const estimate = estimateContext({ summary, modelContext: true, history, capabilities });
    const prompt = conversationPrompt(summary, true);
    const currentUserMessage: Message = { role: 'user', content: [{ type: 'text', text: '' }] };
    const compressed = compressHistory([...history, currentUserMessage], {
      ...prompt,
      tools: createEditorTools(),
      maxTokens: calculateCeiling(window),
      currentUserMessage,
      meter: new InputTokenMeter(undefined, imageTokenEstimate(capabilities)),
    });
    expect(estimate.tokens).toBe(compressed.tokens);
    expect(estimate.summarized).toBe(compressed.summarized);
    expect(estimate.window).toBe(window);
    expect(estimate.baseTokens).toBeGreaterThan(0);
    expect(estimate.baseTokens + estimate.historyTokens).toBe(estimate.tokens);
    expect(prompt.system).not.toContain('excluded');
    expect(conversationPrompt(summary, false).modelSummary).toBe('{"partCount":10000}');
  });
  it.each([
    [123, '123'],
    [12345, '12.3K'],
    [1000000, '1M'],
  ])('formats %s as %s', (value, formatted) => {
    expect(formatContextTokens(Number(value))).toBe(formatted);
  });
});

it('DeepSeek estimate equals the first runtime request count, without budget compression', async () => {
  const preset = presetCapabilities('deepseek', 'deepseek-flash');
  const capabilities = { ...preset, maxOutputTokens: preset.maxOutputTokens! };
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'Earlier request' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer '.repeat(100) }] },
  ];
  const summary = { partCount: 10 };
  const estimate = estimateContext({ summary, history, capabilities, modelContext: true });
  let tokens = -1;
  const run = runAgentTurn({
    provider: {
      id: 'offline',
      billing: 'api',
      endpoint: 'http://127.0.0.1',
      listModels: async () => [],
      capabilities: () => capabilities,
      async *stream(request) {
        tokens = estimateInputTokens(request.system, request.messages, request.tools, imageTokenEstimate(capabilities));
        expect(JSON.stringify(request.messages)).toContain('[较早上下文摘要]');
        yield { type: 'done' as const, reason: 'stop' as const };
      },
    },
    model: 'deepseek-flash',
    ...conversationPrompt(summary, true),
    history,
    userMessage: { role: 'user', content: [{ type: 'text', text: '' }] },
    tools: createEditorTools(),
    host: fakeHost(),
  });
  const events = await collect(run.events);
  expect((await run.result).reason).toBe('completed');
  expect(estimate.tokens).toBe(tokens);
  expect(estimate.summarized).toBe(false);
  expect(events.filter((event) => event.type === 'history_compressed')).toEqual([
    { type: 'history_compressed', estimatedTokens: tokens, summarized: false },
  ]);
});
