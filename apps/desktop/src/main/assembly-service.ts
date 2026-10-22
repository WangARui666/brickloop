import { Worker } from 'node:worker_threads';
import type { AssemblyApi, AssemblyPart, AnnotationSave } from '../shared/assembly-api';
import type { ConnectorFile } from '@brickloop/connect';
import { meshConcurrency, TaskPool } from './task-pool';

export function createAssemblyService(
  config: { library: string; connectors: string; colliders: string; cache: string; meshCache?: string },
  maintenance: () => boolean,
) {
  const workers = Array.from(
    { length: meshConcurrency(4) },
    () => new Worker(new URL('./assembly-worker.js', import.meta.url), { workerData: config }),
  );
  const pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>();
  let sequence = 0;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  for (const worker of workers) {
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`Assembly worker exited: ${code}`)));
    worker.on('message', (message: { id: number; result: unknown; error?: string }) => {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item?.reject(new Error(message.error));
      else item?.resolve(message.result);
    });
  }
  const pool = new TaskPool<{ kind: string; value: unknown }, unknown>({
    concurrency: workers.length,
    timeoutMs: 120_000,
    reset: (slot) => {
      void workers[slot]!.terminate();
    },
    run: ({ kind, value }, slot) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        workers[slot]!.postMessage({ id, kind, value });
      }),
  });
  let edits = Promise.resolve();
  const reads = new Set<Promise<unknown>>();
  function request<T>(kind: string, value: unknown): Promise<T> {
    if (failure) return Promise.reject(failure);
    if (kind === 'save') {
      const preceding = [...reads];
      const task = edits
        .then(() => Promise.allSettled(preceding))
        .then(() => pool.get(JSON.stringify([kind, value]), { kind, value }));
      edits = task.then(
        () => undefined,
        () => undefined,
      );
      return task as Promise<T>;
    }
    const task = edits.then(() => pool.get(JSON.stringify([kind, value]), { kind, value }));
    reads.add(task);
    void task.finally(() => reads.delete(task)).catch(() => undefined);
    return task as Promise<T>;
  }
  const api: Omit<AssemblyApi, 'setMaintenanceMode' | 'assemblyCatalog'> = {
    assemblyPart: (id) => request<AssemblyPart>('part', id),
    assemblyInfer: (id) => request<ConnectorFile>('infer', id),
    assemblySave: (value: AnnotationSave) => {
      if (!maintenance()) return Promise.reject(new Error('Maintenance mode required'));
      return request<AssemblyPart>('save', value);
    },
  };
  return {
    api,
    dispose: async () => {
      pool.dispose();
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}
