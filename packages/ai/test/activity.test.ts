import { describe, expect, it } from 'vitest';
import {
  OpenAIChatCompatibleProvider,
  OpenAIResponsesProvider,
  AnthropicMessagesProvider,
  GeminiProvider,
} from '../src/providers/index.js';
import { collect, recordingFetch, request, sse } from './helpers.js';

const factories = {
  compatible: (fetch: typeof globalThis.fetch) => new OpenAIChatCompatibleProvider({ apiKey: 'fake', fetch }),
  responses: (fetch: typeof globalThis.fetch) => new OpenAIResponsesProvider({ apiKey: 'fake', fetch }),
  anthropic: (fetch: typeof globalThis.fetch) => new AnthropicMessagesProvider({ apiKey: 'fake', fetch }),
  gemini: (fetch: typeof globalThis.fetch) => new GeminiProvider({ apiKey: 'fake', fetch }),
};
type Mode = 'reasoning' | 'content' | 'tool';
const text = '私密思考或回复';
const args = '{"partId":"3001"}';
function frames(kind: keyof typeof factories, mode: Mode): unknown[] {
  const value = mode === 'tool' ? args : text;
  const chunks = [value.slice(0, 3), value.slice(3)];
  if (kind === 'compatible')
    return [
      ...chunks.map((chunk) => ({
        choices: [
          {
            delta:
              mode === 'tool'
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call',
                        function: { name: chunk === chunks[0] ? 'get_part_info' : '', arguments: chunk },
                      },
                    ],
                  }
                : { [mode === 'reasoning' ? 'reasoning_content' : 'content']: chunk },
          },
        ],
      })),
      { choices: [{ delta: {}, finish_reason: mode === 'tool' ? 'tool_calls' : 'stop' }] },
      { choices: [] },
    ];
  if (kind === 'responses')
    return [
      ...chunks.map((delta) => ({
        type:
          mode === 'tool'
            ? 'response.function_call_arguments.delta'
            : mode === 'reasoning'
              ? 'response.reasoning_text.delta'
              : 'response.output_text.delta',
        delta,
      })),
      {
        type: 'response.completed',
        response: {
          output:
            mode === 'tool'
              ? [{ type: 'function_call', call_id: 'call', name: 'get_part_info', arguments: args }]
              : mode === 'reasoning'
                ? [{ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text }] }]
                : [{ type: 'message', content: [{ type: 'output_text', text }] }],
        },
      },
    ];
  if (kind === 'anthropic')
    return [
      {
        type: 'content_block_start',
        index: 0,
        content_block:
          mode === 'tool'
            ? { type: 'tool_use', id: 'call', name: 'get_part_info', input: {} }
            : mode === 'reasoning'
              ? { type: 'thinking', thinking: '', signature: '' }
              : { type: 'text', text: '' },
      },
      ...chunks.map((chunk) => ({
        type: 'content_block_delta',
        index: 0,
        delta:
          mode === 'tool'
            ? { type: 'input_json_delta', partial_json: chunk }
            : mode === 'reasoning'
              ? { type: 'thinking_delta', thinking: chunk }
              : { type: 'text_delta', text: chunk },
      })),
      {
        type: 'message_delta',
        delta: { stop_reason: mode === 'tool' ? 'tool_use' : 'end_turn', stop_details: null },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ];
  return [
    ...(mode === 'tool'
      ? [
          {
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { id: 'call', name: 'get_part_info', args: JSON.parse(args) as unknown } }],
                },
              },
            ],
          },
        ]
      : chunks.map((chunk) => ({
          candidates: [{ content: { parts: [{ text: chunk, thought: mode === 'reasoning' }] } }],
        }))),
    { candidates: [{ finishReason: 'STOP' }] },
  ];
}
describe.each(Object.keys(factories) as (keyof typeof factories)[])('%s activity', (kind) => {
  it.each<Mode>(['reasoning', 'content', 'tool'])(
    'counts %s without exposing text and preserves original events',
    async (mode) => {
      const input = frames(kind, mode);
      const mock = recordingFetch([() => sse(input, kind === 'anthropic')]);
      const events = await collect(factories[kind](mock.fetcher).stream(request(), new AbortController().signal));
      const activity = events.filter((e) => e.type === 'activity');
      expect(activity).toHaveLength(input.length);
      let previous = { reasoningChars: 0, contentChars: 0, toolChars: 0 };
      for (const event of activity) {
        expect(Object.keys(event).sort()).toEqual(['contentChars', 'reasoningChars', 'toolChars', 'type']);
        for (const key of ['reasoningChars', 'contentChars', 'toolChars'] as const)
          expect(event[key]).toBeGreaterThanOrEqual(previous[key]);
        previous = event;
      }
      expect(activity.at(-1)).toEqual({
        type: 'activity',
        reasoningChars: mode === 'reasoning' ? text.length : 0,
        contentChars: mode === 'content' ? text.length : 0,
        toolChars: mode === 'tool' ? args.length : 0,
      });
      expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual(
        mode === 'content' ? [text.slice(0, 3), text.slice(3)] : [],
      );
      expect(events.filter((e) => e.type === 'tool_call')).toEqual(
        mode === 'tool'
          ? [
              {
                type: 'tool_call',
                call: { type: 'tool_call', id: 'call', name: 'get_part_info', arguments: { partId: '3001' } },
              },
            ]
          : [],
      );
      expect(
        events.filter((e) => !['activity', 'provider_state', 'usage', 'text_delta', 'tool_call'].includes(e.type)),
      ).toEqual([{ type: 'done', reason: mode === 'tool' ? 'tool_calls' : 'stop' }]);
      const original = events.filter((e) => e.type !== 'activity');
      expect(original.at(-1)).toEqual({ type: 'done', reason: mode === 'tool' ? 'tool_calls' : 'stop' });
      if (mode === 'tool')
        expect(original.findIndex((e) => e.type === 'provider_state')).toBeLessThan(
          original.findIndex((e) => e.type === 'tool_call'),
        );
    },
  );
});
