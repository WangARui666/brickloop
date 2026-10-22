import { afterEach, expect, it, vi } from 'vitest';
import { meshConcurrency, TaskPool } from '../src/main/task-pool';

afterEach(() => vi.useRealTimers());
it('deduplicates pending work and limits concurrent execution', async () => {
  const complete: (() => void)[] = [];
  const run = vi.fn((n: number) => new Promise<number>((resolve) => complete.push(() => resolve(n))));
  const pool = new TaskPool({ concurrency: 2, timeoutMs: 1000, run, reset: vi.fn() });
  const a = pool.get('a', 1),
    b = pool.get('b', 2),
    c = pool.get('c', 3);
  expect(pool.get('a', 1)).toBe(a);
  expect(run).toHaveBeenCalledTimes(2);
  complete.shift()!();
  expect(await a).toBe(1);
  expect(run).toHaveBeenCalledTimes(3);
  complete.splice(0).forEach((finish) => finish());
  expect(await Promise.all([b, c])).toEqual([2, 3]);
  pool.dispose();
});
it('times execution, resets timed-out workers and permits a successful retry', async () => {
  vi.useFakeTimers();
  const reset = vi.fn();
  const run = vi.fn((n: number) => (n === 1 ? new Promise<number>(() => undefined) : Promise.resolve(n)));
  const pool = new TaskPool({ concurrency: 1, timeoutMs: 100, run, reset });
  const failed = pool.get('a', 1).catch((error: Error) => error.message);
  const queued = pool.get('b', 2);
  await vi.advanceTimersByTimeAsync(101);
  expect(await failed).toContain('execution timeout');
  expect(await queued).toBe(2);
  expect(reset).toHaveBeenCalledTimes(1);
  expect(await pool.get('a', 3)).toBe(3);
  expect(meshConcurrency(1)).toBe(1);
  expect(meshConcurrency(4)).toBeLessThanOrEqual(4);
  pool.dispose();
});
