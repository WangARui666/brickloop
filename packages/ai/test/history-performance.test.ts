import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { compressHistory, estimateInputTokens, InputTokenMeter, runAgentTurn } from '../src/agent/index.js';
import { createEditorTools, type EditorTool } from '../src/tools/index.js';
import type { ChatEvent, Message, ModelProvider, ToolCallBlock, ToolSpec } from '../src/types.js';
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

it.each([40, 80])('keeps tool-definition reads constant per CTX-01 request with %i tool calls', async (calls) => {
  const tools = createEditorTools();
  let reads = 0,
    lastReads = 0,
    requests = 0;
  const perRequest: number[] = [];
  const wrapped: EditorTool[] = tools.map((tool) => ({
    ...tool,
    get parameters() {
      reads++;
      return tool.parameters;
    },
  }));
  const provider: ModelProvider = {
    id: 'scripted',
    billing: 'api',
    endpoint: 'http://127.0.0.1/scripted',
    listModels: async () => [],
    capabilities: () => ({ vision: true, tools: true, reasoning: false, maxContext: 128000, contextWindow: 128000 }),
    async *stream(request): AsyncGenerator<ChatEvent> {
      if (!request.tools.length) {
        yield { type: 'text_delta', text: SUMMARY_TEMPLATE };
        yield { type: 'done', reason: 'stop' };
        return;
      }
      perRequest.push(reads - lastReads);
      lastReads = reads;
      const step = requests++;
      if (step < calls) {
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
      yield {
        type: 'usage',
        usage: {
          inputTokens: estimateInputTokens(request.system, request.messages, tools),
          outputTokens: 10,
          cacheReadInputTokens: 0,
        },
      };
      yield { type: 'done', reason: step < calls ? 'tool_calls' : 'stop' };
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
    userMessage: { role: 'user', content: [{ type: 'text', text: '参考图' }, image] },
    tools: wrapped,
    budget: { inputTokens: 24000, toolCalls: calls + 1 },
  });
  await collect(run.events);
  perRequest[perRequest.length - 1]! += reads - lastReads;
  expect((await run.result).reason).toBe('completed');
  expect((await run.result).toolCalls).toBe(calls);
  expect(requests).toBe(calls + 1);
  expect(reads).toBeLessThanOrEqual(tools.length * requests * 6);
  expect(Math.max(...perRequest)).toBeLessThanOrEqual(tools.length * 6);
});

it.each([false, true])(
  'reads an early tool call a fixed number of times across candidate histories (calibrated=%s)',
  (calibrated) => {
    const counts: number[] = [];
    for (const groups of [30, 60, 120]) {
      let reads = 0;
      const current = user('当前要求');
      const history = [current];
      for (let index = 0; index < groups; index++) {
        const args = { instanceIds: ['a', 'b'], colorId: 'red' };
        const call: ToolCallBlock = {
          type: 'tool_call',
          id: String(index),
          name: 'set_color',
          get arguments() {
            if (index === 2) reads++;
            return args;
          },
        };
        history.push(
          { role: 'assistant', content: [call] },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                id: call.id,
                name: call.name,
                content: [{ type: 'text', text: JSON.stringify(ok({ changed: 2, details: 'x'.repeat(900) })) }],
              },
            ],
          },
        );
      }
      const tools = createEditorTools();
      const meter = calibrated ? new InputTokenMeter() : undefined;
      meter?.observe('', history, tools, estimateInputTokens('', history, tools));
      reads = 0;
      const result = compressHistory(history, {
        system: '',
        tools,
        maxTokens: 0,
        currentUserMessage: current,
        ...(meter ? { meter } : {}),
      });
      counts.push(reads);
      expect(result.messages).toEqual([current]);
      expect(result.compressed).toBe(true);
      expect(reads).toBeLessThanOrEqual(6);
    }
    expect(new Set(counts).size).toBe(1);
  },
);

it('counts each candidate once and gives meter precedence over an opaque count', () => {
  const message = user('hello');
  const count = vi.fn(() => 42);
  expect(compressHistory([message], { system: '', tools: [], maxTokens: 100, count }).tokens).toBe(42);
  expect(count).toHaveBeenCalledTimes(1);
  const meter = new InputTokenMeter();
  meter.observe('', [message], [], 20);
  expect(compressHistory([message], { system: '', tools: [], maxTokens: 100, count, meter }).tokens).toBe(20);
  expect(count).toHaveBeenCalledTimes(1);

  const lists = new Set<readonly Message[]>();
  compressHistory([message, user('earlier'), user('later')], {
    system: '',
    tools: [],
    maxTokens: 0,
    currentUserMessage: message,
    count: (system, messages, tools) => {
      expect(lists.has(messages)).toBe(false);
      lists.add(messages);
      return estimateInputTokens(system, messages, tools);
    },
  });
  expect(lists.size).toBeGreaterThan(3);
});

it('reuses opaque deltas by content, bounds cross-projection caches and prunes them on observe or shell changes', () => {
  const estimate = vi.fn((system: string, messages: readonly Message[], tools: readonly ToolSpec[]) =>
    estimateInputTokens(system, messages, tools, 123),
  );
  const meter = new InputTokenMeter(estimate, 9999);
  const anchor = user('anchor'),
    added = user('added');
  meter.observe('', [anchor, anchor], [], 100);
  expect(estimate.mock.calls.filter(([, messages]) => messages.length === 1)).toHaveLength(1);
  estimate.mockClear();
  meter.count('', [anchor, anchor, added, structuredClone(added)], []);
  meter.count('', [anchor, added], []);
  expect(estimate.mock.calls.map(([, messages]) => messages.length)).toEqual([0, 1]);
  estimate.mockClear();
  meter.observe('', [anchor, added], [], 200);
  expect(estimate.mock.calls.map(([, messages]) => messages.length)).toEqual([2]);

  const messages = Array.from({ length: 1100 }, (_, i) => user(String(i)));
  const counter = meter.counter('', []);
  estimate.mockClear();
  counter(messages);
  counter(messages);
  expect(estimate.mock.calls.filter(([, list]) => list.length === 0)).toHaveLength(1);
  expect(estimate.mock.calls.filter(([, list]) => list.length === 1)).toHaveLength(messages.length);
  estimate.mockClear();
  meter.count('', [messages[0]!], []);
  expect(estimate.mock.calls.map(([, list]) => list.length)).toEqual([0, 1]);

  meter.observe('', [anchor], [], 100);
  estimate.mockClear();
  meter.count('', [added], []);
  expect(estimate.mock.calls.map(([, list]) => list.length)).toEqual([0, 1]);
  meter.count('changed', [], []);
  estimate.mockClear();
  meter.count('', [added], []);
  expect(estimate.mock.calls.map(([, list]) => list.length)).toEqual([0, 1]);
});
