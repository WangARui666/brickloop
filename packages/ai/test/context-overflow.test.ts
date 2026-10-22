import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isContextOverflow } from '../src/errors.js';
import {
  AnthropicMessagesProvider,
  GeminiProvider,
  OpenAIChatCompatibleProvider,
  OpenAIResponsesProvider,
} from '../src/providers/index.js';
import { collect, recordingFetch, request, sse } from './helpers.js';

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('REAL NETWORK IS FORBIDDEN');
    }),
  ),
);
afterEach(() => vi.unstubAllGlobals());
it.each([
  'prompt is too long',
  'input is too long for requested model',
  'exceeded this model context window limit',
  'input exceeds the context window',
  "exceeds the model's maximum context length of 128,000 tokens",
  'exceeds maximum context length (65536)',
  'input token count 100 exceeds the maximum',
  'number of input tokens exceeds maximum length',
  'tokens in request more than max tokens allowed',
  'maximum prompt length is 65536',
  'Please reduce the length of the messages',
  'requested input length 100 exceeds maximum input length',
  "This model's maximum context length is 65536 tokens...",
  'exceeds the maximum allowed input length of 32,000 tokens',
  "input (42 tokens) is longer than the model's context length",
  'exceeds the limit of 123',
  'exceeds the available context size',
  'greater than the context length',
  '`inputs` tokens + `max_new_tokens` must be <= 4096',
  'context window exceeds limit',
  'exceeded model token limit',
  'context_length_exceeded',
  'context length exceeded',
  'context length is only 4096 tokens',
  'input length 40000 exceeds the context length',
  'Prompt too long',
  'Prompt 超长',
  'too large for model with 4096 maximum context length',
  'prompt has 12,000 tokens, but the configured context size is 8,000 tokens',
  'model_context_window_exceeded',
  'range of input length should be [1, 8192]',
  'too many tokens',
  'token limit exceeded',
  'request_too_large',
  '400 (no body)',
  '413 status code (no body)',
])('recognizes overflow: %s', (text) => expect(isContextOverflow(text)).toBe(true));
it.each([
  'rate limit: too many tokens',
  'too many requests, token limit exceeded',
  'Throttling error: prompt is too long',
  'Service unavailable: context_length_exceeded',
  'too many tokens: max_tokens must be less than 8192',
  'max tokens must be less than 8192: too many tokens',
  'payload too large',
  'request entity too large',
  'request too large',
  '400 Bad parameter',
  '413 (with body)',
  '401 (no body)',
])('does not compact unrelated errors: %s', (text) => expect(isContextOverflow(text)).toBe(false));

const constructors = {
  compatible: OpenAIChatCompatibleProvider,
  responses: OpenAIResponsesProvider,
  anthropic: AnthropicMessagesProvider,
  gemini: GeminiProvider,
};
for (const [name, Provider] of Object.entries(constructors)) {
  it.each([
    { error: { message: 'Prompt 超长', code: '1261' } },
    { error: { message: 'Rejected', code: 'context_length_exceeded' } },
    { error: { message: 'Rejected', metadata: { upstream: { message: 'prompt is too long' } } } },
  ])(name + ' scans message, code and nested body before truncation: %j', async (body) => {
    const mock = recordingFetch([() => Response.json(body, { status: 400 })]);
    const events = await collect(
      new Provider({ apiKey: 'test', fetch: mock.fetcher }).stream(request(), new AbortController().signal),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { category: 'invalid_request', code: 'CONTEXT_OVERFLOW', status: 400 },
    });
  });
  it.each([400, 413])(name + ' handles empty HTTP %s', async (status) => {
    const mock = recordingFetch([() => new Response(null, { status })]);
    const events = await collect(
      new Provider({ apiKey: 'test', fetch: mock.fetcher }).stream(request(), new AbortController().signal),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { category: 'invalid_request', code: 'CONTEXT_OVERFLOW', status },
    });
  });
  it.each(['Bad parameter', 'max_tokens must be less than 8192: too many tokens', 'Rate limit: too many tokens'])(
    name + ' does not mistake a non-JSON body for an empty response: %s',
    async (body) => {
      const mock = recordingFetch([() => new Response(body, { status: 400 })]);
      const events = await collect(
        new Provider({ apiKey: 'test', fetch: mock.fetcher }).stream(request(), new AbortController().signal),
      );
      const last = events.at(-1);
      expect(last?.type).toBe('error');
      if (last?.type === 'error') expect(last.error.code).not.toBe('CONTEXT_OVERFLOW');
    },
  );
  it(name + ' honors exclusions even when the body contains an overflow code', async () => {
    const mock = recordingFetch([
      () =>
        Response.json(
          { error: { code: 'context_length_exceeded', message: 'Rate limit: too many tokens' } },
          { status: 429 },
        ),
    ]);
    const events = await collect(
      new Provider({ apiKey: 'test', fetch: mock.fetcher }).stream(request(), new AbortController().signal),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { category: 'rate_limit' } });
  });
}
it('recognizes streamed Responses errors and redacts the provider explanation', async () => {
  const mock = recordingFetch([
    () =>
      sse(
        [
          {
            type: 'response.failed',
            response: { error: { code: 'context_length_exceeded', message: 'Prompt too long secret-for-test' } },
          },
        ],
        true,
      ),
  ]);
  const events = await collect(
    new OpenAIResponsesProvider({ apiKey: 'secret-for-test', fetch: mock.fetcher }).stream(
      request(),
      new AbortController().signal,
    ),
  );
  expect(events.at(-1)).toMatchObject({
    type: 'error',
    error: { category: 'invalid_request', code: 'CONTEXT_OVERFLOW' },
  });
  expect(JSON.stringify(events)).not.toContain('secret-for-test');
});
