import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compressHistory,
  estimateInputTokens,
  InputTokenMeter,
  prepareHistory,
  runAgentTurn,
} from '../src/agent/index.js';
import { createEditorTools, resultContent } from '../src/tools/index.js';
import type { ChatEvent, ChatRequest, Message, ModelProvider, ToolCallBlock, ToolSpec } from '../src/types.js';
import { compressHistory as referenceCompress, InputTokenMeter as ReferenceMeter } from './fixtures/history-d491fb7.js';
import { collect, fakeHost, image, ok } from './helpers.js';
import { SUMMARY_TEMPLATE } from '../src/agent/compaction.js';

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Real network is forbidden');
    }),
  ),
);
afterEach(() => vi.unstubAllGlobals());

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const tools = createEditorTools();
const textOf = (messages: readonly Message[]) =>
  messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])));

describe('exact byte decomposition', () => {
  it.each([1500, 123])('matches whole-request rounding and images with imageTokens=%i', (imageTokens) => {
    const texts = ['', 'a', 'ab', '中文🧱', '\ud800', '\udfff', '"\\\n\r\t\u0000'];
    const messages: Message[] = [
      ...texts.map(user),
      { role: 'user', content: [image, image] },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            id: 'r',
            name: 'render_views',
            content: [image, { type: 'text', text: '中文🧱' }, image],
          },
        ],
      },
      {
        role: 'assistant',
        content: [],
        providerState: {
          provider: 'test',
          value: { base64: 'opaque', signature: '🧱\ud800', nested: [undefined, null, { base64: 'hidden' }] },
        },
      },
    ];
    const lists = [[], ...messages.map((m) => [m]), messages, [messages[0]!, messages[0]!], [...messages, ...messages]];
    const toolLists = [
      [],
      tools,
      [{ ...tools[0]!, parameters: { type: 'object', base64: 'large'.repeat(100), nested: { base64: 'secret' } } }],
    ];
    for (const system of ['', texts.join('')])
      for (const selected of toolLists)
        for (const list of lists) {
          const expected = estimateInputTokens(system, list, selected, imageTokens);
          const meter = new InputTokenMeter(undefined, imageTokens);
          expect(meter.counter(system, selected)(list)).toBe(expected);
          expect(meter.count(system, list, selected)).toBe(expected);
          expect(new InputTokenMeter(estimateInputTokens, imageTokens).count(system, list, selected)).toBe(expected);
          if (imageTokens === 1500)
            expect(compressHistory(list, { system, tools: selected, maxTokens: Infinity }).tokens).toBe(
              estimateInputTokens(system, prepareHistory(list), selected),
            );
        }
  });

  it('re-serializes mutated objects between projections and recomputes envelopes with colliding tuple keys', () => {
    const selected = [{ ...tools[0]!, description: undefined }] as unknown as ToolSpec[];
    const message = user('first');
    const meter = new InputTokenMeter(undefined, 123);
    const reference = new ReferenceMeter((s, m, t) => estimateInputTokens(s, m, t, 123));
    for (const description of [undefined, null, 'changed', undefined]) {
      Object.assign(selected[0]!, { description });
      message.content.push({ type: 'text', text: '新增🧱' });
      expect(meter.count('system', [message, message], selected)).toBe(
        reference.count('system', [message, message], selected),
      );
      meter.observe('system', [message], selected, 300);
      reference.observe('system', [message], selected, 300);
    }
  });
});

it('replays the existing usage calibration sequence and duplicate multiset additions/removals', () => {
  const history: Message[] = [
      user('first'),
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: '1', name: 'render_views', arguments: { views: ['front', 'isometric'] } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            id: '1',
            name: 'render_views',
            content: [{ type: 'text', text: '{"ok":true}' }, image],
          },
        ],
      },
    ],
    next = user('追加要求');
  const meter = new InputTokenMeter(),
    reference = new ReferenceMeter();
  const compare = (system: string, messages: readonly Message[]) =>
    expect(meter.count(system, messages, [])).toBe(reference.count(system, messages, []));
  compare('', history);
  for (const current of [meter, reference]) current.observe('', history, [], 300);
  compare('', history);
  compare('', [...history, next]);
  compare('', [history[0]!, next]);
  compare('different system', history);
  for (const current of [meter, reference]) current.observe('', history, [], NaN);
  compare('', history);
  for (const actual of [9000, 1, 0, NaN, -1, Infinity]) {
    for (const current of [meter, reference]) current.observe('', [next, next, ...history], [], actual);
    for (const list of [[], [next], [next, next], [next, next, next], [...history, next]]) compare('', list);
  }
});

function round(index: number): Message[] {
  const names = ['render_views', 'compare_to_reference', 'set_color', 'batch'];
  const calls: ToolCallBlock[] = Array.from({ length: index % 8 === 0 ? 3 : 1 }, (_, n) => {
    const name = names[(index + n) % names.length]!;
    return {
      type: 'tool_call',
      id: `parallel-${n}`,
      name,
      arguments:
        name === 'batch'
          ? {
              operations: [
                { tool: 'set_color', arguments: { instanceIds: ['a', 'b'], colorId: 'red' } },
                { tool: 'place_part', arguments: {} },
              ],
            }
          : { views: ['front', 'isometric'], instanceIds: ['a', 'b'], colorId: 'red' },
    };
  });
  return [
    {
      role: 'assistant',
      content: calls,
      providerState: { provider: 'scripted', value: { signature: `signed-${index}` } },
    },
    ...calls.map((call): Message => ({
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          id: call.id,
          name: call.name,
          isError: index % 11 === 0,
          content: resultContent(
            ok(
              call.name === 'render_views' || call.name === 'compare_to_reference'
                ? { images: [image, image], iou: 0.8, view: 'front' }
                : {
                    changed: 2,
                    details: '载荷'.repeat(index === 2 || index === 3 ? 1100 : 20),
                    rolledBack: index % 13 === 0,
                    results: [ok({ changed: 2 }), ok({ instanceId: 'new' })],
                  },
            ),
          ),
        },
      ],
    })),
  ];
}

it.each(['builtin', 'opaque'] as const)('matches the frozen implementation over 18 growing rounds (%s)', (kind) => {
  const estimate = (system: string, messages: readonly Message[], selected: readonly ToolSpec[]) =>
    estimateInputTokens(system, messages, selected, 123) +
    (kind === 'opaque' ? messages.length * 7 + (system.length % 5) : 0);
  const meter = new InputTokenMeter(kind === 'opaque' ? estimate : undefined, 123);
  const reference = new ReferenceMeter(estimate);
  const current = user('保留当前目标、颜色和尺寸。'.repeat(40));
  current.content.push(image);
  const history = [user('更早要求'), ...round(99), current];
  const systems = new Set<string>(),
    toolLists = new Set<string>(),
    usageKinds = new Set<string>();
  let compressedRounds = 0,
    shortenedRounds = 0,
    mostlyRemoved = 0;
  for (let index = 0; index < 18; index++) {
    history.push(...round(index));
    if (index % 4 === 3) history.push(user(`追加用户要求 ${index}：保留窗户。`));
    if (index % 8 === 7)
      history.push(
        user(
          'The tool-call budget has been exhausted. Do not call tools. Summarize completed work and unresolved issues in Simplified Chinese, then stop.',
        ),
      );
    if (index % 6 === 5)
      history.push(
        user(
          'Resolve introduced validation issues before finishing. Inspect and repair them, then validate: [{"kind":"collision"}]',
        ),
      );
    const system = index < 6 ? '系统🧱' : index < 12 ? '更换 system\ud800' : '再次更换系统';
    const selected = tools
      .map((tool) => ({ ...tool, description: tool.name, parameters: { type: 'object' } }))
      .filter((t) =>
        (index < 9
          ? ['render_views', 'compare_to_reference', 'set_color', 'batch']
          : ['render_views', 'set_color', 'batch']
        ).includes(t.name),
      );
    systems.add(system);
    toolLists.add(selected.map((t) => t.name).join(','));
    const options = {
      system,
      tools: selected,
      currentUserMessage: current,
      modelSummary: '模型保留摘要。'.repeat(100),
      maxTokens: index % 8 === 7 ? 0 : estimate(system, [current], selected) + 450,
    };
    const actual = compressHistory(history, { ...options, meter });
    const expected = referenceCompress(history, { ...options, count: reference.count });
    // M12-3: keep comparing the original fields; summarized only describes budget removal.
    expect(
      { messages: actual.messages, compressed: actual.compressed, tokens: actual.tokens },
      `round ${index}`,
    ).toEqual(expected);
    if (actual.compressed) compressedRounds++;
    if (textOf(actual.messages).some((text) => text.startsWith('[早先要求摘要]'))) shortenedRounds++;
    if (actual.messages.length < history.length / 3) mostlyRemoved++;
    const estimated = estimate(system, actual.messages, selected);
    const usage = [estimated * 2 + 1, Math.floor(estimated / 3), 0, NaN, -1, Infinity][index % 6]!;
    usageKinds.add(
      Number.isNaN(usage)
        ? 'NaN'
        : !Number.isFinite(usage)
          ? 'Infinity'
          : usage < 0
            ? 'negative'
            : usage === 0
              ? 'zero'
              : usage > estimated
                ? 'above'
                : 'below',
    );
    meter.observe(system, actual.messages, selected, usage);
    reference.observe(system, expected.messages, selected, usage);
  }
  expect(compressedRounds).toBeGreaterThan(12);
  expect(shortenedRounds).toBeGreaterThan(0);
  expect(mostlyRemoved).toBeGreaterThan(3);
  expect(systems.size).toBe(3);
  expect(toolLists.size).toBe(2);
  expect(usageKinds).toEqual(new Set(['above', 'below', 'zero', 'NaN', 'negative', 'Infinity']));
});

it('preserves incremental summaries byte for byte, including summary halving and earlier-request shortening', () => {
  const current = user('原始要求'.repeat(500));
  const history = [
    user('先前要求'),
    ...round(2),
    current,
    ...Array.from({ length: 12 }, (_, i) => round(i)).flat(),
    user('追加短要求'),
  ];
  const traces: string[][] = [[], []];
  const outputs = [compressHistory, referenceCompress].map((compress, index) =>
    compress(history, {
      system: '',
      tools,
      currentUserMessage: current,
      modelSummary: '附加摘要'.repeat(100),
      maxTokens: 0,
      count: (system, messages, selected) => {
        const first = textOf(messages)[0] ?? '';
        if (traces[index]!.at(-1) !== first) traces[index]!.push(first);
        return estimateInputTokens(system, messages, selected, 123);
      },
    }),
  );
  // The reference predates summarized; preserve equivalence of its original contract.
  const actual = outputs[0]!;
  expect({ messages: actual.messages, compressed: actual.compressed, tokens: actual.tokens }).toEqual(outputs[1]);
  expect(traces[0]).toEqual(traces[1]);
  const summaries = traces[0]!.filter((text) => text.startsWith('[较早上下文摘要]'));
  expect(summaries.some((text, index) => index > 0 && text.length < summaries[index - 1]!.length / 2 + 2)).toBe(true);
  expect(traces[0]!.some((text) => text.startsWith('[早先要求摘要]'))).toBe(true);
});

it.each([false, true])(
  'keeps CTX-01 accounting and tool pairs correct across checkpoints (usage=%s)',
  async (withUsage) => {
    const selected = tools.filter((t) => ['render_views', 'compare_to_reference'].includes(t.name));
    const imageTokens = 123,
      maxTokens = 2100;
    const estimate = (system: string, messages: readonly Message[], tools: readonly ToolSpec[]) =>
      estimateInputTokens(system, messages, tools, imageTokens);
    const current: Message = { role: 'user', content: [{ type: 'text', text: '参考图' }, image] };
    const requests: ChatRequest[] = [],
      usages: number[] = [];
    const provider: ModelProvider = {
      id: 'scripted',
      billing: 'api',
      endpoint: 'http://127.0.0.1/scripted',
      listModels: async () => [],
      capabilities: () => ({
        vision: true,
        tools: true,
        reasoning: false,
        maxContext: 128000,
        contextWindow: 128000,
        imageTokens,
      }),
      async *stream(request): AsyncGenerator<ChatEvent> {
        if (!request.tools.length) {
          yield { type: 'text_delta', text: SUMMARY_TEMPLATE };
          yield { type: 'done', reason: 'stop' };
          return;
        }
        const step = requests.length;
        requests.push({ ...request, messages: structuredClone(request.messages) });
        if (step < 20) {
          const name = step % 2 ? 'compare_to_reference' : 'render_views';
          yield {
            type: 'tool_call',
            call: {
              type: 'tool_call',
              id: `c${step}`,
              name,
              arguments: name === 'render_views' ? { views: ['front'] } : { referenceId: 'ref', view: 'front' },
            },
          };
        } else yield { type: 'text_delta', text: '完成' };
        const usage = estimate(request.system, request.messages, selected);
        usages.push(usage);
        if (withUsage)
          yield { type: 'usage', usage: { inputTokens: usage, outputTokens: 10, cacheReadInputTokens: 0 } };
        yield { type: 'done', reason: step < 20 ? 'tool_calls' : 'stop' };
      },
    };
    const host = fakeHost();
    vi.mocked(host.render_views).mockResolvedValue({
      ok: true,
      data: { images: [image], view: 'front' },
      introducedIssues: [],
      warnings: [],
    });
    vi.mocked(host.compare_to_reference).mockResolvedValue({
      ok: true,
      data: { images: [image], iou: 0.8 },
      introducedIssues: [],
      warnings: [],
    });
    const run = runAgentTurn({
      provider,
      model: 'test',
      host,
      system: 'system',
      history: [],
      userMessage: current,
      tools: selected,
      budget: { inputTokens: maxTokens },
    });
    const events = await collect(run.events);
    expect((await run.result).reason).toBe('completed');
    expect(requests).toHaveLength(21);
    const meter = new InputTokenMeter(undefined, imageTokens);
    let checkpoints = 0;
    requests.forEach((request, index) => {
      expect(meter.count('system', request.messages, selected), `request ${index} tokens`).toBeLessThanOrEqual(
        maxTokens,
      );
      const pending = new Set<string>();
      for (const message of request.messages)
        for (const block of message.content) {
          if (block.type === 'tool_call') pending.add(block.id);
          if (block.type === 'tool_result') expect(pending.delete(block.id)).toBe(true);
        }
      expect(pending.size).toBe(0);
      if (request.messages[0]?.contextCheckpoint) checkpoints++;
      if (withUsage) {
        meter.observe('system', request.messages, selected, usages[index]!);
      }
    });
    const notifications = events.filter((event) => event.type === 'history_compressed');
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.some((event) => event.summarized)).toBe(true);
    expect(checkpoints).toBeGreaterThan(0);
    expect((await run.result).history).toHaveLength(42);
    expect(host.render_views).toHaveBeenCalledTimes(10);
    expect(host.compare_to_reference).toHaveBeenCalledTimes(10);
  },
);
