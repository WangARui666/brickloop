import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compressHistory,
  estimateInputTokens,
  imageTokenEstimate,
  InputTokenMeter,
  prepareHistory,
  runAgentTurn,
  truncateToolResult,
} from '../src/agent/index.js';
import { OpenAIChatCompatibleProvider } from '../src/providers/index.js';
import { createEditorTools, resultContent } from '../src/tools/index.js';
import type { ChatEvent, ChatRequest, Message, ModelProvider, ToolCallBlock, ToolResultBlock } from '../src/types.js';
import { collect, fakeHost, image, ok } from './helpers.js';

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Real network is forbidden');
    }),
  ),
);
afterEach(() => vi.unstubAllGlobals());
const user = (text = '搭建房子', images = false): Message => ({
  role: 'user',
  content: [{ type: 'text', text }, ...(images ? [image] : [])],
});
const tools = createEditorTools();
const options = { system: 'system', tools, maxTokens: 24000 };
it('distinguishes request projection from budget-driven summary removal', () => {
  const current = user('Current request');
  const history = [
    user('Old request', true),
    ...cycle(0, 'get_model_summary', [{ type: 'text', text: 'large result '.repeat(6000) }]),
    current,
  ];
  const projected = compressHistory(history, { ...options, currentUserMessage: current, maxTokens: Infinity });
  expect(projected.compressed).toBe(true);
  expect(projected.summarized).toBe(false);
  const summarized = compressHistory(history, { ...options, currentUserMessage: current, maxTokens: 100 });
  expect(summarized.summarized).toBe(true);
  const oversized = compressHistory([current], { system: '', tools: [], currentUserMessage: current, maxTokens: 0 });
  expect(oversized.summarized).toBe(false);
});
function cycle(
  index: number,
  name = 'render_views',
  content: ToolResultBlock['content'] = [{ type: 'text', text: '{"ok":true}' }, image],
): Message[] {
  const call: ToolCallBlock = {
    type: 'tool_call',
    id: String(index),
    name,
    arguments: { views: ['front', 'isometric'] },
  };
  return [
    { role: 'assistant', content: [call] },
    { role: 'tool', content: [{ type: 'tool_result', id: call.id, name, content }] },
  ];
}
function results(messages: readonly Message[]) {
  return messages.flatMap((m) => m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result'));
}
function imageGroups(messages: readonly Message[]) {
  return results(messages).filter((r) => r.content.some((b) => b.type === 'image'));
}
function paired(messages: readonly Message[]) {
  const pending = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') expect(pending.size).toBe(0);
    for (const b of m.content) {
      if (b.type === 'tool_call') {
        expect(pending.has(b.id)).toBe(false);
        pending.add(b.id);
      }
      if (b.type === 'tool_result') {
        expect(pending.delete(b.id)).toBe(true);
      }
    }
    if (m.role === 'user' && m.content.some((b) => b.type === 'text')) expect(pending.size).toBe(0);
  }
  expect(pending.size).toBe(0);
}

describe('request-only context projection', () => {
  it('retains two image result groups plus only the active user images, with tool, view and turn placeholders', () => {
    const current = user('当前请求', true);
    const history = [
      user('旧要求', true),
      ...cycle(1),
      current,
      ...cycle(2),
      ...cycle(3),
      ...cycle(4),
      ...cycle(5, 'get_model_summary', [{ type: 'text', text: '{}' }]),
    ];
    const original = structuredClone(history);
    const prepared = prepareHistory(history, current);
    expect(imageGroups(prepared).map((r) => r.id)).toEqual(['3', '4']);
    expect(prepared.flatMap((m) => m.content).filter((b) => b.type === 'image')).toEqual([image]);
    expect(JSON.stringify(prepared)).toContain('render_views 第 2 次，第 2 轮，front、isometric');
    expect(JSON.stringify(prepared)).toContain('第 1 轮用户图片');
    expect(history).toEqual(original);
    paired(prepared);
  });
  it('counts individual parallel image results as groups, retaining every view in those groups', () => {
    const history = [
      user(),
      { role: 'assistant' as const, content: [1, 2, 3].map((i) => cycle(i)[0]!.content[0]!) },
      {
        role: 'tool' as const,
        content: [1, 2, 3].map((i) => cycle(i, 'render_views', [image, image])[1]!.content[0]!),
      },
    ];
    const prepared = prepareHistory(history);
    expect(imageGroups(prepared).map((r) => r.id)).toEqual(['2', '3']);
    expect(imageGroups(prepared).every((r) => r.content.length === 2)).toBe(true);
    paired(prepared);
  });
  it('CTX-02 truncates 500 search rows, preserves sibling metadata and never suggests an unsupported offset', () => {
    const result: ToolResultBlock = {
      type: 'tool_result',
      id: 'search',
      name: 'search_parts',
      content: resultContent(
        ok({
          parts: Array.from({ length: 500 }, (_, i) => ({
            id: `p${i}`,
            nameZh: '测试砖',
            bboxLdu: [0, 0, 0, 20, 8, 20],
            geometry: { ref: 'x'.repeat(100) },
          })),
          total: 500,
          category: 'brick',
        }),
      ),
    };
    const original = structuredClone(result);
    const truncated = truncateToolResult(result);
    const text = truncated.content[0];
    expect(text?.type).toBe('text');
    if (text?.type !== 'text') return;
    const parsed = JSON.parse(text.text);
    expect(parsed.data.parts.length).toBeGreaterThan(0);
    expect(parsed.data.parts.length).toBeLessThan(500);
    expect(parsed.data.parts[0]).toEqual({ id: 'p0', nameZh: '测试砖', bboxLdu: [0, 0, 0, 20, 8, 20] });
    expect(parsed).toMatchObject({
      ok: true,
      warnings: [],
      introducedIssues: [],
      data: { total: 500, category: 'brick' },
      contextTruncation: { total: 500, shown: parsed.data.parts.length },
    });
    expect(text.text).toContain('用不同的过滤条件缩小范围');
    expect(text.text).not.toContain('offset');
    expect(new TextEncoder().encode(text.text).length / 3).toBeLessThanOrEqual(2000);
    expect(result).toEqual(original);
  });
  it('continues list_instances from the displayed offset instead of skipping truncated rows', () => {
    const result: ToolResultBlock = {
      type: 'tool_result',
      id: 'list',
      name: 'list_instances',
      content: resultContent(
        ok({
          total: 1000,
          instances: Array.from({ length: 500 }, (_, i) => ({
            instanceId: `i${100 + i}`,
            path: ['model', `i${100 + i}`],
            colorId: 'red',
            matrix_ldu: Array(12).fill(0),
          })),
        }),
      ),
    };
    const text = truncateToolResult(result, { offset: 100 }).content[0];
    if (text?.type !== 'text') throw new Error('Missing text');
    const parsed = JSON.parse(text.text);
    expect(parsed.contextTruncation.nextOffset).toBe(100 + parsed.data.instances.length);
    expect(parsed.data.instances[0].path).toEqual(['model', 'i100']);
    expect(parsed.data.instances[0].matrix_ldu).toBeUndefined();
  });
  it.each(['字'.repeat(15000), '\\"'.repeat(15000)])(
    'bounds arbitrary oversized text without dropping images',
    (text) => {
      const result = truncateToolResult({
        type: 'tool_result',
        id: 'x',
        name: 'other',
        content: [{ type: 'text', text }, image],
      });
      expect(result.content.at(-1)).toEqual(image);
      const output = result.content[0];
      if (output?.type !== 'text') throw new Error('Missing text');
      expect(new TextEncoder().encode(output.text).length / 3).toBeLessThanOrEqual(2000);
      expect(() => JSON.parse(output.text)).not.toThrow();
    },
  );
});

describe('usage calibration', () => {
  it('uses actual input plus additions and releases measured shares when history is replaced', () => {
    const meter = new InputTokenMeter();
    const history = [user('first'), ...cycle(1)];
    expect(meter.count('', history, [])).toBe(estimateInputTokens('', history, []));
    meter.observe('', history, [], 300);
    expect(meter.count('', history, [])).toBe(300);
    const next = user('追加要求');
    expect(meter.count('', [...history, next], [])).toBe(
      300 + estimateInputTokens('', [next], []) - estimateInputTokens('', [], []),
    );
    expect(meter.count('', [history[0]!, next], [])).toBeGreaterThan(
      estimateInputTokens('', [next], []) - estimateInputTokens('', [], []),
    );
    expect(meter.count('different system', history, [])).toBe(estimateInputTokens('different system', history, []));
    meter.observe('', history, [], Number.NaN);
    expect(meter.count('', history, [])).toBe(300);
  });
  it('exposes configured provider image estimates and falls back to 1500', () => {
    const capabilities = { vision: true, tools: true, reasoning: false, maxContext: 128000, contextWindow: 128000 };
    const provider = new OpenAIChatCompatibleProvider({
      apiKey: 'scripted-only',
      modelCapabilities: { test: { ...capabilities, imageTokens: 123 } },
    });
    expect(imageTokenEstimate(provider.capabilities('test'))).toBe(123);
    expect(imageTokenEstimate(capabilities)).toBe(1500);
    expect(estimateInputTokens('', [user('', true)], [], 123)).toBe(
      estimateInputTokens('', [user('', true)], []) - 1500 + 123,
    );
  });
});

it('compresses 60 calls within ONE user turn, preserving complete parallel pairs and signed replay state', () => {
  const request = user();
  const history: Message[] = [request];
  for (let batch = 0; batch < 20; batch++) {
    const calls: ToolCallBlock[] = Array.from({ length: 3 }, (_, i) => ({
      type: 'tool_call',
      id: `${batch}-${i}`,
      name: 'set_color',
      arguments: { instanceIds: ['i1', 'i2'], colorId: 'red' },
    }));
    history.push({
      role: 'assistant',
      content: calls,
      providerState: { provider: 'test', value: { signed: batch, calls } },
    });
    for (const c of calls)
      history.push({
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            id: c.id,
            name: c.name,
            content: resultContent(ok({ changed: 2, details: 'x'.repeat(3000) })),
          },
        ],
      });
  }
  const original = structuredClone(history);
  const compressed = compressHistory(history, { ...options, currentUserMessage: request, maxTokens: 16000 });
  expect(compressed.tokens).toBeLessThanOrEqual(16000);
  expect(compressed.messages.length).toBeLessThan(history.length);
  expect(JSON.stringify(compressed.messages)).toContain('set_color:');
  expect(JSON.stringify(compressed.messages)).toContain('改动实例');
  expect(compressed.messages.filter((m) => m.providerState).length).toBeGreaterThan(0);
  for (const message of compressed.messages.filter((m) => m.providerState)) expect(history).toContainEqual(message);
  paired(compressed.messages);
  expect(history).toEqual(original);
  expect(compressHistory(history, { ...options, currentUserMessage: request, maxTokens: 16000 })).toEqual(compressed);
});

it('reduces even the latest enormous call/result batch instead of stopping at a fixed tail', () => {
  const request = user();
  const history = [request, ...cycle(0, 'set_color', resultContent(ok({ changed: 2 })))];
  const block = history[1]!.content[0];
  if (block?.type === 'tool_call') block.arguments = { instanceIds: Array(10000).fill('i'), colorId: 'red' };
  const reduced = compressHistory(history, { system: '', tools: [], maxTokens: 500 });
  expect(reduced.tokens).toBeLessThanOrEqual(500);
  expect(reduced.messages).toContainEqual(request);
  paired(reduced.messages);
});

it('summarizes earlier user text when a new amendment fits but their combined input exceeds the budget', () => {
  const current = user('a'.repeat(1000)),
    amendment = user('b'.repeat(1000));
  const reduced = compressHistory([current, amendment], {
    system: '',
    tools: [],
    maxTokens: 550,
    currentUserMessage: current,
  });
  expect(reduced.tokens).toBeLessThanOrEqual(550);
  expect(reduced.messages).toContainEqual(amendment);
  expect(JSON.stringify(reduced.messages)).toContain('早先要求摘要');
  expect(current.content[0]).toEqual({ type: 'text', text: 'a'.repeat(1000) });
});

it.each([false, true])('summarizes batch tools and actual mutation counts, including rollback=%s', (rolledBack) => {
  const history = [
    user(),
    ...cycle(0, 'batch', resultContent(ok({ results: [ok({ created: ['a', 'b'] }), ok({ changed: 3 })], rolledBack }))),
  ];
  const call = history[1]!.content[0];
  if (call?.type === 'tool_call')
    call.arguments = {
      operations: [
        { tool: 'place_part', arguments: { largePayload: 'x'.repeat(30000) } },
        { tool: 'set_color', arguments: { instanceIds: ['i', 'j', 'k'] } },
      ],
    };
  const reduced = compressHistory(history, {
    ...options,
    maxTokens: estimateInputTokens('system', [history[0]!], tools) + 600,
  });
  expect(JSON.stringify(reduced.messages)).toContain(`改动实例 ${rolledBack ? 0 : 5} 次`);
  expect(JSON.stringify(reduced.messages)).toContain('place_part、set_color');
  paired(reduced.messages);
});

it('uses actual usage in the runtime budget instead of rerunning the uncalibrated preflight', async () => {
  const selectedTools = tools.filter((t) => t.name === 'get_model_summary');
  const message = user('保留要求'.repeat(600));
  const budget = estimateInputTokens('', [message], selectedTools) + 10;
  const requests: ChatRequest[] = [];
  const provider: ModelProvider = {
    id: 'scripted',
    billing: 'api',
    endpoint: 'http://127.0.0.1',
    listModels: async () => [],
    capabilities: () => ({ vision: true, tools: true, reasoning: false, maxContext: 128000, contextWindow: 128000 }),
    async *stream(request): AsyncGenerator<ChatEvent> {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      if (requests.length === 1)
        yield {
          type: 'tool_call',
          call: { type: 'tool_call', id: 'summary', name: 'get_model_summary', arguments: {} },
        };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 0 } };
      yield { type: 'done', reason: requests.length === 1 ? 'tool_calls' : 'stop' };
    },
  };
  const run = runAgentTurn({
    provider,
    model: 'test',
    system: '',
    history: [],
    userMessage: message,
    host: fakeHost(),
    tools: selectedTools,
    budget: { inputTokens: budget },
  });
  await collect(run.events);
  expect((await run.result).reason).toBe('completed');
  expect(results(requests[1]!.messages)).toHaveLength(1);
  expect(estimateInputTokens('', requests[1]!.messages, selectedTools)).toBeGreaterThan(budget);
  expect((await run.result).usage.inputTokens).toBe(200);
});

it('applies provider image token configuration to the runtime fallback', async () => {
  const provider: ModelProvider = {
    id: 'scripted',
    billing: 'api',
    endpoint: 'http://127.0.0.1',
    listModels: async () => [],
    capabilities: () => ({
      vision: true,
      tools: true,
      reasoning: false,
      maxContext: 128000,
      contextWindow: 128000,
      imageTokens: 100,
    }),
    async *stream(): AsyncGenerator<ChatEvent> {
      yield { type: 'done', reason: 'stop' };
    },
  };
  const run = runAgentTurn({
    provider,
    model: 'test',
    system: '',
    history: [],
    userMessage: user('', true),
    host: fakeHost(),
    tools: [],
    budget: { inputTokens: 500 },
  });
  await collect(run.events);
  expect((await run.result).reason).toBe('completed');
});

it.each([false, true])(
  'CTX-01 runs 20 scripted render/compare rounds (usage=%s) and preserves archival images',
  async (withUsage) => {
    let step = 0;
    const requests: ChatRequest[] = [];
    const provider: ModelProvider = {
      id: 'scripted',
      billing: 'api',
      endpoint: 'http://127.0.0.1/scripted',
      listModels: async () => [],
      capabilities: () => ({ vision: true, tools: true, reasoning: false, maxContext: 128000, contextWindow: 128000 }),
      async *stream(request): AsyncGenerator<ChatEvent> {
        requests.push({ ...request, messages: structuredClone(request.messages) });
        if (step < 40) {
          const name = step % 2 ? 'compare_to_reference' : 'render_views';
          yield {
            type: 'tool_call',
            call: {
              type: 'tool_call',
              id: `c${step}`,
              name,
              arguments: name === 'render_views' ? { views: ['front'] } : { referenceId: 'ref', view: 'front' },
            },
          };
        } else yield { type: 'text_delta', text: '完成' };
        if (withUsage)
          yield {
            type: 'usage',
            usage: {
              inputTokens: estimateInputTokens(request.system, request.messages, request.tools),
              outputTokens: 10,
              cacheReadInputTokens: 0,
            },
          };
        yield { type: 'done', reason: step++ < 40 ? 'tool_calls' : 'stop' };
      },
    };
    const host = fakeHost();
    vi.mocked(host.render_views).mockResolvedValue({
      ok: true,
      data: { images: [image], view: 'front' },
      introducedIssues: [],
      warnings: [],
    });
    vi.mocked(host.compare_to_reference).mockResolvedValue({
      ok: true,
      data: { images: [image], iou: 0.8 },
      introducedIssues: [],
      warnings: [],
    });
    const run = runAgentTurn({
      provider,
      model: 'test',
      host,
      system: 'system',
      history: [],
      userMessage: user('参考图', true),
      tools,
      budget: { inputTokens: 24000 },
    });
    await collect(run.events);
    expect((await run.result).reason).toBe('completed');
    expect(requests).toHaveLength(41);
    const meter = new InputTokenMeter();
    requests.forEach((request, index) => {
      expect(imageGroups(request.messages).map((r) => r.id)).toEqual(
        Array.from({ length: Math.min(index, 2) }, (_, i) => `c${Math.max(0, index - 2) + i}`),
      );
      // Actual usage anchors the next request. Per-message rounding can differ by
      // one token from re-estimating the entire serialized request after tool schemas grow.
      expect(meter.count(request.system, request.messages, request.tools)).toBeLessThanOrEqual(24000);
      if (withUsage)
        meter.observe(
          request.system,
          request.messages,
          request.tools,
          estimateInputTokens(request.system, request.messages, request.tools),
        );
      expect(request.messages.flatMap((m) => m.content).filter((b) => b.type === 'image')).toHaveLength(1);
      paired(request.messages);
    });
    expect(imageGroups((await run.result).history)).toHaveLength(40);
  },
);

it('stops a single oversized user message before contacting the model', async () => {
  const stream = vi.fn(async function* (): AsyncGenerator<ChatEvent> {
    yield { type: 'done', reason: 'stop' };
  });
  const provider: ModelProvider = {
    id: 'test',
    billing: 'api',
    endpoint: 'http://127.0.0.1',
    listModels: async () => [],
    capabilities: () => ({ vision: true, tools: true, reasoning: false, maxContext: 128000, contextWindow: 128000 }),
    stream,
  };
  const run = runAgentTurn({
    provider,
    model: 'test',
    system: '',
    history: [],
    userMessage: user('巨大消息'.repeat(10000)),
    host: fakeHost(),
    tools: [],
    budget: { inputTokens: 1000 },
  });
  await collect(run.events);
  expect((await run.result).reason).toBe('input_budget');
  expect(stream).not.toHaveBeenCalled();
});
