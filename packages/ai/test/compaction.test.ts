import { describe, expect, it, vi } from 'vitest';
import {
  COMPACTION_KEEP_TOKENS,
  SUMMARY_NUDGE,
  SUMMARY_PROMPT,
  SUMMARY_TEMPLATE,
  SUMMARY_UPDATE_PROMPT,
  checkpointMessage,
  compactHistory,
  flattenedTranscript,
} from '../src/agent/compaction.js';
import { estimateInputTokens, InputTokenMeter, prepareHistory } from '../src/agent/history.js';
import { runAgentTurn } from '../src/agent/runtime.js';
import { createEditorTools } from '../src/tools/index.js';
import type { ChatEvent, ChatRequest, ContextCheckpoint, Message, ModelProvider, TokenUsage } from '../src/types.js';
import { collect, fakeHost, image, ok } from './helpers.js';

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
const text = (messages: readonly Message[]) => JSON.stringify(messages);
const summary = SUMMARY_TEMPLATE.replace('用户要完成什么；必须遵守的范围、限制和优先级。', '保留蓝色屋顶，比例 1:50。');
const cycle = (id: string, size = 2500): Message[] => [
  {
    role: 'assistant',
    content: [{ type: 'tool_call', id, name: 'list_instances', arguments: {} }],
    providerState: { kind: 'openai-compatible-reasoning', reasoning: `signed-${id}` },
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool_result',
        id,
        name: 'list_instances',
        content: [{ type: 'text', text: JSON.stringify({ instances: 'x'.repeat(size) }) }],
      },
    ],
  },
];
function fixture(responses: (ChatEvent[] | Error)[] = []) {
  const requests: ChatRequest[] = [];
  const usages: TokenUsage[] = [];
  const provider: ModelProvider = {
    id: 'offline-summary',
    billing: 'api',
    endpoint: 'http://127.0.0.1',
    capabilities: () => ({ vision: true, tools: true, reasoning: false, maxContext: 32000, contextWindow: 32000 }),
    listModels: async () => [],
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const events = responses.shift();
      if (events instanceof Error) throw events;
      yield* events ?? [
        { type: 'text_delta', text: summary },
        { type: 'done', reason: 'stop' },
      ];
    },
  };
  const options = {
    provider,
    model: 'same-model',
    system: 'Stable system rules and design conventions',
    tools: createEditorTools(),
    maxTokens: 16000,
    signal: new AbortController().signal,
    onUsage: (usage: TokenUsage) => usages.push(usage),
    retryDelayMs: 0,
  };
  return { provider, requests, usages, options };
}
async function compact(messages: readonly Message[], options: Parameters<typeof compactHistory>[1]) {
  const events: ChatEvent[] = [];
  const generator = compactHistory(messages, options);
  for (;;) {
    const next = await generator.next();
    if (next.done) return next.value;
    if (next.value.type === 'text_delta') events.push(next.value);
  }
}
function paired(messages: readonly Message[]) {
  const pending = new Set<string>();
  for (const message of messages)
    for (const block of message.content) {
      if (block.type === 'tool_call') pending.add(block.id);
      if (block.type === 'tool_result') expect(pending.delete(block.id)).toBe(true);
    }
  expect(pending.size).toBe(0);
}
const longHistory = () => [user('蓝色屋顶'), ...Array.from({ length: 24 }, (_, i) => cycle(String(i), 6500)).flat()];

describe('A-123 model checkpoint', () => {
  it('appends the template to the original prefix when it fits without tools, with the same system/model', async () => {
    const f = fixture();
    const history = [user('原始目标'), ...cycle('big', 18000), user('CURRENT')];
    const before = structuredClone(history);
    const result = await compact(history, { ...f.options, maxTokens: 13000 });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ model: 'same-model', system: f.options.system, tools: [] });
    expect(f.requests[0]!.messages).toEqual([...history, user(SUMMARY_PROMPT)]);
    expect(result.checkpoint?.summary).toContain('保留蓝色屋顶');
    expect(result.tokens).toBeLessThanOrEqual(13000);
    expect(history).toEqual(before);
    expect(result.messages.at(-1)).toEqual(user('CURRENT'));
    paired(result.messages);
  });

  it('nudges exactly once for missing headings and retains the signed answer when retrying', async () => {
    const f = fixture([
      [
        { type: 'text_delta', text: 'An incomplete answer' },
        { type: 'provider_state', state: { kind: 'openai-compatible-reasoning', reasoning: 'summary reasoning' } },
        { type: 'done', reason: 'stop' },
      ],
      [
        { type: 'text_delta', text: summary },
        { type: 'done', reason: 'stop' },
      ],
    ]);
    const result = await compact(longHistory(), f.options);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]!.messages.at(-1)).toEqual(user(SUMMARY_NUDGE));
    expect(f.requests[1]!.messages.at(-2)?.providerState).toEqual({
      kind: 'openai-compatible-reasoning',
      reasoning: 'summary reasoning',
    });
    expect(result.checkpoint?.summary).toContain('保留蓝色屋顶');
  });

  it('updates the previous checkpoint and preserves recent complete parallel batches verbatim', async () => {
    const f = fixture();
    const first = await compact(longHistory(), f.options);
    expect(first.checkpoint).toBeDefined();
    const original = longHistory();
    const added = Array.from({ length: 20 }, (_, i) => cycle(`new-${i}`, 6500)).flat();
    const second = await compact([...original, ...added], { ...f.options, checkpoint: first.checkpoint! });
    expect(text(f.requests.at(-1)!.messages)).toContain(SUMMARY_UPDATE_PROMPT.replaceAll('\n', '\\n'));
    expect(text(f.requests.at(-1)!.messages)).toContain('保留蓝色屋顶');
    expect(second.checkpoint!.coveredMessages).toBeGreaterThan(first.checkpoint!.coveredMessages);
    expect(second.messages.slice(1)).toEqual([...original, ...added].slice(second.checkpoint!.coveredMessages));
    expect(estimateInputTokens('', second.messages.slice(1), [])).toBeLessThan(COMPACTION_KEEP_TOKENS);
    paired(second.messages);
    const lastCycle = added.slice(-2);
    expect(second.messages.slice(-2)).toEqual(lastCycle);
  });

  it('reuses a checkpoint across requests without resummarizing, including DeepSeek replay', async () => {
    const f = fixture();
    const archive = longHistory();
    const first = await compact(archive, f.options);
    const followup = user('下一步');
    const later = await compact([...archive, followup, ...cycle('latest', 20)], {
      ...f.options,
      maxTokens: 32000,
      checkpoint: first.checkpoint!,
      reasoningReplay: true,
      currentUserMessage: followup,
    });
    expect(f.requests).toHaveLength(1);
    expect(later.messages[0]).toEqual(first.messages[0]);
    expect(later.messages.at(-2)?.providerState).toEqual({
      kind: 'openai-compatible-reasoning',
      reasoning: 'signed-latest',
    });
    paired(later.messages);
  });

  it.each(['refused', 'network', 'invalid-headings', 'oversized-answer'] as const)(
    'uses deterministic fallback when the summary is %s',
    async (kind) => {
      const f = fixture(
        kind === 'network'
          ? Array.from({ length: 20 }, () => new Error('offline'))
          : kind === 'refused'
            ? [[{ type: 'done', reason: 'refusal' }]]
            : Array.from({ length: 2 }, () => [
                {
                  type: 'text_delta' as const,
                  text: kind === 'invalid-headings' ? 'missing' : summary + 'x'.repeat(90000),
                },
                { type: 'done' as const, reason: 'stop' as const },
              ]),
      );
      const result = await compact(longHistory(), f.options);
      expect(result.tokens).toBeLessThanOrEqual(f.options.maxTokens);
      expect(result.checkpoint?.summary).toContain('list_instances:');
      expect(f.requests.length).toBeGreaterThan(0);
      if (kind === 'invalid-headings') expect(f.requests).toHaveLength(2);
      paired(result.messages);
    },
  );

  it('uses deterministic fallback without contacting the model if even the flattened request cannot fit', async () => {
    const f = fixture();
    const history = [user('request'), ...cycle('huge-call', 100000)];
    const call = history[1]!.content[0]!;
    if (call.type === 'tool_call') call.arguments = { data: 'x'.repeat(100000) };
    const result = await compact(history, { ...f.options, tools: [], maxTokens: 700 });
    expect(f.requests).toHaveLength(0);
    expect(result.tokens).toBeLessThanOrEqual(700);
    expect(result.checkpoint?.summary).toContain('list_instances');
  });

  it('uses all ten retries before falling back after summary server failures', async () => {
    const f = fixture(
      Array.from({ length: 11 }, () => [
        { type: 'error', error: { category: 'server', status: 500, message: 'offline' } },
      ]),
    );
    const events = await collect(compactHistory(longHistory(), f.options));
    expect(f.requests).toHaveLength(11);
    expect(f.usages).toHaveLength(11);
    expect(events.filter((event) => event.type === 'retry').map((event) => event.attempt)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
  });

  it('counts summary timeouts separately from other transient failures', async () => {
    const f = fixture([
      ...Array.from({ length: 2 }, (): ChatEvent[] => [
        { type: 'error', error: { category: 'server', status: 500, message: 'offline' } },
      ]),
      ...Array.from({ length: 4 }, (): ChatEvent[] => [
        { type: 'error', error: { category: 'network', code: 'STREAM_STALLED', message: 'offline' } },
      ]),
    ]);
    const events = await collect(compactHistory(longHistory(), f.options));
    expect(f.requests).toHaveLength(6);
    expect(events.filter((event) => event.type === 'retry')).toHaveLength(5);
  });

  it('honors a provider refusal to retry a summary request', async () => {
    const f = fixture([
      [{ type: 'error', error: { category: 'server', status: 503, shouldRetry: false, message: 'offline' } }],
    ]);
    const result = await compact(longHistory(), f.options);
    expect(f.requests).toHaveLength(1);
    expect(result.checkpoint?.summary).toContain('list_instances:');
  });

  it('forwards raw response activity during a summary without exposing summary text', async () => {
    const f = fixture();
    f.provider.stream = async function* (_request, _signal, hooks) {
      hooks?.onResponseBytes?.({ receivedAt: 1000, bytes: 20 });
      yield { type: 'text_delta', text: summary };
      yield { type: 'done', reason: 'stop' };
    };
    const events = await collect(compactHistory(longHistory(), f.options));
    expect(events).toContainEqual({ type: 'transport_activity', receivedAt: 1000, bytes: 20 });
    expect(events.filter((event) => event.type === 'request_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'text_delta')).toHaveLength(0);
  });

  it('flattens only an oversized summary request, omitting media/thinking and counting omitted whole turns', async () => {
    const f = fixture();
    const first = user('older '.repeat(20000));
    first.content.push(image);
    const history = [first, ...cycle('old'), user('later'), ...cycle('new', 25000)];
    await compact(history, f.options);
    expect(f.requests).toHaveLength(1);
    expect(text(f.requests[0]!.messages)).toContain('省略了 1 轮');
    expect(text(f.requests[0]!.messages)).not.toContain('providerState');
    expect(text(f.requests[0]!.messages)).toContain('contextTruncation');
    const flattened = flattenedTranscript(history);
    expect(text([flattened])).toContain('media omitted');
    expect(text([flattened])).not.toContain('signed-old');
  });

  it('keeps every result in a parallel batch on the same side of the cut', async () => {
    const f = fixture();
    const parallel: Message[] = [
      { role: 'assistant', content: [...cycle('a')[0]!.content, ...cycle('b')[0]!.content] },
      cycle('a', 20000)[1]!,
      cycle('b', 20000)[1]!,
    ];
    const history = [...longHistory(), ...parallel, user('最新输入')];
    const result = await compact(history, f.options);
    paired(result.messages);
    expect([history.length - 3, history.length - 2]).not.toContain(result.checkpoint!.coveredMessages);
  });
});

it('keeps a large list_instances result intact, then compacts it only after crossing the request threshold', async () => {
  const f = fixture();
  const host = fakeHost();
  const instances = Array.from({ length: 3000 }, (_, i) => ({ instanceId: `i${i}`, position: [0, 0, i] }));
  vi.mocked(host.list_instances).mockResolvedValue(ok({ instances }));
  const tools = createEditorTools().filter((t) => t.name === 'list_instances');
  let steps = 0;
  const requests: ChatRequest[] = [];
  f.provider.stream = async function* (request) {
    requests.push({ ...request, messages: structuredClone(request.messages) });
    if (!request.tools.length) {
      yield { type: 'text_delta', text: summary };
      yield { type: 'done', reason: 'stop' };
    } else if (steps++ === 0) {
      yield { type: 'tool_call', call: { type: 'tool_call', id: 'large', name: 'list_instances', arguments: {} } };
      yield { type: 'done', reason: 'tool_calls' };
    } else {
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', reason: 'stop' };
    }
  };
  const run = runAgentTurn({
    provider: f.provider,
    model: 'same-model',
    system: '',
    history: [],
    userMessage: user('list all'),
    tools,
    host,
  });
  const events = await collect(run.events);
  const done = await run.result;
  expect(done.reason).toBe('completed');
  expect(done.checkpoint).toBeDefined();
  expect(events.some((e) => e.type === 'history_compressed' && e.summarized)).toBe(true);
  const raw = prepareHistory(done.history);
  expect(text(raw)).toContain('i2999');
  expect(text(raw)).not.toContain('contextTruncation');
  expect(estimateInputTokens('', raw, tools)).toBeGreaterThan(16000);
  expect(requests.filter((r) => r.tools.length)).toHaveLength(2);
  expect(host.list_instances).toHaveBeenCalledTimes(1);
});

it('accounts all summary attempts without changing task text or the actual-usage calibration', async () => {
  const f = fixture([
    [
      { type: 'usage', usage: { inputTokens: 99, outputTokens: 7, cacheReadInputTokens: 30 } },
      { type: 'done', reason: 'refusal' },
    ],
  ]);
  await compact(longHistory(), f.options);
  expect(f.usages).toEqual([{ inputTokens: 99, outputTokens: 7, cacheReadInputTokens: 30 }]);
  const meter = new InputTokenMeter();
  const current = user('input');
  current.content.push(image);
  meter.observe('', [current], [], 100);
  expect(meter.count('', [current], [])).toBe(100);
  const checkpoint: ContextCheckpoint = { summary, createdAt: '2026-10-20', coveredMessages: 1 };
  expect(meter.count('', [checkpointMessage(checkpoint)], [])).toBeLessThan(2000);
});
