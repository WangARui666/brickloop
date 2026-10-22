import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  runAgentTurn,
  buildSystemPrompt,
  compressHistory,
  estimateInputTokens,
  SUMMARY_PROMPT,
  SUMMARY_TEMPLATE,
} from '../src/agent/index.js';
import { createEditorTools } from '../src/tools/index.js';
import type { ChatEvent, ChatRequest, ModelProvider, Message } from '../src/types.js';
import { DailyCostLedger, estimateCost, priceTableSchema } from '../src/cost.js';
import { ApiKeyStore, maskSecret, redact } from '../src/secrets.js';
import { createPrivacyFetch, withPrivacyPolicy, writeDebugEvent } from '../src/privacy.js';
import { collect, fakeHost, image, ok } from './helpers.js';
beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('REAL NETWORK IS FORBIDDEN');
    }),
  ),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fakeProvider(rounds: ChatEvent[][]) {
  const requests: ChatRequest[] = [];
  const provider: ModelProvider = {
    id: 'test',
    billing: 'api',
    endpoint: 'https://unit.test',
    listModels: async () => [],
    capabilities: () => ({ tools: true, vision: true, reasoning: true, maxContext: 128000, contextWindow: 128000 }),
    async *stream(request) {
      requests.push(structuredClone({ ...request, tools: [] }));
      const round = rounds.shift();
      if (!round) throw new Error('Unexpected round');
      yield* round;
    },
  };
  return { provider, requests };
}
const call = (name: string, args: unknown, id = 'call'): ChatEvent => ({
  type: 'tool_call',
  call: { type: 'tool_call', id, name, arguments: args },
});
const done: ChatEvent = { type: 'done', reason: 'tool_calls' };
const finish: ChatEvent[] = [
  { type: 'text_delta', text: '已完成。' },
  { type: 'done', reason: 'stop' },
];
const userMessage: Message = { role: 'user', content: [{ type: 'text', text: '修改模型' }] };
it('charges a completed request while its task is still running, so concurrent tasks see the shared limit', async () => {
  const { provider } = fakeProvider([
    [{ type: 'usage', usage: { inputTokens: 1000000, outputTokens: 0, cacheReadInputTokens: 0 } }, done],
  ]);
  const ledger = new DailyCostLedger(),
    prices = priceTableSchema.parse({
      currency: 'USD',
      providers: { test: { test: { input: 2, output: 0, cacheRead: 0 } } },
    });
  const first = turn(provider, { ledger, prices, budget: { dailyCostLimit: 1 } });
  const iterator = first.events;
  await iterator.next(); // request_started
  await iterator.next(); // usage, request not closed yet
  await iterator.next(); // done
  await iterator.next(); // closes request and checks budget before another request
  expect(ledger.spent()).toBe(2);
  const second = turn(provider, { ledger, prices, budget: { dailyCostLimit: 1 } });
  await collect(second.events);
  expect((await second.result).reason).toBe('daily_cost_limit');
  await collect(iterator);
  expect(ledger.spent()).toBe(2); // no duplicate charge at the turn boundary
});
function turn(provider: ModelProvider, overrides: Partial<Parameters<typeof runAgentTurn>[0]> = {}) {
  return runAgentTurn({
    provider,
    model: 'test',
    system: buildSystemPrompt(),
    history: [],
    userMessage,
    tools: createEditorTools(),
    host: fakeHost(),
    ...overrides,
  });
}
it.each([
  { mode: 'projection then summary', expected: [false, true] },
  { mode: 'summary only', expected: [true] },
  { mode: 'projection only', expected: [false] },
  { mode: 'no compression', expected: [] },
])('reports the first compression and first budget summary per turn: $mode', async ({ mode, expected }) => {
  const grows = mode === 'projection then summary' || mode === 'summary only';
  const rounds = Array.from({ length: 3 }, (_, index): ChatEvent[] => [
    { type: 'text_delta', text: grows && index > 0 ? 'large '.repeat(2000) : 'Continue.' },
    call('get_model_summary', {}, `summary-${index}`),
    done,
  ]);
  const { provider, requests } = fakeProvider([...rounds, finish]);
  const history: Message[] =
    mode === 'no compression'
      ? []
      : [
          {
            role: 'user',
            content: [
              { type: 'text', text: mode === 'summary only' ? 'old '.repeat(3000) : 'Earlier request' },
              ...(mode.startsWith('projection') ? [image] : []),
            ],
          },
          { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
        ];
  const tools = createEditorTools().filter((tool) => tool.name === 'get_model_summary');
  let preparations = 0;
  let preparationAtRequest = 0;
  const originalStream = provider.stream.bind(provider);
  provider.stream = async function* (request, signal) {
    if (
      request.messages.at(-1)?.content.some((block) => block.type === 'text' && block.text.includes(SUMMARY_PROMPT))
    ) {
      yield { type: 'text_delta', text: SUMMARY_TEMPLATE };
      yield { type: 'done', reason: 'stop' };
      return;
    }
    preparationAtRequest = preparations;
    yield* originalStream(request, signal);
  };
  const run = turn(provider, {
    system: '',
    history,
    tools,
    budget: { inputTokens: 2000 },
    prepareMessages: async (messages) => {
      preparations++;
      return messages;
    },
  });
  const summaries: boolean[] = [];
  for await (const event of run.events) {
    if (event.type !== 'history_compressed') continue;
    // The provider must already have started the request for this gate snapshot.
    expect(requests.length).toBeGreaterThan(0);
    expect(preparationAtRequest).toBe(preparations);
    expect(event.estimatedTokens).toBe(estimateInputTokens('', requests.at(-1)!.messages, tools));
    summaries.push(event.summarized);
  }
  expect((await run.result).reason).toBe('completed');
  expect(requests).toHaveLength(4);
  expect(summaries).toEqual(expected);
});
it('groups mutations in exactly one transaction and returns issues and images to the model', async () => {
  const { provider, requests } = fakeProvider([
    [
      call('set_color', { instanceIds: ['i'], colorId: 'S031' }),
      call('render_views', { views: ['front'] }, 'render'),
      done,
    ],
    [call('validate', {}, 'validate'), done],
    finish,
  ]);
  const host = fakeHost();
  vi.mocked(host.set_color).mockResolvedValue({
    ok: true,
    data: {},
    introducedIssues: [{ kind: 'collision', a: 'i', b: 'j' }],
    warnings: [],
  });
  vi.mocked(host.render_views).mockResolvedValue({
    ok: true,
    data: { images: [image] },
    introducedIssues: [],
    warnings: [],
  });
  vi.mocked(host.validate).mockResolvedValue(ok({ issues: [] }));
  const run = turn(provider, { host });
  const events = await collect(run.events);
  const result = await run.result;
  expect(result).toMatchObject({ reason: 'completed', text: '已完成。', toolCalls: 3, unresolvedIssues: [] });
  expect(host.beginTransaction).toHaveBeenCalledTimes(1);
  expect(host.commitTransaction).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(requests[1]?.messages)).toContain('Resolve introduced validation issues');
  expect(JSON.stringify(requests[1]?.messages)).toContain(image.base64);
  expect(requests.every((r) => r.system === requests[0]?.system)).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: 'finished', result });
});
it('rejects invalid calls without mutating, returns errors together, and lets the model repair them', async () => {
  const { provider, requests } = fakeProvider([
    [
      call('set_color', { colorId: 'red' }),
      {
        type: 'error',
        error: { category: 'invalid_request', message: 'Invalid JSON' },
        invalidCall: { type: 'tool_call', id: 'bad', name: 'move', arguments: '{' },
      },
      done,
    ],
    finish,
  ]);
  const host = fakeHost();
  const run = turn(provider, { host });
  await collect(run.events);
  expect((await run.result).reason).toBe('completed');
  expect(host.beginTransaction).not.toHaveBeenCalled();
  const results = requests[1]?.messages.find((m) => m.role === 'tool');
  expect(results?.content).toHaveLength(2);
  expect(results?.content.every((b) => b.type === 'tool_result' && b.isError)).toBe(true);
});
it('stops starting tools at the budget and asks for a final summary', async () => {
  const { provider, requests } = fakeProvider([
    [call('delete', { instanceIds: ['i'] }), call('delete', { instanceIds: ['j'] }, 'second'), done],
    finish,
  ]);
  const host = fakeHost();
  const run = turn(provider, { host, budget: { toolCalls: 1 } });
  await collect(run.events);
  expect((await run.result).reason).toBe('tool_budget');
  expect(host.delete).toHaveBeenCalledTimes(1);
  expect(host.commitTransaction).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(requests[1]?.messages)).toContain('tool-call budget has been exhausted');
});
it('allows a running tool to finish after cancellation, skips the next tool and commits', async () => {
  const controller = new AbortController();
  const host = fakeHost();
  vi.mocked(host.delete).mockImplementation(async () => {
    controller.abort();
    await Promise.resolve();
    return ok();
  });
  const { provider, requests } = fakeProvider([
    [call('delete', { instanceIds: ['i'] }), call('delete', { instanceIds: ['j'] }, 'next'), done],
  ]);
  const run = turn(provider, { host, signal: controller.signal });
  await collect(run.events);
  expect((await run.result).reason).toBe('cancelled');
  expect(host.delete).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(1);
  expect(host.beginTransaction).toHaveBeenCalledTimes(1);
  expect(host.commitTransaction).toHaveBeenCalledTimes(1);
});
it('does not start a mutation if cancellation arrives while opening the transaction', async () => {
  const controller = new AbortController();
  const host = fakeHost();
  vi.mocked(host.beginTransaction).mockImplementation(async () => {
    controller.abort();
  });
  const { provider } = fakeProvider([[call('delete', { instanceIds: ['i'] }), done]]);
  const run = turn(provider, { host, signal: controller.signal });
  await collect(run.events);
  expect(host.delete).not.toHaveBeenCalled();
  expect(host.commitTransaction).toHaveBeenCalledTimes(1);
});
it.each(['cancelled', 'error', 'max_tokens'] as const)('commits prior mutations on %s', async (reason) => {
  const terminal: ChatEvent =
    reason === 'error'
      ? { type: 'error', error: { category: 'invalid_request', message: 'failed' } }
      : { type: 'done', reason };
  const { provider } = fakeProvider([[call('delete', { instanceIds: ['i'] }), done], [terminal]]);
  const host = fakeHost();
  const run = turn(provider, { host });
  await collect(run.events);
  expect((await run.result).reason).toBe(reason);
  expect(host.commitTransaction).toHaveBeenCalledTimes(1);
});
it('commits when the event consumer breaks iteration and preserves complete call/result history', async () => {
  const { provider } = fakeProvider([
    [call('delete', { instanceIds: ['i'] }), call('delete', { instanceIds: ['j'] }, 'next'), done],
  ]);
  const host = fakeHost();
  const run = turn(provider, { host });
  for await (const event of run.events) if (event.type === 'tool_result') break;
  const result = await run.result;
  expect(result.reason).toBe('cancelled');
  expect(host.commitTransaction).toHaveBeenCalledTimes(1);
  expect(result.history.at(-1)?.content).toHaveLength(2);
});
it('does not execute untrusted provider calls when the terminal event is missing', async () => {
  vi.useFakeTimers();
  const { provider } = fakeProvider(Array.from({ length: 4 }, () => [call('delete', { instanceIds: ['i'] })]));
  const host = fakeHost();
  const run = turn(provider, { host });
  const pending = collect(run.events);
  await vi.advanceTimersByTimeAsync(40000);
  await pending;
  expect((await run.result).reason).toBe('error');
  expect(host.delete).not.toHaveBeenCalled();
});
it('enforces elapsed time while a provider is streaming', async () => {
  const { provider } = fakeProvider([]);
  provider.stream = async function* (_request, signal) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    yield { type: 'done', reason: 'cancelled' };
  };
  const run = turn(provider, { budget: { durationMs: 10 } });
  await collect(run.events);
  expect((await run.result).reason).toBe('time_budget');
});
it('compresses old tool results without orphaning calls, preserves the summary and recent request', () => {
  const history: Message[] = [
    userMessage,
    { role: 'assistant', content: [{ type: 'tool_call', id: 'old', name: 'get_model_summary', arguments: {} }] },
    {
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          id: 'old',
          name: 'get_model_summary',
          content: [{ type: 'text', text: 'x'.repeat(30000) }, image],
        },
      ],
    },
    ...Array.from({ length: 5 }, () => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'recent' }],
    })),
  ];
  const copy = JSON.stringify(history);
  const compressed = compressHistory(history, {
    system: 'system',
    tools: [],
    maxTokens: 500,
    modelSummary: 'House, 20 bricks.',
  });
  expect(compressed.compressed).toBe(true);
  expect(compressed.tokens).toBeLessThanOrEqual(500);
  expect(JSON.stringify(compressed.messages)).toContain('House, 20 bricks.');
  expect(JSON.stringify(compressed.messages)).toContain('recent');
  expect(JSON.stringify(history)).toBe(copy);
});
it('refuses an irreducible input budget without a network request', async () => {
  const { provider, requests } = fakeProvider([]);
  const run = turn(provider, { budget: { inputTokens: 10 } });
  await collect(run.events);
  expect((await run.result).reason).toBe('input_budget');
  expect(requests).toHaveLength(0);
  expect(estimateInputTokens('中文', [userMessage], createEditorTools())).toBeGreaterThan(10);
});
const prices = priceTableSchema.parse({
  currency: 'USD',
  providers: { test: { test: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } } },
});
it('calculates cache-aware costs and persists daily totals for the next turn', async () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadInputTokens: 200_000,
    cacheWriteInputTokens: 100_000,
  };
  expect(estimateCost(prices, 'test', 'test', usage).amount).toBeCloseTo(2.69);
  const ledger = new DailyCostLedger();
  const { provider } = fakeProvider([[{ type: 'usage', usage }, ...finish]]);
  const run = turn(provider, { prices, ledger, budget: { dailyCostLimit: 2 } });
  await collect(run.events);
  expect(ledger.spent()).toBeCloseTo(2.69);
  const second = turn(provider, { prices, ledger, budget: { dailyCostLimit: 2 } });
  await collect(second.events);
  expect((await second.result).reason).toBe('daily_cost_limit');
  expect(new DailyCostLedger(ledger.snapshot()).spent()).toBeCloseTo(2.69);
});
it('resets ledger days, rejects unpriced spending caps and exempts ChatGPT plan usage', async () => {
  let now = Date.UTC(2026, 0, 1);
  const ledger = new DailyCostLedger({}, () => now);
  ledger.add(2);
  now += 86400000;
  expect(ledger.spent()).toBe(0);
  const { provider } = fakeProvider([finish]);
  let run = turn(provider, { ledger, budget: { dailyCostLimit: 1 } });
  await collect(run.events);
  expect((await run.result).error?.code).toBe('COST_CONFIGURATION_REQUIRED');
  run = turn({ ...provider, billing: 'plan' }, { ledger, budget: { dailyCostLimit: 0 } });
  await collect(run.events);
  expect((await run.result).cost).toMatchObject({ amount: null, label: '使用套餐额度' });
  expect(ledger.spent()).toBe(0);
  expect(() =>
    priceTableSchema.parse({ currency: 'USD', providers: { p: { m: { input: -1, output: 1, cacheRead: 0 } } } }),
  ).toThrow();
});
it('redacts credentials and keeps debug logs local with a seven-day retention boundary', async () => {
  const map = new Map<string, string>();
  const keys = new ApiKeyStore({
    get: async (k) => map.get(k),
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
  });
  await keys.set('p', 'secret1234');
  expect(await keys.display('p')).toBe('****1234');
  await keys.delete('p');
  expect(await keys.get('p')).toBeUndefined();
  expect(maskSecret('abc')).toBe('****');
  expect(redact('Bearer token-value https://auth.test?code=secret&id_token_hint=hint sk-private1234')).not.toContain(
    'token-value',
  );
  const store = { append: vi.fn().mockResolvedValue(undefined), deleteBefore: vi.fn().mockResolvedValue(undefined) };
  await writeDebugEvent(
    store,
    'p',
    { type: 'error', error: { category: 'auth', message: 'secret1234' } },
    { secrets: ['secret1234'], now: 10 * 86400000 },
  );
  expect(store.deleteBefore).toHaveBeenCalledWith(3 * 86400000);
  expect(store.append).toHaveBeenCalledWith(expect.objectContaining({ message: 'auth:  ****1234' }));
});
it('blocks cloud traffic in local-only mode and prompts before sending the first cloud image', async () => {
  const { provider, requests } = fakeProvider([finish, finish]);
  const confirmImages = vi.fn().mockResolvedValue(true);
  const req = { model: 'test', system: '', messages: [{ role: 'user' as const, content: [image] }], tools: [] };
  const blocked = withPrivacyPolicy(provider, { localOnly: true, confirmImages });
  expect((await collect(blocked.stream(req, new AbortController().signal)))[0]).toMatchObject({
    error: { code: 'LOCAL_ONLY_POLICY' },
  });
  expect(requests).toHaveLength(0);
  const allowed = withPrivacyPolicy(provider, { localOnly: false, confirmImages });
  await collect(allowed.stream(req, new AbortController().signal));
  await collect(allowed.stream(req, new AbortController().signal));
  expect(confirmImages).toHaveBeenCalledTimes(1);
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
  const local = createPrivacyFetch({ localOnly: true, fetch: transport });
  await expect(local('https://remote.test')).rejects.toThrow('LOCAL_ONLY_POLICY');
  await local('http://127.0.0.1:8000/v1');
  expect(transport).toHaveBeenCalledWith('http://127.0.0.1:8000/v1', expect.objectContaining({ redirect: 'error' }));
});

it.each(['active', 'recovered', 'exhausted', 'stopped', 'deadline'] as const)(
  'A-116 agent watchdog: %s',
  async (mode) => {
    vi.useFakeTimers();
    const { provider } = fakeProvider([]);
    const signals: AbortSignal[] = [];
    const requests: ChatRequest[] = [];
    provider.stream = async function* (request, signal) {
      signals.push(signal);
      requests.push(request);
      if (mode === 'active') {
        for (let i = 0; i < 5; i++) {
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          yield i % 2
            ? { type: 'usage', usage: { inputTokens: 1, outputTokens: i, cacheReadInputTokens: 0 } }
            : { type: 'activity', reasoningChars: i + 1, contentChars: 0, toolChars: 0 };
        }
      } else if (mode !== 'recovered' || signals.length === 1) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'done', reason: 'cancelled' };
        return;
      }
      yield* finish;
    };
    const run = turn(provider, {
      streamStallMs: 50,
      retryDelayMs: 10,
      ...(mode === 'deadline' ? { budget: { durationMs: 30 } } : {}),
    });
    const pending = collect(run.events);
    await vi.advanceTimersByTimeAsync(30);
    if (mode === 'stopped') run.cancel();
    await vi.advanceTimersByTimeAsync(500);
    const events = await pending;
    const result = await run.result;
    expect(result.reason).toBe(
      mode === 'active' || mode === 'recovered'
        ? 'completed'
        : mode === 'stopped'
          ? 'cancelled'
          : mode === 'deadline'
            ? 'time_budget'
            : 'error',
    );
    const errors = events.filter((e) => e.type === 'error');
    const count = mode === 'recovered' ? 1 : mode === 'exhausted' ? 4 : 0;
    expect(errors).toHaveLength(count);
    for (const event of errors) {
      expect(event.error).toMatchObject({ category: 'network', code: 'STREAM_STALLED' });
      expect(event.error).not.toHaveProperty('providerMessage');
    }
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(Math.min(3, count));
    if (mode === 'recovered') {
      expect(requests[0]).toEqual(requests[1]);
      expect(result.error).toBeUndefined();
    }
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);
