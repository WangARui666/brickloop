import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { createStreamTransport, providerError } from '../src/providers/common.js';
import {
  OpenAIChatCompatibleProvider,
  OpenAIResponsesProvider,
  AnthropicMessagesProvider,
  GeminiProvider,
} from '../src/providers/index.js';
import { watchModelStream } from '../src/agent/stream.js';
import { publicAiError } from '../src/errors.js';
import { withPrivacyPolicy } from '../src/privacy.js';
import { collect, recordingFetch, request } from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
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

const factories = {
  compatible: (fetch: typeof globalThis.fetch) => new OpenAIChatCompatibleProvider({ apiKey: 'fake', fetch }),
  responses: (fetch: typeof globalThis.fetch) => new OpenAIResponsesProvider({ apiKey: 'fake', fetch }),
  anthropic: (fetch: typeof globalThis.fetch) => new AnthropicMessagesProvider({ apiKey: 'fake', fetch }),
  gemini: (fetch: typeof globalThis.fetch) => new GeminiProvider({ apiKey: 'fake', fetch }),
};

it('reports comments and blank lines with an injected clock, preserves bytes and propagates cancellation', async () => {
  const cancel = vi.fn();
  let incoming!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start: (c) => {
      incoming = c;
    },
    cancel,
  });
  const onResponseBytes = vi.fn();
  let now = 7;
  const transport = createStreamTransport(
    async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
    { onResponseBytes },
    () => now,
  );
  const response = await transport.fetch('http://127.0.0.1');
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const reader = response.body!.getReader();
  for (const line of [': keep-alive\n\n', '\n', '\r\n\r\n']) {
    now += 500;
    const bytes = new TextEncoder().encode(line);
    incoming.enqueue(bytes);
    expect((await reader.read()).value).toEqual(bytes);
    expect(onResponseBytes).toHaveBeenLastCalledWith({ receivedAt: now, bytes: bytes.byteLength });
  }
  expect(onResponseBytes).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(onResponseBytes.mock.calls)).not.toContain('keep-alive');
  await reader.cancel('stopped');
  expect(cancel).toHaveBeenCalledWith('stopped');
});

it('forwards raw stream failures', async () => {
  const error = new Error('connection closed');
  const transport = createStreamTransport(
    async () => new Response(new ReadableStream({ pull: (c) => c.error(error) })),
    { onResponseBytes: vi.fn() },
  );
  const response = await transport.fetch('http://127.0.0.1');
  await expect(response.body!.getReader().read()).rejects.toBe(error);
});

it.each([
  new OpenAI.APIConnectionTimeoutError(),
  new Anthropic.APIConnectionTimeoutError(),
  new DOMException('timed out', 'TimeoutError'),
  new OpenAI.APIConnectionError({ cause: new Error('net::ERR_TIMED_OUT') }),
  new OpenAI.APIConnectionError({
    cause: new TypeError('fetch failed', {
      cause: Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    }),
  }),
])('classifies SDK and fetch timeout errors without depending on diagnostic text', (error) => {
  expect(providerError(error)).toMatchObject({ category: 'network', timeout: true });
});

describe.each(Object.keys(factories) as (keyof typeof factories)[])('%s transport', (kind) => {
  it.each([true, false])(
    'preserves parsed HTTP headers; x-should-retry=%s; SDK does not retry',
    async (shouldRetry) => {
      const mock = recordingFetch([
        () =>
          Response.json(
            { error: { message: 'offline rejection', type: 'rate_limit_error', code: 'rate_limit_exceeded' } },
            {
              status: 429,
              headers: { 'retry-after-ms': '7000', 'retry-after': '99', 'x-should-retry': String(shouldRetry) },
            },
          ),
      ]);
      const events = await collect(factories[kind](mock.fetcher).stream(request(), new AbortController().signal));
      const error = events.find((e) => e.type === 'error')!;
      expect(error.type).toBe('error');
      if (error.type !== 'error') return;
      expect(error.error).toMatchObject({ category: 'rate_limit', retryAfterMs: 7000, shouldRetry });
      expect(publicAiError(error.error)).not.toHaveProperty('retryAfterMs');
      expect(publicAiError(error.error)).not.toHaveProperty('shouldRetry');
      expect(error.error.providerMessage).not.toMatch(/retry-after|x-should-retry/);
      expect(mock.fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps an SSE comment-only connection live beyond the timeout, then times out after its last byte', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const mock = recordingFetch([
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (c) => {
              source = c;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ]);
    // Exercise the same privacy adapter used by chat and image workflows.
    const provider = withPrivacyPolicy(factories[kind](mock.fetcher), {
      localOnly: false,
      confirmImages: async () => true,
    });
    const events: { type: string }[] = [];
    const pending = (async () => {
      for await (const event of watchModelStream(provider, request(), new AbortController().signal, 1000))
        events.push(event);
    })();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(400);
      source.enqueue(new TextEncoder().encode(i % 2 ? '\n\n' : ': keep-alive\n\n'));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(events.filter((e) => e.type === 'transport_activity')).toHaveLength(10);
    expect(events.some((e) => e.type === 'activity' || e.type === 'error')).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { category: 'network', code: 'STREAM_STALLED' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out when headers arrive but no body bytes arrive', async () => {
    const mock = recordingFetch([
      () => new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }),
    ]);
    const pending = collect(
      watchModelStream(factories[kind](mock.fetcher), request(), new AbortController().signal, 1000),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([
      { type: 'request_started' },
      { type: 'error', error: { category: 'network', code: 'STREAM_STALLED', message: expect.any(String) } },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('cancels while only comments arrive and keeps concurrent request metadata isolated', async () => {
  let incoming!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const mock = recordingFetch([
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => {
            incoming = c;
          },
          cancel,
        }),
      ),
    () => Response.json({ error: { message: 'rate limit' } }, { status: 429, headers: { 'retry-after-ms': '9000' } }),
    () => Response.json({ error: { message: 'unavailable' } }, { status: 503 }),
  ]);
  const provider = factories.compatible(mock.fetcher);
  const controller = new AbortController();
  const pending = collect(watchModelStream(provider, request(), controller.signal, 1000));
  await vi.advanceTimersByTimeAsync(0);
  incoming.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
  await vi.advanceTimersByTimeAsync(0);
  const second = await collect(provider.stream(request(), new AbortController().signal));
  expect(second.at(-1)).toMatchObject({ type: 'error', error: { retryAfterMs: 9000 } });
  controller.abort();
  const events = await pending;
  expect(events.some((e) => e.type === 'error')).toBe(false);
  const third = await collect(provider.stream(request(), new AbortController().signal));
  expect(third.at(-1)).toMatchObject({ type: 'error', error: { category: 'server', status: 503 } });
  const thirdError = third.find((e) => e.type === 'error');
  expect(thirdError?.error).not.toHaveProperty('retryAfterMs');
  // The SDK may finish cancellation asynchronously; its in-flight read remains observed.
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});
