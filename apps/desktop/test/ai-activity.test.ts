import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentEvent, ModelActivity, WorkflowEvent } from '@brickloop/ai';
import { coalesceActivity } from '../src/main/ai-activity';

const activity = (reasoningChars: number, contentChars = 0, toolChars = 0): ModelActivity => ({
  type: 'activity',
  reasoningChars,
  contentChars,
  toolChars,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

it('forwards the first event, limits a burst to 250ms, and flushes only the latest pending counts at stream end', () => {
  const events: AgentEvent[] = [];
  const notices = coalesceActivity<AgentEvent>(
    (event) => events.push(event),
    (event) => event,
  );
  notices.push(activity(1));
  for (let n = 2; n <= 250; n++) {
    vi.setSystemTime(n - 1);
    notices.push(activity(n));
  }
  expect(events).toEqual([activity(1)]);
  vi.setSystemTime(250);
  notices.push(activity(251));
  expect(events).toEqual([activity(1), activity(251)]);
  vi.setSystemTime(251);
  notices.push(activity(252));
  notices.push(activity(253));
  notices.flush();
  notices.flush();
  expect(events).toEqual([activity(1), activity(251), activity(253)]);
  expect(vi.getTimerCount()).toBe(0);
});

it('forwards phase changes immediately and resets counters for each model request', () => {
  const events: AgentEvent[] = [];
  const notices = coalesceActivity<AgentEvent>(
    (event) => events.push(event),
    (event) => event,
    () => 100,
  );
  const start: AgentEvent = { type: 'request_started' };
  notices.push(start);
  notices.push(activity(10));
  notices.push(activity(20));
  notices.push(activity(20, 1));
  notices.push(activity(20, 2));
  notices.push(activity(20, 2, 7));
  expect(events).toEqual([start, activity(10), activity(20, 1), activity(20, 2, 7)]);
  notices.push(activity(20, 2, 8));
  notices.push(start);
  notices.push(activity(0));
  notices.push(activity(1));
  expect(events.slice(-4)).toEqual([activity(20, 2, 8), start, activity(0), activity(1)]);
});

it('flushes before every non-activity event without changing its order, identity or contents', () => {
  const events: AgentEvent[] = [];
  const notices = coalesceActivity<AgentEvent>(
    (event) => events.push(event),
    (event) => event,
  );
  const original: AgentEvent[] = [
    { type: 'text_delta', text: 'reply' },
    { type: 'provider_state', state: { kind: 'openai-compatible-reasoning', reasoning: 'private' } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0 } },
    { type: 'tool_call', call: { type: 'tool_call', id: 'call', name: 'list_colors', arguments: {} } },
    { type: 'done', reason: 'stop' },
    { type: 'retry', attempt: 1, delayMs: 2000, error: { category: 'network' } },
  ];
  notices.push(activity(0));
  original.forEach((event, index) => {
    notices.push(activity(0, index + 1));
    notices.push(activity(0, index + 2));
    notices.push(event);
    expect(events.at(-2)).toEqual(activity(0, index + 2));
    expect(events.at(-1)).toBe(event);
  });
  expect(events.filter((event) => event.type !== 'activity')).toEqual(original);
});

it('handles nested workflow events and independent concurrent turns', () => {
  const first: WorkflowEvent[] = [],
    second: WorkflowEvent[] = [];
  const agent = (event: WorkflowEvent) => (event.type === 'agent' ? event.event : undefined);
  const a = coalesceActivity<WorkflowEvent>((event) => first.push(event), agent);
  const b = coalesceActivity<WorkflowEvent>((event) => second.push(event), agent);
  const one: WorkflowEvent = { type: 'agent', event: activity(1) };
  const two: WorkflowEvent = { type: 'agent', event: activity(2) };
  a.push(one);
  a.push(two);
  b.push(two);
  expect(first).toEqual([one]);
  expect(second).toEqual([two]);
  const state: WorkflowEvent = {
    type: 'state',
    state: {
      phase: 'understanding',
      paused: true,
      awaitingConfirmation: false,
      documentLocked: true,
      componentId: null,
      componentIndex: 0,
      round: 0,
      toolCalls: 0,
      elapsedMs: 0,
    },
  };
  a.push(state);
  expect(first).toEqual([one, two, state]);
  expect(second).toEqual([two]);
});
