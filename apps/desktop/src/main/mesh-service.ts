import { Worker } from 'node:worker_threads';
import type { MeshResult } from '../shared/library-api';
import { meshConcurrency, TaskPool } from './task-pool';

export function createMeshService(library: string, cache: string, concurrency = meshConcurrency()) {
  const workers = new Map<number, Worker>();
  const pool = new TaskPool<{ file: string; customDir?: string; queuedAt: number }, MeshResult>({
    concurrency,
    timeoutMs: 120_000,
    reset(slot) {
      const worker = workers.get(slot);
      workers.delete(slot);
      void worker?.terminate();
    },
    run(job, slot) {
      const started = performance.now();
      let worker = workers.get(slot);
      if (!worker) {
        worker = new Worker(new URL('./mesh-worker.js', import.meta.url), { workerData: { library, cache } });
        workers.set(slot, worker);
      }
      const current = worker;
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          current.removeListener('message', message);
          current.removeListener('error', fail);
          current.removeListener('exit', exited);
        };
        const fail = (error: Error) => {
          cleanup();
          if (workers.get(slot) === current) workers.delete(slot);
          reject(error);
        };
        const exited = (code: number) => fail(new Error(`Mesh worker exited: ${code}`));
        const message = (value: { result?: MeshResult; error?: string }) => {
          cleanup();
          if (value.result)
            resolve({
              ...value.result,
              timing: {
                queueMs: started - job.queuedAt,
                deliveryMs: Math.max(0, performance.now() - started - value.result.durationMs),
              },
            });
          else reject(new Error(value.error ?? 'Mesh failed'));
        };
        current.once('message', message);
        current.once('error', fail);
        current.once('exit', exited);
        current.postMessage({ id: slot, ...job });
      });
    },
  });
  return {
    get(file: string, customDir?: string): Promise<MeshResult> {
      return pool.get(`${customDir ?? ''}/${file}`, {
        file,
        queuedAt: performance.now(),
        ...(customDir ? { customDir } : {}),
      });
    },
    async dispose() {
      pool.dispose();
      await Promise.all([...workers.values()].map((worker) => worker.terminate()));
      workers.clear();
    },
  };
}
