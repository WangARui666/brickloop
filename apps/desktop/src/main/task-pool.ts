import { availableParallelism } from 'node:os';

export function meshConcurrency(limit = Number(process.env.BRICKLOOP_MESH_WORKERS ?? 8)) {
  const cap = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 8;
  return Math.max(1, Math.min(cap, Math.floor(availableParallelism() / 2)));
}

/** Deduplicate queued/running work. A timeout measures execution, never queue residence. */
export class TaskPool<I, O> {
  private readonly pending = new Map<string, Promise<O>>();
  private readonly queue: { input: I; resolve(value: O): void; reject(error: Error): void }[] = [];
  private readonly busy = new Set<number>();
  private readonly cancel = new Map<number, () => void>();
  private closed = false;
  constructor(
    private readonly options: {
      concurrency: number;
      timeoutMs: number;
      run(input: I, slot: number): Promise<O>;
      reset(slot: number): void;
    },
  ) {}
  get(key: string, input: I): Promise<O> {
    if (this.closed) return Promise.reject(new Error('Pool disposed'));
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = new Promise<O>((resolve, reject) => this.queue.push({ input, resolve, reject }));
    this.pending.set(key, task);
    void task.finally(() => this.pending.delete(key)).catch(() => undefined);
    this.pump();
    return task;
  }
  private pump() {
    for (let slot = 0; slot < this.options.concurrency && this.queue.length && !this.closed; slot++) {
      if (this.busy.has(slot)) continue;
      const job = this.queue.shift()!;
      this.busy.add(slot);
      const timer = setTimeout(() => {
        this.options.reset(slot);
        finish(new Error('Worker execution timeout'));
      }, this.options.timeoutMs);
      let done = false;
      const finish = (error?: Error, result?: O) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.busy.delete(slot);
        this.cancel.delete(slot);
        if (error) job.reject(error);
        else job.resolve(result!);
        this.pump();
      };
      this.cancel.set(slot, () => {
        this.options.reset(slot);
        finish(new Error('Pool disposed'));
      });
      void this.options.run(job.input, slot).then(
        (value) => finish(undefined, value),
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
      );
    }
  }
  dispose() {
    this.closed = true;
    this.queue.splice(0).forEach((job) => job.reject(new Error('Pool disposed')));
    for (const cancel of [...this.cancel.values()]) cancel();
  }
}
