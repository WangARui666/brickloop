import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpenAIChatCompatibleProvider } from '../src/providers/openai-chat-compatible';
import { presetCapabilities } from '../src/providers/presets';
import type { ChatRequest } from '../src/types';
import { collect, request, sse } from './helpers';

beforeEach(() =>
  vi.stubGlobal('fetch', () => {
    throw new Error('REAL NETWORK IS FORBIDDEN');
  }),
);
afterEach(() => vi.unstubAllGlobals());

async function body(preset: string, model: string, effort?: ChatRequest['effort'], mixed = false) {
  let raw = '';
  const provider = new OpenAIChatCompatibleProvider({
    ...(preset === 'custom' ? {} : { preset }),
    apiKey: 'test-only',
    fetch: async (_input, init) => {
      raw = String(init?.body);
      return sse([{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]);
    },
  });
  const input = { ...request(), model, ...(effort ? { effort } : {}) };
  if (mixed)
    input.messages = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call', name: 'validate', arguments: {} }],
        providerState: { kind: 'openai-compatible-reasoning', reasoning: 'thought' },
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            id: 'call',
            name: 'validate',
            content: [{ type: 'text', text: '{}' }],
            isError: false,
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'thinking answer' }],
        providerState: { kind: 'openai-compatible-reasoning', reasoning: '' },
      },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'plain answer' }] },
    ];
  const events = await collect(provider.stream(input, new AbortController().signal));
  expect(events.some((event) => event.type === 'error')).toBe(false);
  return raw;
}

it.each(['deepseek-flash', 'deepseek-v4-flash'])('controls only verified flash capabilities: %s', async (model) => {
  expect(presetCapabilities('deepseek', model).thinkingControl).toBe('deepseek');
  const original = await body('deepseek', model);
  expect(await body('deepseek', model, 'balanced')).toBe(original);
  for (const effort of ['fast', 'deep'] as const) {
    const raw = await body('deepseek', model, effort);
    const added =
      effort === 'fast'
        ? { thinking: { type: 'disabled' } }
        : { reasoning_effort: 'max', thinking: { type: 'enabled' } };
    expect(raw).toBe(original.slice(0, -1) + ',' + JSON.stringify(added).slice(1));
  }
});

it.each([
  ['deepseek', 'deepseek-v4-pro'],
  ['deepseek', 'deepseek-chat'],
  ['deepseek', 'deepseek-vision'],
  ['qwen', 'qwen-plus'],
  ['custom', 'deepseek-flash'],
  ['openrouter', 'deepseek/deepseek-flash'],
])('keeps %s / %s request bytes unchanged for every effort', async (preset, model) => {
  expect(presetCapabilities(preset, model).thinkingControl).toBeUndefined();
  const original = await body(preset, model);
  for (const effort of ['fast', 'balanced', 'deep'] as const) expect(await body(preset, model, effort)).toBe(original);
});

it('preserves mixed history bytes with present, empty and absent reasoning_content across all efforts', async () => {
  const original = JSON.parse(await body('deepseek', 'deepseek-flash', undefined, true));
  expect(original.messages[2].reasoning_content).toBe('thought');
  expect(original.messages[4].reasoning_content).toBe('');
  expect(original.messages[6]).not.toHaveProperty('reasoning_content');
  for (const effort of ['fast', 'balanced', 'deep'] as const) {
    const next = JSON.parse(await body('deepseek', 'deepseek-flash', effort, true));
    expect(JSON.stringify(next.messages)).toBe(JSON.stringify(original.messages));
  }
});
