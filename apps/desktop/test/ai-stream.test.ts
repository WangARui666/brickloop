import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearModelLiveness, flushAiStream, receiveAiEvent, useAiStore } from '../src/renderer/src/ai-store';
import type { AgentEvent } from '@brickloop/ai';

vi.mock('../src/renderer/src/document-store', () => ({ documentLocked: () => false }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  useAiStore.setState({
    turns: ['a', 'b'].map((id) => ({ id, user: '', images: [], text: '', events: [] })),
    liveness: {},
  });
});
afterEach(() => {
  flushAiStream();
  clearModelLiveness('a');
  clearModelLiveness('b');
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('applies 5,000 text deltas arriving within 1ms in at most 50 store writes', () => {
  receiveAiEvent('a', { type: 'request_started' });
  const writes = vi.spyOn(useAiStore, 'setState');
  const chunks = Array.from({ length: 5000 }, (_, i) => `${i % 10}积`);
  expect(() => {
    for (const text of chunks) receiveAiEvent('a', { type: 'text_delta', text });
  }).not.toThrow();
  expect(Date.now()).toBe(0);
  expect(writes).not.toHaveBeenCalled();
  vi.advanceTimersByTime(16);
  expect(writes.mock.calls.length).toBeLessThanOrEqual(50);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(useAiStore.getState().turns[0]!.text).toBe(chunks.join(''));
});

it('combines reasoning, activity and raw-byte updates without changing arrival times or final phase', () => {
  receiveAiEvent('a', { type: 'request_started' });
  const writes = vi.spyOn(useAiStore, 'setState');
  for (let i = 1; i <= 5000; i++) {
    receiveAiEvent('a', { type: 'reasoning_summary', text: '思' });
    receiveAiEvent('a', { type: 'activity', reasoningChars: i, contentChars: 0, toolChars: 0 });
  }
  vi.setSystemTime(1);
  receiveAiEvent('a', { type: 'activity', reasoningChars: 5000, contentChars: 10, toolChars: 0 });
  vi.setSystemTime(2);
  receiveAiEvent('a', { type: 'activity', reasoningChars: 5001, contentChars: 10, toolChars: 0 });
  receiveAiEvent('a', { type: 'transport_activity', receivedAt: 1, bytes: 14 });
  vi.advanceTimersByTime(50);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(useAiStore.getState().liveness.a).toMatchObject({
    receivedAt: 2,
    bytesAt: 1,
    phase: 'thinking',
    counts: { reasoningChars: 5001, contentChars: 10, toolChars: 0 },
  });
  expect(useAiStore.getState().turns[0]!.events).toEqual([]);
  expect(useAiStore.getState().turns[0]!.text).toBe('');
});

const call = { type: 'tool_call' as const, id: 'call', name: 'list_colors', arguments: {} };
const barriers: AgentEvent[] = [
  { type: 'tool_call', call },
  { type: 'tool_result', call, result: { ok: true, data: {}, introducedIssues: [], warnings: [] } },
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 } },
  { type: 'provider_state', state: { kind: 'openai-compatible-reasoning', reasoning: 'private' } },
  { type: 'request_started' },
  { type: 'history_compressed', estimatedTokens: 10, summarized: true },
  { type: 'retry', attempt: 1, delayMs: 1000, error: { category: 'network' } },
  { type: 'error', error: { category: 'network', message: 'offline' } },
  { type: 'done', reason: 'cancelled' },
];
it.each(barriers)('flushes text before $type, leaving the other turn buffered', (event) => {
  receiveAiEvent('a', { type: 'request_started' });
  receiveAiEvent('a', { type: 'text_delta', text: 'before' });
  receiveAiEvent('b', { type: 'text_delta', text: 'other' });
  const observed: string[] = [];
  const unsubscribe = useAiStore.subscribe((state) => observed.push(state.turns[0]!.text));
  receiveAiEvent('a', event);
  unsubscribe();
  expect(observed[0]).toBe('before');
  expect(useAiStore.getState().turns.map((turn) => turn.text)).toEqual(['before', '']);
  flushAiStream();
  expect(useAiStore.getState().turns[1]!.text).toBe('other');
  expect(vi.getTimerCount()).toBe(0);
});

it('flushes text before clearing a cancelled turn and never restores stale liveness', () => {
  receiveAiEvent('a', { type: 'request_started' });
  receiveAiEvent('a', { type: 'text_delta', text: 'partial' });
  receiveAiEvent('a', { type: 'activity', reasoningChars: 2, contentChars: 7, toolChars: 0 });
  clearModelLiveness('a');
  expect(useAiStore.getState().turns[0]!.text).toBe('partial');
  expect(useAiStore.getState().liveness.a).toBeUndefined();
  vi.runAllTimers();
  expect(useAiStore.getState().liveness.a).toBeUndefined();
});

it('publishes the last deltas before applying the authoritative finished result', () => {
  receiveAiEvent('a', { type: 'request_started' });
  receiveAiEvent('a', { type: 'text_delta', text: 'last deltas' });
  const texts: string[] = [];
  const unsubscribe = useAiStore.subscribe((state) => texts.push(state.turns[0]!.text));
  receiveAiEvent('a', {
    type: 'finished',
    result: {
      reason: 'completed',
      text: 'final result',
      history: [],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 },
      cost: { amount: 0, currency: 'USD', label: '' },
      toolCalls: 0,
      elapsedMs: 1,
      unresolvedIssues: [],
    },
  });
  unsubscribe();
  expect(texts[0]).toBe('last deltas');
  expect(texts.at(-1)).toBe('final result');
  expect(useAiStore.getState().turns[0]!.result?.reason).toBe('completed');
  expect(useAiStore.getState().liveness.a).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it('leaves workflow planning deltas unbuffered and preserves its existing liveness publication', () => {
  receiveAiEvent('a', { type: 'request_started' }, undefined, true);
  const writes = vi.spyOn(useAiStore, 'setState');
  for (let i = 0; i < 5000; i++) receiveAiEvent('a', { type: 'text_delta', text: 'plan' }, undefined, true);
  expect(writes).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  receiveAiEvent('a', { type: 'activity', reasoningChars: 10, contentChars: 0, toolChars: 0 }, undefined, true);
  expect(useAiStore.getState().liveness.a?.counts.reasoningChars).toBe(10);
  expect(useAiStore.getState().turns[0]!.text).toBe('');
});
