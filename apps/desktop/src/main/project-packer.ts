import { Worker } from 'node:worker_threads';
import type { ProjectPayload } from '../shared/project-api';

export function createProjectPacker(appVersion: string) {
  const worker = new Worker(new URL('./project-worker.js', import.meta.url), { workerData: { appVersion } });
  const pending = new Map<number, { resolve(bytes: Uint8Array): void; reject(error: Error): void }>();
  let sequence = 0;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error(`Project worker exited: ${code}`)));
  worker.on('message', (message: { id: number; bytes?: Uint8Array; error?: string }) => {
    const job = pending.get(message.id);
    pending.delete(message.id);
    if (message.bytes) job?.resolve(message.bytes);
    else job?.reject(new Error(message.error ?? 'Project packing failed'));
  });
  return {
    pack(project: ProjectPayload): Promise<Uint8Array> {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, project });
      });
    },
    dispose: () => worker.terminate(),
  };
}
