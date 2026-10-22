import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentTurn, type AgentEvent } from '../src/agent/runtime.js';
import { createEditorTools } from '../src/tools/index.js';
import { DailyCostLedger } from '../src/cost.js';
import type { AiError, ChatEvent, ChatRequest, ModelProvider } from '../src/types.js';
import { collect, fakeHost } from './helpers.js';
import { MAX_RETRIES, RETRY_AFTER_MAX_MS, transientDelay } from '../src/agent/retry.js';
import { parseRetryHeaders } from '../src/errors.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('REAL NETWORK IS FORBIDDEN');
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const failed: AiError = { category: 'network', code: 'INCOMPLETE_STREAM', message: 'closed' };
const call = (id: string): ChatEvent => ({
  type: 'tool_call',
  call: { type: 'tool_call', id, name: 'delete', arguments: { instanceIds: ['i'] } },
});
const usage: ChatEvent = { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5 } };
const success: ChatEvent[] = [{ type: 'text_delta', text: 'finished' }, usage, { type: 'done', reason: 'stop' }];
function setup(rounds: (ChatEvent[] | AiError)[], options: Partial<Parameters<typeof runAgentTurn>[0]> = {}) {
  const requests: ChatRequest[] = [];
  const host = fakeHost();
  const prepareMessages = vi.fn(async (messages: readonly ChatRequest['messages'][number][]) => messages);
  const provider: ModelProvider = {
    id: 'fake',
    billing: 'api',
    endpoint: 'http://127.0.0.1',
    listModels: async () => [],
    capabilities: () => ({ tools: true, vision: true, reasoning: true, maxContext: 0, contextWindow: null }),
    async *stream(request) {
      requests.push(request);
      const events = rounds.shift();
      if (!events) throw new Error('Unexpected request');
      if (!Array.isArray(events)) throw events;
      yield* events;
    },
  };
  const turn = runAgentTurn({
    provider,
    host,
    model: 'test',
    system: '',
    history: [],
    tools: createEditorTools(),
    userMessage: { role: 'user', content: [{ type: 'text', text: 'edit' }] },
    prepareMessages,
    retryRandom: () => 0,
    ...options,
  });
  return { turn, host, requests, prepareMessages };
}

describe('A-111 request retries', () => {
  it('retries only the failed request after mutations; discards partial text, pending tools and replay state, and charges usage', async () => {
    const ledger = new DailyCostLedger();
    const prices = { currency: 'USD' as const, providers: { fake: { test: { input: 1, output: 2, cacheRead: 0.1 } } } };
    const { turn, host, requests, prepareMessages } = setup(
      [
        [call('executed'), usage, { type: 'done', reason: 'tool_calls' }],
        [
          { type: 'text_delta', text: 'discard this' },
          call('pending'),
          { type: 'provider_state', state: { kind: 'openai-compatible-reasoning', reasoning: 'failed thought' } },
          usage,
          { type: 'error', error: { ...failed, providerMessage: 'closed sk-private-123', details: { private: true } } },
        ],
        success,
      ],
      { ledger, prices },
    );
    const pending = collect(turn.events);
    await vi.advanceTimersByTimeAsync(1999);
    expect(requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const events = await pending;
    expect(requests).toHaveLength(3);
    expect(requests[2]).toEqual(requests[1]);
    expect(prepareMessages).toHaveBeenCalledTimes(3);
    expect(host.delete).toHaveBeenCalledTimes(1);
    expect(host.beginTransaction).toHaveBeenCalledTimes(1);
    expect(host.commitTransaction).toHaveBeenCalledTimes(1);
    const result = await turn.result;
    expect(result).toMatchObject({
      reason: 'completed',
      text: 'finished',
      toolCalls: 1,
      requestAttempts: 2,
      usage: { inputTokens: 300, outputTokens: 60, cacheReadInputTokens: 15 },
    });
    expect(result.error).toBeUndefined();
    expect(ledger.spent()).toBeCloseTo(result.cost.amount!);
    expect(JSON.stringify(result.history)).not.toMatch(/discard this|pending|failed thought/);
    const retries = events.filter((e) => e.type === 'retry');
    expect(retries).toEqual([
      {
        type: 'retry',
        attempt: 1,
        delayMs: 2000,
        error: {
          category: 'network',
          code: 'INCOMPLETE_STREAM',
          providerMessage: expect.any(String),
        },
      },
    ]);
    expect(JSON.stringify(retries)).not.toMatch(/sk-private-123|details/);
  });

  it('stops after eleven failures with final diagnostics and capped exponential backoff', async () => {
    const errors = Array.from({ length: 11 }, (_, i): AiError => ({ ...failed, code: 'closed-' + i }));
    const { turn, requests } = setup(errors.map((error) => [{ type: 'error', error }]));
    const pending = collect(turn.events);
    const gaps = [2000, 4000, 8000, ...Array<number>(7).fill(10000)];
    for (const [index, gap] of gaps.entries()) {
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(requests).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
    }
    const events = await pending;
    expect(requests).toHaveLength(11);
    expect(await turn.result).toMatchObject({
      reason: 'error',
      error: errors[10],
      requestAttempts: 11,
      elapsedMs: 84000,
    });
    expect(events.filter((e) => e.type === 'retry').map((e) => [e.attempt, e.delayMs])).toEqual(
      gaps.map((gap, index) => [index + 1, gap]),
    );
  });

  it.each(['signal', 'cancel', 'deadline'] as const)('ends immediately during backoff on %s', async (kind) => {
    const controller = new AbortController();
    const { turn, requests } = setup([[{ type: 'error', error: failed }]], {
      signal: controller.signal,
      ...(kind === 'deadline' ? { budget: { durationMs: 50 } } : {}),
    });
    const pending = collect(turn.events);
    await vi.advanceTimersByTimeAsync(50);
    if (kind === 'signal') controller.abort();
    if (kind === 'cancel') turn.cancel();
    await pending;
    expect(await turn.result).toMatchObject({
      reason: kind === 'deadline' ? 'time_budget' : 'cancelled',
      elapsedMs: 50,
    });
    expect(requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['auth', 'quota_exceeded', 'invalid_request', 'refusal'] as const)('does not retry %s', async (category) => {
    const { turn, requests } = setup([[{ type: 'error', error: { ...failed, category } }]]);
    expect((await collect(turn.events)).filter((e) => e.type === 'retry')).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect((await turn.result).error?.category).toBe(category);
  });

  it.each([
    { category: 'network', code: 'ERR_CONNECTION_CLOSED' },
    { category: 'network', code: 'INCOMPLETE_STREAM' },
    { category: 'server', code: 'STREAM_ABORTED' },
    { category: 'server', code: 'INSUFFICIENT_SYSTEM_RESOURCE' },
    { category: 'rate_limit', code: 'rate_limit_exceeded' },
  ] as const)('retries thrown AiError diagnostics: $code', async (error) => {
    const { turn, requests } = setup([{ ...error, message: 'diagnostic' }, success]);
    const pending = collect(turn.events);
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(requests).toHaveLength(2);
    expect((await turn.result).reason).toBe('completed');
  });

  it('resets the retry allowance after each successful request', async () => {
    const error: ChatEvent[] = [{ type: 'error', error: failed }];
    const { turn } = setup([error, [call('once'), { type: 'done', reason: 'tool_calls' }], error, success]);
    const pending = collect(turn.events);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await pending).filter((e) => e.type === 'retry').map((e) => e.attempt)).toEqual([1, 1]);
    expect(await turn.result).toMatchObject({ reason: 'completed', toolCalls: 1, requestAttempts: 2 });
  });

  it('does not retry a provider cancellation or turn a context overflow into a transient retry', async () => {
    for (const events of [
      [
        { type: 'error', error: failed },
        { type: 'done', reason: 'cancelled' },
      ],
      [{ type: 'error', error: { ...failed, code: 'CONTEXT_OVERFLOW' } }],
    ] as ChatEvent[][]) {
      const { turn } = setup([events]);
      expect((await collect(turn.events)).filter((e) => e.type === 'retry')).toHaveLength(0);
      expect(['cancelled', 'input_budget']).toContain((await turn.result).reason);
    }
  });
});

describe('A-121 schedule and provider instructions', () => {
  it('matches ten seeded jittered gaps and stops at the retry cap', () => {
    let seed = 121;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const gaps = Array.from({ length: MAX_RETRIES }, (_, i) => transientDelay(failed, i, { random })!);
    expect(gaps).toEqual([1859, 3747, 6662, 9633, 9934, 9763, 8752, 8764, 9845, 8668]);
    for (const [i, gap] of gaps.entries()) {
      const cap = Math.min(2000 * 2 ** i, 10000);
      expect(gap).toBeGreaterThanOrEqual(cap * 0.75);
      expect(gap).toBeLessThanOrEqual(cap);
    }
    expect(transientDelay(failed, 10, { random })).toBeUndefined();
  });

  it.each([
    'STREAM_STALLED',
    'ETIMEDOUT',
    'TIMEOUT',
    'REQUEST_TIMEOUT',
    'request_timeout',
    'ERR_CONNECTION_TIMED_OUT',
    'UND_ERR_CONNECT_TIMEOUT',
  ])('allows three timeout retries for %s', async (code) => {
    const { turn, requests } = setup(
      Array.from({ length: 4 }, (): ChatEvent[] => [{ type: 'error', error: { ...failed, code } }]),
    );
    const pending = collect(turn.events);
    await vi.runAllTimersAsync();
    expect((await pending).filter((e) => e.type === 'retry')).toHaveLength(3);
    expect(requests).toHaveLength(4);
    expect((await turn.result).reason).toBe('error');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts timeouts separately in a mixed failure sequence', async () => {
    const timeout = { ...failed, timeout: true };
    const errors = [failed, timeout, failed, timeout, failed, timeout, failed, timeout];
    const { turn, requests } = setup(errors.map((error): ChatEvent[] => [{ type: 'error', error }]));
    const pending = collect(turn.events);
    await vi.runAllTimersAsync();
    expect((await pending).filter((e) => e.type === 'retry')).toHaveLength(7);
    expect(requests).toHaveLength(8);
    expect((await turn.result).error).toEqual(timeout);
  });

  it.each([
    [{ 'retry-after-ms': '6000', 'retry-after': '20' }, 6000, 6000],
    [{ 'retry-after': '8' }, 8000, 8000],
    [{ 'retry-after': '0.5' }, 500, 2000],
    [{ 'retry-after-ms': '0' }, 0, 2000],
    [{ 'retry-after': 'Tue, 20 Oct 2026 00:00:09 GMT' }, 9000, 9000],
    [{ 'retry-after': 'Tue, 20 Oct 2026 00:30:00 GMT' }, 1800000, RETRY_AFTER_MAX_MS],
    [{ 'retry-after-ms': '2000000' }, 2000000, RETRY_AFTER_MAX_MS],
    [{ 'retry-after': '2000' }, 2000000, RETRY_AFTER_MAX_MS],
    [{ 'retry-after-ms': 'invalid', 'retry-after': '6' }, 6000, 6000],
  ] as const)('parses and respects %j without shortening backoff', (headers, parsed, delay) => {
    const metadata = parseRetryHeaders(new Headers(headers), () => Date.parse('2026-10-20T00:00:00Z'));
    expect(metadata).toEqual({ retryAfterMs: parsed });
    expect(transientDelay({ ...failed, ...metadata }, 0, { random: () => 0 })).toBe(delay);
  });

  it.each(['-1', 'Infinity', 'NaN', 'invalid', 'Mon, 19 Oct 2026 00:00:00 GMT'])(
    'ignores invalid or past Retry-After %s',
    (value) => {
      expect(
        parseRetryHeaders(new Headers({ 'retry-after': value }), () => Date.parse('2026-10-20T00:00:00Z')),
      ).toEqual({});
    },
  );

  it('obeys explicit retry instructions, including the cap, and ignores unknown values', async () => {
    for (const shouldRetry of [true, false]) {
      const metadata = parseRetryHeaders(new Headers({ 'x-should-retry': String(shouldRetry) }));
      expect(metadata).toEqual({ shouldRetry });
      const error: AiError = {
        category: shouldRetry ? 'invalid_request' : 'server',
        message: 'failed',
        ...metadata,
      };
      const { turn, requests } = setup([[{ type: 'error', error }], success]);
      const pending = collect(turn.events);
      await vi.runAllTimersAsync();
      expect((await pending).filter((e) => e.type === 'retry')).toHaveLength(shouldRetry ? 1 : 0);
      expect(requests).toHaveLength(shouldRetry ? 2 : 1);
      expect(transientDelay(error, 10)).toBeUndefined();
    }
    expect(parseRetryHeaders(new Headers({ 'x-should-retry': 'yes' }))).toEqual({});
  });

  it('retains the actual provider wait with a shortened test backoff and releases it on stop', async () => {
    const { turn, requests } = setup([[{ type: 'error', error: { ...failed, retryAfterMs: 900000 } }]], {
      retryDelayMs: 10,
    });
    const events: AgentEvent[] = [];
    const pending = (async () => {
      for await (const event of turn.events) events.push(event);
    })();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.find((e) => e.type === 'retry')).toMatchObject({ attempt: 1, delayMs: 900000 });
    expect(requests).toHaveLength(1);
    turn.cancel();
    await pending;
    expect((await turn.result).reason).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });
});
