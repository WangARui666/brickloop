import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpenAIChatCompatibleProvider, presetCapabilities } from '../src/providers/index.js';
import { runAgentTurn } from '../src/agent/runtime.js';
import { createEditorTools } from '../src/tools/index.js';
import { collect, fakeHost, recordingFetch, request, sse } from './helpers.js';
import type { Message, ModelCapabilities } from '../src/types.js';

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
const end = (reason: string | null) => sse([{ choices: [{ delta: {}, finish_reason: reason }] }]);

it.each([
  ['length', 'max_tokens'],
  ['insufficient_system_resource', 'INSUFFICIENT_SYSTEM_RESOURCE'],
  ['aborted', 'STREAM_ABORTED'],
  ['unexpected', 'UNEXPECTED_FINISH_REASON'],
  [null, 'INCOMPLETE_STREAM'],
] as const)('distinguishes compatible finish_reason %s without releasing incomplete tools', async (reason, code) => {
  const mock = recordingFetch([
    () =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'bad', function: { name: 'get_part_info', arguments: '{"partId":' } }],
              },
              finish_reason: reason,
            },
          ],
        },
      ]),
  ]);
  const events = await collect(
    new OpenAIChatCompatibleProvider({ apiKey: 'test', fetch: mock.fetcher }).stream(request(), signal()),
  );
  expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  expect(events.at(-1)).toMatchObject(
    reason === 'length'
      ? { type: 'done', reason: code }
      : {
          type: 'error',
          error: { code, category: reason ? 'server' : 'network', ...(reason ? { finishReason: reason } : {}) },
        },
  );
});
it('bounds and redacts HTTP body messages, Bearer tokens, known async keys and URL queries', async () => {
  const secret = 'arbitrary-credential-123';
  const mock = recordingFetch([
    () =>
      Response.json(
        {
          error: {
            message:
              'Bad parameter sk-test-123 ' +
              secret +
              '\nBearer opaque-token https://example.test/a?secret=hidden&x=1 ' +
              'detail '.repeat(100),
            type: 'invalid_request_error',
            code: 'invalid_parameter',
          },
        },
        { status: 400, headers: { 'x-request-id': 'request-123' } },
      ),
  ]);
  const events = await collect(
    new OpenAIChatCompatibleProvider({ apiKey: async () => secret, fetch: mock.fetcher }).stream(request(), signal()),
  );
  const event = events.at(-1);
  expect(event).toMatchObject({
    type: 'error',
    error: { status: 400, code: 'invalid_parameter', category: 'invalid_request', requestId: 'request-123' },
  });
  if (event?.type !== 'error') throw new Error('Missing error');
  expect(event.error.providerMessage).toMatch(/^Bad parameter/);
  expect(event.error.providerMessage!.length).toBeLessThanOrEqual(300);
  for (const value of ['sk-test-123', secret, 'opaque-token', '?secret', 'hidden', '\n'])
    expect(event.error.providerMessage).not.toContain(value);
});
it.each([
  [
    402,
    { message: 'Insufficient Balance', type: 'invalid_request_error', param: null, code: 'invalid_request_error' },
    'quota_exceeded',
  ],
  [402, { message: 'Insufficient Balance', type: 'invalid_request_error', param: null, code: null }, 'quota_exceeded'],
  [402, { message: 'Payment Required', code: 'invalid_request_error' }, 'quota_exceeded'],
  [400, { message: 'Insufficient Balance' }, 'quota_exceeded'],
  [
    400,
    { message: 'Invalid parameter', type: 'invalid_request_error', code: 'invalid_request_error' },
    'invalid_request',
  ],
] as const)('classifies DeepSeek HTTP %s with body %j as %s', async (status, error, category) => {
  const mock = recordingFetch([() => Response.json({ error }, { status })]);
  const provider = new OpenAIChatCompatibleProvider({ preset: 'deepseek', apiKey: 'test', fetch: mock.fetcher });
  const events = await collect(provider.stream({ ...request(), model: 'deepseek-flash' }, signal()));
  expect(events.at(-1)).toMatchObject({ type: 'error', error: { status, category, providerMessage: error.message } });
  expect(mock.fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  'Insufficient Balance',
  'insufficient_balance',
  '账户余额不足',
  'Account in arrears',
  'Credit Balance too low',
])('recognizes balance text %s in either the provider message or code', async (text) => {
  for (const error of [
    { message: text, code: 'invalid_request_error' },
    { message: 'Request rejected', code: text },
  ]) {
    const mock = recordingFetch([() => Response.json({ error }, { status: 400 })]);
    const provider = new OpenAIChatCompatibleProvider({ preset: 'deepseek', apiKey: 'test', fetch: mock.fetcher });
    expect((await collect(provider.stream(request(), signal()))).at(-1)).toMatchObject({
      type: 'error',
      error: { category: 'quota_exceeded', status: 400, providerMessage: error.message, code: error.code },
    });
  }
});
it('discards unsafe finish reasons', async () => {
  const mock = recordingFetch([() => end('BAD sk-unsafe')]);
  const events = await collect(
    new OpenAIChatCompatibleProvider({ apiKey: 'test', fetch: mock.fetcher }).stream(request(), signal()),
  );
  expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'UNEXPECTED_FINISH_REASON' } });
  expect(JSON.stringify(events)).not.toContain('BAD sk-unsafe');
});
it.each([
  [393216, 1000000, 600000, undefined, 256000],
  [32000, 200000, 120000, undefined, 32000],
  [100000, 100000, 90000, undefined, 1024],
  [393216, 1000000, 600000, 16000, 16000],
  [undefined, null, 76800, undefined, undefined],
] as const)(
  'sends bounded max_tokens (%s, window %s, estimated input %s)',
  async (max, window, budget, override, expected) => {
    const mock = recordingFetch([() => end('stop')]);
    const capabilities: ModelCapabilities = {
      vision: true,
      tools: true,
      reasoning: true,
      maxContext: window ?? 128000,
      contextWindow: window,
      ...(max !== undefined ? { maxOutputTokens: max } : {}),
    };
    const provider = new OpenAIChatCompatibleProvider({
      apiKey: 'test',
      fetch: mock.fetcher,
      modelCapabilities: { model: capabilities },
    });
    const turn = runAgentTurn({
      provider,
      model: 'model',
      system: 's',
      history: [],
      userMessage: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      tools: [],
      host: fakeHost(),
      budget: { inputTokens: budget + 100 },
      countInputTokens: () => budget,
      ...(override !== undefined ? { maxOutputTokens: override } : {}),
    });
    await collect(turn.events);
    expect((await turn.result).reason).toBe('completed');
    if (expected === undefined) expect(mock.bodies[0]).not.toHaveProperty('max_tokens');
    else expect(mock.bodies[0]?.max_tokens).toBe(expected);
  },
);
it('DeepSeek replays thoughts and summarizes earlier incomplete turns while preserving the active turn', async () => {
  const thought = 'private\nthought: 原样回传';
  const mock = recordingFetch([
    () =>
      sse([
        { choices: [{ delta: { reasoning_content: 'private\n' }, finish_reason: null }] },
        {
          choices: [
            {
              delta: {
                reasoning_content: 'thought: 原样回传',
                tool_calls: [
                  { index: 0, id: 'c1', function: { name: 'get_part_info', arguments: '{"partId":"3001"}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]),
    () => end('stop'),
  ]);
  const provider = new OpenAIChatCompatibleProvider({ preset: 'deepseek', apiKey: 'test', fetch: mock.fetcher });
  const user: Message = { role: 'user', content: [{ type: 'text', text: '  当前要求\n逐字 保留\n' }] };
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: '早先的要求' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'old answer without reasoning' }] },
  ];
  const turn = runAgentTurn({
    provider,
    model: 'deepseek-flash',
    system: 's',
    history,
    userMessage: user,
    tools: createEditorTools(),
    host: fakeHost(),
  });
  await collect(turn.events);
  expect((await turn.result).reason).toBe('completed');
  for (const body of mock.bodies) {
    const messages = body.messages as { role: string; content: unknown; reasoning_content?: string }[];
    expect(JSON.stringify(messages)).toContain('[较早上下文摘要]');
    expect(JSON.stringify(messages)).not.toContain('old answer without reasoning');
    expect(
      messages.find((m) => m.role === 'user' && JSON.stringify(m.content) === JSON.stringify(user.content)),
    ).toBeDefined();
    expect(messages.filter((m) => m.role === 'assistant').every((m) => typeof m.reasoning_content === 'string')).toBe(
      true,
    );
  }
  const replay = (
    mock.bodies[1]?.messages as { role: string; reasoning_content?: string; tool_calls?: unknown[] }[]
  ).find((m) => m.role === 'assistant');
  expect(replay?.reasoning_content).toBe(thought);
  expect(replay?.tool_calls).toEqual([
    { type: 'function', id: 'c1', function: { name: 'get_part_info', arguments: '{"partId":"3001"}' } },
  ]);
  expect(history[1]).not.toHaveProperty('providerState');
  expect((await turn.result).history.find((m) => m.providerState)?.providerState).toEqual({
    kind: 'openai-compatible-reasoning',
    reasoning: thought,
  });
});
it('exposes only verified preset limits', () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro'])
    expect(presetCapabilities('deepseek', model)).toMatchObject({
      contextWindow: 1000000,
      maxContext: 1000000,
      maxOutputTokens: 393216,
      reasoningReplay: true,
      tools: true,
      vision: !model.endsWith('pro'),
    });
  for (const [preset, model] of [
    ['qwen', 'qwen-plus'],
    ['custom', 'unknown'],
  ])
    expect(presetCapabilities(preset, model!)).toMatchObject({
      contextWindow: null,
      maxOutputTokens: null,
      reasoningReplay: false,
    });
});

it.each(['anthropic', 'gemini'] as const)('%s uses catalog output limits in agent requests', async (kind) => {
  const mock = recordingFetch([
    () =>
      kind === 'anthropic'
        ? Response.json({
            data: [{ id: 'model', display_name: 'Model', max_input_tokens: 200000, max_tokens: 32000 }],
            has_more: false,
          })
        : Response.json({ models: [{ name: 'models/model', inputTokenLimit: 200000, outputTokenLimit: 32000 }] }),
    () =>
      kind === 'anthropic'
        ? sse(
            [
              { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
              { type: 'message_stop' },
            ],
            true,
          )
        : sse([{ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }]),
  ]);
  const { AnthropicMessagesProvider, GeminiProvider } = await import('../src/providers/index.js');
  const provider =
    kind === 'anthropic'
      ? new AnthropicMessagesProvider({ apiKey: 'test', fetch: mock.fetcher })
      : new GeminiProvider({ apiKey: 'test', fetch: mock.fetcher });
  const models = await provider.listModels();
  const model = models[0]!.id;
  expect(provider.capabilities(model)).toMatchObject({ contextWindow: 200000, maxOutputTokens: 32000 });
  const turn = runAgentTurn({
    provider,
    model,
    system: 's',
    history: [],
    tools: [],
    host: fakeHost(),
    userMessage: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  });
  await collect(turn.events);
  expect((await turn.result).reason).toBe('completed');
  expect(mock.bodies[0]).toMatchObject(
    kind === 'anthropic' ? { max_tokens: 32000 } : { generationConfig: { maxOutputTokens: 32000 } },
  );
});
it.each(['anthropic', 'gemini', 'responses'] as const)(
  '%s redacts asynchronously resolved credentials in HTTP diagnostics',
  async (kind) => {
    const secret = 'nonstandard-secret-value';
    const mock = recordingFetch([
      () =>
        Response.json(
          {
            error: {
              message: 'Bad parameter: ' + secret,
              type: 'invalid_request_error',
              code: 'invalid_parameter',
              status: 'INVALID_ARGUMENT',
            },
          },
          { status: 400 },
        ),
    ]);
    const { AnthropicMessagesProvider, GeminiProvider, OpenAIResponsesProvider } =
      await import('../src/providers/index.js');
    const options = { apiKey: async () => secret, fetch: mock.fetcher };
    const provider =
      kind === 'anthropic'
        ? new AnthropicMessagesProvider(options)
        : kind === 'gemini'
          ? new GeminiProvider(options)
          : new OpenAIResponsesProvider(options);
    const events = await collect(provider.stream(request(), signal()));
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { status: 400, providerMessage: expect.stringContaining('Bad parameter') },
    });
    expect(JSON.stringify(events)).not.toContain(secret);
  },
);

it('does not add reasoning replay fields to a compatible service that never returned thoughts', async () => {
  const mock = recordingFetch([() => end('stop'), () => end('stop')]);
  const provider = new OpenAIChatCompatibleProvider({ apiKey: 'test', fetch: mock.fetcher });
  const events = await collect(provider.stream(request(), signal()));
  expect(events.some((e) => e.type === 'provider_state')).toBe(false);
  await collect(
    provider.stream(
      {
        ...request(),
        messages: [
          ...request().messages,
          { role: 'assistant', content: [{ type: 'text', text: 'previous answer' }] },
          { role: 'user', content: [{ type: 'text', text: 'continue' }] },
        ],
      },
      signal(),
    ),
  );
  expect(JSON.stringify(mock.bodies[1])).not.toContain('reasoning_content');
});
