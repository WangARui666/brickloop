import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAIResponsesProvider,
  OpenAIChatCompatibleProvider,
  AnthropicMessagesProvider,
  GeminiProvider,
} from '../src/providers/index.js';
import type { ModelProvider, ChatRequest } from '../src/types.js';
import { collect, image, recordingFetch, request, sse } from './helpers.js';

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('REAL NETWORK IS FORBIDDEN');
    }),
  ),
);
afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;
const calls = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `call-${i}`, name: 'get_part_info', arguments: '{"partId":"3001"}' }));
function responseEvents(count = 2) {
  return [
    { type: 'response.output_text.delta', delta: '你好' },
    { type: 'response.reasoning_summary_text.delta', delta: 'Summary' },
    {
      type: 'response.completed',
      response: {
        output: calls(count).map((c) => ({
          type: 'function_call',
          call_id: c.id,
          name: c.name,
          arguments: c.arguments,
          namespace: 'editor',
        })),
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } },
      },
    },
  ];
}
function chatEvents(count = 2) {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            content: '你好',
            tool_calls: calls(count).map((c, index) => ({
              index,
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.arguments.slice(0, 10) },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls(count).map((c, index) => ({ index, function: { arguments: c.arguments.slice(10) } })),
          },
          finish_reason: count ? 'tool_calls' : 'stop',
        },
      ],
    },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } },
  ];
}
function anthropicEvents(count = 2, reason = count ? 'tool_use' : 'end_turn') {
  return [
    {
      type: 'message_start',
      message: {
        id: 'm',
        role: 'assistant',
        content: [],
        usage: { input_tokens: 70, output_tokens: 0, cache_read_input_tokens: 30 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private thought' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } },
    ...calls(count).flatMap((c, i) => [
      {
        type: 'content_block_start',
        index: i + 2,
        content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} },
      },
      {
        type: 'content_block_delta',
        index: i + 2,
        delta: { type: 'input_json_delta', partial_json: c.arguments.slice(0, 10) },
      },
      {
        type: 'content_block_delta',
        index: i + 2,
        delta: { type: 'input_json_delta', partial_json: c.arguments.slice(10) },
      },
      { type: 'content_block_stop', index: i + 2 },
    ]),
    {
      type: 'message_delta',
      delta: { stop_reason: reason, stop_details: reason === 'refusal' ? { category: 'general_harms' } : null },
      usage: { output_tokens: 20 },
    },
    { type: 'message_stop' },
  ];
}
function geminiEvents(count = 2) {
  return [
    { candidates: [{ content: { role: 'model', parts: [{ text: '你好' }] } }] },
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: calls(count).map((c) => ({
              functionCall: { id: c.id, name: c.name, args: { partId: '3001' } },
              thoughtSignature: 'signed',
            })),
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 30 },
    },
  ];
}
const factories = {
  responses: (fetch: typeof globalThis.fetch): ModelProvider =>
    new OpenAIResponsesProvider({ apiKey: 'test-secret', fetch }),
  compatible: (fetch: typeof globalThis.fetch): ModelProvider =>
    new OpenAIChatCompatibleProvider({ apiKey: 'test-secret', fetch }),
  anthropic: (fetch: typeof globalThis.fetch): ModelProvider =>
    new AnthropicMessagesProvider({ apiKey: 'test-secret', fetch }),
  gemini: (fetch: typeof globalThis.fetch): ModelProvider => new GeminiProvider({ apiKey: 'test-secret', fetch }),
};
const fixtures = {
  responses: responseEvents,
  compatible: chatEvents,
  anthropic: anthropicEvents,
  gemini: geminiEvents,
};
describe.each(Object.keys(factories) as (keyof typeof factories)[])('%s', (kind) => {
  it.each([0, 1, 2])('streams text, usage and %i complete validated calls', async (count) => {
    const mock = recordingFetch([() => sse(fixtures[kind](count), kind === 'anthropic')]);
    const events = await collect(factories[kind](mock.fetcher).stream(request(), signal()));
    expect(events).toContainEqual({ type: 'text_delta', text: '你好' });
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(count);
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30 },
    });
    expect(events.at(-1)).toEqual({ type: 'done', reason: count ? 'tool_calls' : 'stop' });
    expect(mock.fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns parallel results and images in the next request', async () => {
    const mock = recordingFetch([
      () => sse(fixtures[kind](2), kind === 'anthropic'),
      () => sse(fixtures[kind](0), kind === 'anthropic'),
    ]);
    const provider = factories[kind](mock.fetcher);
    const req = request();
    const events = await collect(provider.stream(req, signal()));
    const assistant: ChatRequest['messages'][number] = {
      role: 'assistant',
      content: events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : [])),
    };
    const state = events.find((e) => e.type === 'provider_state');
    if (state?.type === 'provider_state') assistant.providerState = state.state;
    await collect(
      provider.stream(
        {
          ...req,
          messages: [
            ...req.messages,
            assistant,
            {
              role: 'tool',
              content: calls(2).map((c) => ({
                type: 'tool_result',
                id: c.id,
                name: c.name,
                isError: c.id === 'call-1',
                content: [{ type: 'text', text: 'result' }, image],
              })),
            },
          ],
        },
        signal(),
      ),
    );
    const body = mock.bodies[1];
    expect(JSON.stringify(body)).toContain(image.base64);
    if (kind === 'anthropic') {
      expect(body).toMatchObject({
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        fallbacks: 'default',
        cache_control: { type: 'ephemeral' },
        tool_choice: { type: 'auto' },
      });
      const messages = body?.messages as { role: string; content: { type: string; is_error?: boolean }[] }[];
      expect(messages.at(-1)?.content.filter((c) => c.type === 'tool_result')).toHaveLength(2);
      expect(messages.at(-1)?.content[1]?.is_error).toBe(true);
      expect(mock.headers[0]?.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
      expect(JSON.stringify(body)).toContain('eager_input_streaming');
      expect(JSON.stringify(body)).toContain('signed');
    }
    if (kind === 'compatible') {
      const messages = body?.messages as { role: string }[];
      expect(messages.slice(-3).map((m) => m.role)).toEqual(['tool', 'tool', 'user']);
    }
    if (kind === 'responses') expect(JSON.stringify(body)).toContain('input_image');
    if (kind === 'gemini') expect(JSON.stringify(body)).toContain('thoughtSignature');
  });
  it.each([
    [401, 'auth'],
    [402, 'quota_exceeded'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [400, 'invalid_request'],
    [500, 'server'],
  ] as const)('classifies HTTP %i', async (status, category) => {
    const mock = recordingFetch([
      () =>
        new Response(
          JSON.stringify({ error: { type: 'api_error', message: 'test-secret', code: status, status: 'INTERNAL' } }),
          { status, headers: { 'content-type': 'application/json' } },
        ),
    ]);
    const events = await collect(factories[kind](mock.fetcher).stream(request(), signal()));
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { category, status } });
    expect(JSON.stringify(events)).not.toContain('test-secret');
  });
  it('recognizes balance-only HTTP descriptions before invalid_request_error', async () => {
    const mock = recordingFetch([
      () =>
        Response.json(
          { error: { message: 'Insufficient Balance', type: 'invalid_request_error', code: 'invalid_request_error' } },
          { status: 400 },
        ),
    ]);
    const events = await collect(factories[kind](mock.fetcher).stream(request(), signal()));
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { category: 'quota_exceeded', status: 400, providerMessage: 'Insufficient Balance' },
    });
  });
  it('classifies transport failure and truncated streams', async () => {
    const network = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('test-secret'));
    expect((await collect(factories[kind](network).stream(request(), signal()))).at(-1)).toMatchObject({
      type: 'error',
      error: { category: 'network' },
    });
    const mock = recordingFetch([() => sse([], kind === 'anthropic')]);
    expect((await collect(factories[kind](mock.fetcher).stream(request(), signal()))).at(-1)).toMatchObject({
      type: 'error',
      error: { category: 'network' },
    });
  });
  it('returns schema failures to the model without emitting an executable call', async () => {
    const serialized = JSON.stringify(fixtures[kind](1)).replaceAll('partId', 'unsupported');
    const mock = recordingFetch([() => sse(JSON.parse(serialized) as unknown[], kind === 'anthropic')]);
    const events = await collect(factories[kind](mock.fetcher).stream(request(), signal()));
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { code: 'INVALID_TOOL_ARGUMENTS' },
      invalidCall: { name: 'get_part_info' },
    });
  });
  it('does not make requests with an already aborted signal', async () => {
    const mock = recordingFetch([]);
    const controller = new AbortController();
    controller.abort();
    expect((await collect(factories[kind](mock.fetcher).stream(request(), controller.signal))).at(-1)).toEqual({
      type: 'done',
      reason: 'cancelled',
    });
    expect(mock.fetcher).not.toHaveBeenCalled();
  });
});
it.each(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'])(
  'ChatGPT %s is quota_exceeded, including after text',
  async (code) => {
    const mock = recordingFetch([
      () =>
        sse([
          { type: 'response.output_text.delta', delta: 'partial' },
          { type: 'response.failed', response: { error: { code } } },
        ]),
    ]);
    const provider = new OpenAIResponsesProvider({ mode: 'chatgpt', apiKey: 'test', fetch: mock.fetcher });
    const events = await collect(provider.stream({ ...request(), maxOutputTokens: 999 }, signal()));
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { category: 'quota_exceeded', code } });
    expect(events.some((e) => e.type === 'done')).toBe(false);
    const body = mock.bodies[0];
    expect(body).toMatchObject({
      store: false,
      stream: true,
      instructions: 'Stable system',
      tools: [{ type: 'namespace', name: 'editor' }],
    });
    for (const field of [
      'previous_response_id',
      'temperature',
      'top_p',
      'max_output_tokens',
      'max_tool_calls',
      'metadata',
      'truncation',
      'user',
      'background',
      'conversation',
      'moderation',
      'multi_agent',
      'prompt',
      'prompt_cache_retention',
      'safety_identifier',
      'top_logprobs',
    ])
      expect(body).not.toHaveProperty(field);
  },
);
it.each(['refusal', 'max_tokens'])('Anthropic does not release tool calls on %s', async (reason) => {
  const mock = recordingFetch([() => sse(anthropicEvents(2, reason), true)]);
  const events = await collect(
    new AnthropicMessagesProvider({ apiKey: 'test', fetch: mock.fetcher }).stream(request(), signal()),
  );
  expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(0);
  expect(events.at(-1)).toMatchObject(
    reason === 'refusal'
      ? { type: 'error', error: { category: 'refusal', details: { category: 'general_harms' } } }
      : { type: 'done', reason: 'max_tokens' },
  );
});
it('invalid eager tool JSON is returned as a recoverable invalid call', async () => {
  const events = anthropicEvents(1).map((e) =>
    'delta' in e && e.delta && 'partial_json' in e.delta
      ? { ...e, delta: { type: 'input_json_delta', partial_json: 'broken' } }
      : e,
  );
  const mock = recordingFetch([() => sse(events, true)]);
  const result = await collect(
    new AnthropicMessagesProvider({ apiKey: 'test', fetch: mock.fetcher }).stream(request(), signal()),
  );
  expect(result.find((e) => e.type === 'error')).toMatchObject({
    invalidCall: { id: 'call-0' },
    error: { code: 'INVALID_TOOL_ARGUMENTS' },
  });
  expect(result.some((e) => e.type === 'tool_call')).toBe(false);
});
it('lists account-visible models in server order and uses Anthropic model metadata', async () => {
  const openai = recordingFetch([
    () =>
      Response.json({
        models: [
          { slug: 'b', display_name: 'B', visibility: 'list' },
          { slug: 'hidden', display_name: 'X', visibility: 'hidden' },
          { slug: 'a', display_name: 'A', visibility: 'list' },
        ],
      }),
  ]);
  expect(
    await new OpenAIResponsesProvider({ mode: 'chatgpt', apiKey: 'test', fetch: openai.fetcher }).listModels(),
  ).toEqual([
    { id: 'b', name: 'B' },
    { id: 'a', name: 'A' },
  ]);
  const mock = recordingFetch([
    () =>
      Response.json({
        data: [
          {
            id: 'claude-opus-5-5',
            display_name: 'Opus',
            max_input_tokens: 200000,
            max_tokens: 32000,
            capabilities: { image_input: { supported: true }, thinking: { supported: true } },
          },
        ],
        has_more: false,
      }),
  ]);
  const provider = new AnthropicMessagesProvider({ apiKey: 'test', fetch: mock.fetcher });
  expect((await provider.listModels())[0]).toMatchObject({ maxOutputTokens: 32000 });
  expect(provider.capabilities('claude-opus-5-5').maxContext).toBe(200000);
});
it('supports Responses image fallback without discarding the textual tool result', async () => {
  const mock = recordingFetch([() => sse(responseEvents(0))]);
  const provider = new OpenAIResponsesProvider({
    apiKey: 'test',
    fetch: mock.fetcher,
    toolResultImages: 'user-message',
  });
  const req = request();
  await collect(
    provider.stream(
      {
        ...req,
        messages: [
          ...req.messages,
          {
            role: 'assistant',
            content: [{ type: 'tool_call', id: 'c', name: 'render_views', arguments: { views: ['front'] } }],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                id: 'c',
                name: 'render_views',
                content: [{ type: 'text', text: 'result-text' }, image],
              },
            ],
          },
        ],
      },
      signal(),
    ),
  );
  const input = mock.bodies[0]?.input as Record<string, unknown>[];
  expect(input.at(-2)).toMatchObject({ type: 'function_call_output', output: 'result-text' });
  expect(input.at(-1)).toMatchObject({ role: 'user' });
});
it('can disable Anthropic fallback and select xhigh/max effort without manual thinking budgets', async () => {
  const mock = recordingFetch([() => sse(anthropicEvents(0), true)]);
  await collect(
    new AnthropicMessagesProvider({
      apiKey: 'test',
      fetch: mock.fetcher,
      serverSideFallback: false,
      effort: 'max',
    }).stream(request(), signal()),
  );
  expect(mock.bodies[0]).not.toHaveProperty('fallbacks');
  expect(mock.bodies[0]).toMatchObject({ output_config: { effort: 'max' } });
  expect(JSON.stringify(mock.bodies[0])).not.toContain('budget_tokens');
  expect(mock.headers[0]?.get('anthropic-beta')).not.toContain('server-side-fallback');
});
it('maps non-Anthropic refusal responses without releasing tools', async () => {
  const a = recordingFetch([
    () =>
      sse([
        {
          type: 'response.completed',
          response: { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'declined' }] }] },
        },
      ]),
  ]);
  const b = recordingFetch([() => sse([{ choices: [{ delta: {}, finish_reason: 'content_filter' }] }])]);
  const c = recordingFetch([() => sse([{ candidates: [{ finishReason: 'SAFETY' }] }])]);
  for (const [provider, mock] of [
    [factories.responses, a],
    [factories.compatible, b],
    [factories.gemini, c],
  ] as const) {
    expect((await collect(provider(mock.fetcher).stream(request(), signal()))).at(-1)).toMatchObject({
      type: 'error',
      error: { category: 'refusal' },
    });
  }
});

it.each([
  ['subscription_sharing_invalid_user', 'auth'],
  ['subscription_sharing_unsupported_capability', 'invalid_request'],
] as const)('classifies stream error code %s even without HTTP status', async (code, category) => {
  const mock = recordingFetch([() => sse([{ type: 'response.failed', response: { error: { code } } }])]);
  const result = await collect(factories.responses(mock.fetcher).stream(request(), signal()));
  expect(result.at(-1)).toMatchObject({ type: 'error', error: { code, category } });
});

it('replays Gemini calls without inventing protocol IDs when the server omitted them', async () => {
  const mock = recordingFetch([
    () =>
      sse([
        {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'get_part_info', args: { partId: '3001' } }, thoughtSignature: 'signed' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ]),
    () => sse(geminiEvents(0)),
  ]);
  const provider = factories.gemini(mock.fetcher);
  const req = request();
  const events = await collect(provider.stream(req, signal()));
  const tool = events.find((event) => event.type === 'tool_call');
  const state = events.find((event) => event.type === 'provider_state');
  if (tool?.type !== 'tool_call' || state?.type !== 'provider_state') throw new Error('Missing tool');
  await collect(
    provider.stream(
      {
        ...req,
        messages: [
          ...req.messages,
          { role: 'assistant', content: [tool.call], providerState: state.state },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                id: tool.call.id,
                name: tool.call.name,
                content: [{ type: 'text', text: 'done' }],
              },
            ],
          },
        ],
      },
      signal(),
    ),
  );
  const contents = mock.bodies[1]?.contents as { parts: { functionResponse?: { id?: string } }[] }[];
  expect(contents.at(-1)?.parts[0]?.functionResponse).not.toHaveProperty('id');
});

it('uses streamed output items when the plan endpoint completes with an empty output', async () => {
  const item = {
    type: 'function_call',
    call_id: 'call-0',
    name: 'get_part_info',
    arguments: '{"partId":"3001"}',
    namespace: 'editor',
  };
  const mock = recordingFetch([
    () =>
      sse([
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: { output: [], usage: { input_tokens: 4679, output_tokens: 56 } },
        },
      ]),
  ]);
  const provider = new OpenAIResponsesProvider({ mode: 'chatgpt', apiKey: 'test', fetch: mock.fetcher });
  const events = await collect(provider.stream(request(), signal()));
  expect(events.filter((e) => e.type === 'tool_call')).toMatchObject([
    { type: 'tool_call', call: { id: 'call-0', name: 'get_part_info' } },
  ]);
  expect(events.find((e) => e.type === 'provider_state')).toMatchObject({ state: { value: [item] } });
  expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'tool_calls' });
});
