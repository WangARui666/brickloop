import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { streamCoalescer, type StreamEntry } from '../src/renderer/src/stream-coalescer';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('applies a burst once per frame, preserving all entries and arrival timestamps', () => {
  const apply = vi.fn();
  const stream = streamCoalescer(apply, () => true);
  vi.setSystemTime(100);
  for (const text of ['a', '积木', '🙂', 'z']) stream.push('a', text);
  expect(apply).not.toHaveBeenCalled();
  vi.advanceTimersByTime(16);
  expect(apply).toHaveBeenCalledExactlyOnceWith('a', [
    { value: 'a', receivedAt: 100 },
    { value: '积木', receivedAt: 100 },
    { value: '🙂', receivedAt: 100 },
    { value: 'z', receivedAt: 100 },
  ]);
  expect(vi.getTimerCount()).toBe(0);
  stream.push('a', 'next');
  vi.advanceTimersByTime(15);
  expect(apply).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(apply).toHaveBeenCalledTimes(2);
});

it('flushes only the matching turn before a non-incremental barrier', () => {
  const applied: [string, string[]][] = [];
  const stream = streamCoalescer<string>(
    (id, entries) => applied.push([id, entries.map((entry) => entry.value)]),
    (value) => value !== 'tool',
  );
  stream.push('a', 'one');
  stream.push('b', 'other');
  stream.push('a', 'two');
  stream.push('a', 'tool');
  expect(applied).toEqual([
    ['a', ['one', 'two']],
    ['a', ['tool']],
  ]);
  stream.push('a', 'three');
  vi.advanceTimersByTime(16);
  expect(applied.slice(2)).toEqual([
    ['b', ['other']],
    ['a', ['three']],
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it('uses the 50ms fallback when the hidden page never receives an animation frame', () => {
  const frame = vi.fn(() => 1);
  vi.stubGlobal('requestAnimationFrame', frame);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const apply = vi.fn();
  const stream = streamCoalescer(apply, () => true);
  stream.push('a', 'hidden');
  vi.advanceTimersByTime(49);
  expect(apply).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  stream.push('a', 'still hidden');
  vi.advanceTimersByTime(50);
  expect(apply).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('supports injected scheduling, cancellation and time; dispose drops pending callbacks', () => {
  const apply = vi.fn<(id: string, entries: readonly StreamEntry<string>[]) => void>();
  const cancel = vi.fn();
  let callback = () => {};
  const schedule = vi.fn((flush: () => void) => {
    callback = flush;
    return cancel;
  });
  const stream = streamCoalescer(apply, () => true, { schedule, now: () => 7 });
  stream.push('a', 'first');
  stream.push('a', 'second');
  expect(schedule).toHaveBeenCalledTimes(1);
  stream.flush();
  expect(apply).toHaveBeenCalledExactlyOnceWith('a', [
    { value: 'first', receivedAt: 7 },
    { value: 'second', receivedAt: 7 },
  ]);
  expect(cancel).toHaveBeenCalledTimes(1);
  stream.push('b', 'discard');
  stream.dispose();
  expect(cancel).toHaveBeenCalledTimes(2);
  callback();
  stream.push('b', 'ignored');
  stream.flush();
  expect(apply).toHaveBeenCalledTimes(1);
});

it('keeps increments enqueued by a subscriber for the next frame', () => {
  const apply = vi.fn(() => {
    if (apply.mock.calls.length === 1) stream.push('a', 'next');
  });
  const stream = streamCoalescer(apply, () => true);
  stream.push('a', 'first');
  vi.advanceTimersByTime(16);
  expect(apply).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(16);
  expect(apply).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
