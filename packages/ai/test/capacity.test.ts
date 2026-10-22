import { afterEach, expect, it, vi } from 'vitest';
import { calculateCeiling, outputLimit } from '../src/capacity.js';
import { runAgentTurn } from '../src/agent/runtime.js';
import { estimateInputTokens } from '../src/agent/history.js';
import { SUMMARY_TEMPLATE } from '../src/agent/compaction.js';
import { createEditorTools } from '../src/tools/index.js';
import type { AiError, ChatRequest, Message, ModelProvider } from '../src/types.js';
import { collect, fakeHost } from './helpers.js';

afterEach(() => vi.restoreAllMocks());
it.each([
  [1000000, 850000],
  [200000, 170000],
  [32000, 16000],
  [20000, 17000],
  [null, Infinity],
  [0, Infinity],
])('uses the real capacity reserve for window %s', (window, expected) => {
  expect(calculateCeiling(window)).toBe(expected);
});
it.each([
  [393216, 1000000, 10000, undefined, 256000],
  [32000, 200000, 10000, undefined, 32000],
  [32000, null, 1000000, undefined, 32000],
  [undefined, 1000000, 10000, undefined, undefined],
  [undefined, null, 10000, undefined, undefined],
  [100000, 100000, 80000, undefined, 8000],
  [100000, 100000, 90000, undefined, 1024],
  [393216, 1000000, 10000, 16000, 16000],
  [undefined, null, 10000, 8000, 8000],
] as const)('output capacity %s / %s with input %s and override %s', (max, window, input, override, expected) => {
  expect(
    outputLimit({ contextWindow: window, ...(max === undefined ? {} : { maxOutputTokens: max }) }, input, override),
  ).toBe(expected);
});
const history: Message[] = Array.from({ length: 10 }, (_, index) => [
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'Earlier request ' + index + 'x'.repeat(5000) }] },
  {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'Earlier answer ' + index + 'y'.repeat(5000) }],
  },
]).flat();
const userMessage: Message = { role: 'user', content: [{ type: 'text', text: 'Current request, keep verbatim.' }] };
const overflow: AiError = {
  category: 'invalid_request',
  code: 'CONTEXT_OVERFLOW',
  message: 'rejected',
  providerMessage: 'Prompt too long',
  status: 400,
};
function scenario(rejections: number, mutate = false, window: number | null = null) {
  const requests: ChatRequest[] = [];
  let rejected = 0;
  const provider: ModelProvider = {
    id: 'offline',
    billing: 'api',
    endpoint: 'http://127.0.0.1',
    listModels: async () => [],
    capabilities: () => ({ tools: true, vision: true, reasoning: false, maxContext: 0, contextWindow: window }),
    async *stream(request) {
      if (!request.tools.length) {
        yield { type: 'text_delta', text: SUMMARY_TEMPLATE };
        yield { type: 'done', reason: 'stop' };
        return;
      }
      requests.push({ ...request, messages: structuredClone(request.messages) });
      if (mutate && requests.length === 1) {
        yield {
          type: 'tool_call',
          call: {
            type: 'tool_call',
            id: 'mutation',
            name: 'set_color',
            arguments: { instanceIds: ['i'], colorId: 'S031' },
          },
        };
        yield { type: 'done', reason: 'tool_calls' };
      } else if (rejected++ < rejections) {
        yield { type: 'error', error: { ...overflow, requestId: 'reject-' + rejected } };
      } else {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', reason: 'stop' };
      }
    },
  };
  const host = fakeHost();
  const run = runAgentTurn({
    provider,
    model: 'offline',
    system: '',
    history,
    userMessage,
    host,
    tools: createEditorTools().filter((tool) => tool.name === 'set_color'),
  });
  return { run, requests, host };
}
it.each([false, true])('compacts a rejected request to 70%% without replaying executed tools (%s)', async (mutate) => {
  const { run, requests, host } = scenario(1, mutate);
  const events = await collect(run.events);
  const rejected = requests[mutate ? 1 : 0]!;
  const retry = requests.at(-1)!;
  const size = (r: ChatRequest) => estimateInputTokens(r.system, r.messages, r.tools);
  expect(size(retry)).toBeLessThanOrEqual(Math.floor(size(rejected) * 0.7));
  expect(JSON.stringify(rejected.messages)).toContain('Earlier answer 0');
  expect(JSON.stringify(retry.messages)).not.toContain('Earlier answer 0');
  expect(JSON.stringify(retry.messages)).toContain('[较早上下文摘要]');
  expect(retry.messages).toContainEqual(userMessage);
  expect((await run.result).history.slice(0, history.length)).toEqual(history);
  expect(await run.result).toMatchObject({ reason: 'completed', toolCalls: mutate ? 1 : 0 });
  expect(await run.result).not.toHaveProperty('error');
  expect(host.set_color).toHaveBeenCalledTimes(mutate ? 1 : 0);
  if (mutate) {
    expect(retry.messages.some((m) => m.content.some((b) => b.type === 'tool_result' && b.id === 'mutation'))).toBe(
      true,
    );
    expect(host.commitTransaction).toHaveBeenCalledTimes(1);
  }
  expect(events.filter((e) => e.type === 'history_compressed')).toEqual([
    { type: 'history_compressed', summarized: true, estimatedTokens: size(retry) },
  ]);
});
it('uses 70%, 50%, 35% of the original rejected size and preserves the final provider error', async () => {
  const { run, requests } = scenario(4);
  const events = await collect(run.events);
  expect(requests).toHaveLength(4);
  const size = (r: ChatRequest) => estimateInputTokens(r.system, r.messages, r.tools);
  for (const [i, fraction] of [0.7, 0.5, 0.35].entries())
    expect(size(requests[i + 1]!)).toBeLessThanOrEqual(Math.floor(size(requests[0]!) * fraction));
  expect(events.filter((e) => e.type === 'history_compressed' && e.summarized)).toHaveLength(3);
  expect(await run.result).toMatchObject({ reason: 'input_budget', error: { ...overflow, requestId: 'reject-4' } });
});
it.each([null, 1000000])('does not summarize below a known threshold or for an unknown window (%s)', async (window) => {
  const { run, requests } = scenario(0, false, window);
  const events = await collect(run.events);
  expect(requests[0]!.messages).toEqual([...history, userMessage]);
  expect(events.some((e) => e.type === 'history_compressed')).toBe(false);
});
it('never auto-compacts an unknown window even above opencode’s 200K estimation fallback', async () => {
  const large: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'older request' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(750000) }] },
  ];
  const requests: ChatRequest[] = [];
  const run = runAgentTurn({
    provider: {
      id: 'offline',
      billing: 'api',
      endpoint: 'http://127.0.0.1',
      listModels: async () => [],
      capabilities: () => ({ vision: false, tools: false, reasoning: false, maxContext: 0, contextWindow: null }),
      async *stream(request) {
        requests.push(request);
        yield { type: 'done', reason: 'stop' };
      },
    },
    model: 'unknown',
    system: '',
    history: large,
    userMessage,
    tools: [],
    host: fakeHost(),
  });
  const events = await collect(run.events);
  expect(estimateInputTokens('', [...large, userMessage], [])).toBeGreaterThan(200000);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.messages).toEqual([...large, userMessage]);
  expect(events.some((event) => event.type === 'history_compressed')).toBe(false);
  expect((await run.result).checkpoint).toBeUndefined();
});
it.each([undefined, Infinity, 2147483648])('does not arm an overflowing duration timer (%s)', async (durationMs) => {
  const timer = vi.spyOn(globalThis, 'setTimeout');
  const provider: ModelProvider = {
    id: 'offline',
    billing: 'api',
    endpoint: 'http://127.0.0.1',
    listModels: async () => [],
    capabilities: () => ({ vision: false, tools: false, reasoning: false, maxContext: 0, contextWindow: null }),
    async *stream() {
      yield { type: 'done', reason: 'stop' };
    },
  };
  const run = runAgentTurn({
    provider,
    model: 'offline',
    system: '',
    history: [],
    userMessage,
    host: fakeHost(),
    tools: [],
    ...(durationMs === undefined ? {} : { budget: { durationMs } }),
  });
  await collect(run.events);
  expect((await run.result).reason).toBe('completed');
  // No task deadline is armed; the per-request idle watchdog still protects unlimited turns.
  expect(timer.mock.calls.length).toBeGreaterThan(0);
  expect(timer.mock.calls.every(([, delay]) => delay === 600_000)).toBe(true);
});
