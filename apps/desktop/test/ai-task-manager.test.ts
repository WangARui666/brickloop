import { describe, expect, it } from 'vitest';
import { AiTaskManager } from '../src/main/ai-task-manager';
import type { AiTaskInfo, AiTaskStatus } from '../src/shared/ai-api';
const info = (id: string, kind: AiTaskInfo['kind'] = 'chat', documentId = 'doc'): AiTaskInfo => ({
  taskId: id,
  documentId,
  kind,
  status: 'queued',
  createdAt: 0,
});
function deferred() {
  let resolve!: (value: AiTaskStatus) => void;
  const promise = new Promise<AiTaskStatus>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe('AI task scheduler', () => {
  it('starts at most three and starts the fourth after a slot is released', async () => {
    const manager = new AiTaskManager(() => undefined),
      jobs = Array.from({ length: 4 }, deferred);
    jobs.forEach((j, i) => manager.add(info(String(i)), () => j.promise));
    expect(manager.list().map((t) => t.status)).toEqual(['running', 'running', 'running', 'queued']);
    jobs[0]!.resolve('merged');
    await expect.poll(() => manager.get('3')!.status).toBe('running');
    jobs.forEach((j) => j.resolve('merged'));
    await manager.close();
  });
  it('serializes image tasks within one document without blocking other documents or chat', async () => {
    const manager = new AiTaskManager(() => undefined),
      jobs = Array.from({ length: 4 }, deferred);
    manager.add(info('a', 'image'), () => jobs[0]!.promise);
    manager.add(info('b', 'image'), () => jobs[1]!.promise);
    manager.add(info('c', 'image', 'another'), () => jobs[2]!.promise);
    manager.add(info('d'), () => jobs[3]!.promise);
    expect(manager.list().map((t) => t.status)).toEqual(['running', 'queued', 'running', 'running']);
    jobs[0]!.resolve('pending_merge');
    await expect.poll(() => manager.get('b')!.status).toBe('running');
    jobs.forEach((j) => j.resolve('merged'));
    await manager.close();
  });
  it('handles failures, queued cancellation, stopped partial results and live concurrency changes', async () => {
    const manager = new AiTaskManager(() => undefined);
    manager.setLimit(1);
    manager.add(
      info('a'),
      (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve('pending_merge'))),
    );
    manager.add(info('b'), async () => {
      throw new Error('offline');
    });
    manager.add(info('c'), async () => 'merged');
    await manager.stop('c');
    expect(manager.get('c')!.status).toBe('stopped');
    manager.setLimit(2);
    await expect.poll(() => manager.get('b')!.status).toBe('failed');
    await manager.stop('a');
    expect(manager.get('a')!.status).toBe('pending_merge');
    expect(() => manager.setLimit(6)).toThrow('INVALID_CONCURRENCY');
    expect(() => manager.setLimit(0)).toThrow('INVALID_CONCURRENCY');
  });
  it('discards a running task without allowing its completion to overwrite the state', async () => {
    const manager = new AiTaskManager(() => undefined),
      job = deferred();
    manager.add(info('a'), () => job.promise);
    const stopped = manager.stop('a', true);
    job.resolve('merged');
    await stopped;
    expect(manager.get('a')!.status).toBe('discarded');
  });
  it.each([false, true])('notifies completion after cleanup and slot release (discarded: %s)', async (discard) => {
    const manager = new AiTaskManager(() => undefined),
      job = deferred(),
      next = deferred();
    const completed: AiTaskStatus[][] = [];
    manager.setLimit(1);
    manager.add(
      info('a'),
      async () => {
        await job.promise;
        throw new Error('offline');
      },
      () => completed.push([manager.get('a')!.status, manager.get('b')!.status]),
    );
    manager.add(info('b'), () => next.promise);
    const stopped = discard ? manager.stop('a', true) : undefined;
    expect(completed).toEqual([]);
    expect(manager.get('b')!.status).toBe('queued');
    job.resolve('failed');
    await expect.poll(() => completed).toEqual([[discard ? 'discarded' : 'failed', 'running']]);
    await stopped;
    next.resolve('merged');
    await manager.close();
    expect(completed).toHaveLength(1);
  });
});
