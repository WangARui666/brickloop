import type { AiTaskInfo, AiTaskStatus } from '../shared/ai-api';

interface Entry {
  info: AiTaskInfo;
  controller: AbortController;
  run(signal: AbortSignal): Promise<AiTaskStatus>;
  /** Runs after a started task settles and releases its slot, even when discarded. */
  completed?(): void;
  done?: Promise<void>;
  settle(): void;
  settled: Promise<void>;
}
/** Scheduling is independent of Electron and document storage. The renderer owns copies. */
export class AiTaskManager {
  private entries = new Map<string, Entry>();
  private limit = 3;
  constructor(private readonly changed: (task: AiTaskInfo) => void) {}
  list() {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }
  get(id: string) {
    return this.entries.get(id)?.info;
  }
  setLimit(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('INVALID_CONCURRENCY');
    this.limit = limit;
    this.pump();
  }
  add(info: AiTaskInfo, run: Entry['run'], completed?: Entry['completed']) {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.entries.set(info.taskId, {
      info: { ...info, status: 'queued' },
      controller: new AbortController(),
      run,
      ...(completed ? { completed } : {}),
      settle,
      settled,
    });
    this.changed(this.entries.get(info.taskId)!.info);
    this.pump();
  }
  update(id: string, status: AiTaskStatus) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.info = {
      ...entry.info,
      status,
      ...(['queued', 'running'].includes(status) ? {} : { endedAt: entry.info.endedAt ?? Date.now() }),
    };
    this.changed({ ...entry.info });
  }
  async stop(id: string, discard = false) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.controller.abort();
    if (entry.info.status === 'queued') {
      this.update(id, discard ? 'discarded' : 'stopped');
      entry.settle();
    }
    if (discard) this.update(id, 'discarded');
    await entry.settled;
    this.pump();
  }
  async close() {
    await Promise.all(this.list().map((e) => this.stop(e.taskId, true)));
  }
  private pump() {
    const running = [...this.entries.values()].filter((e) => !!e.done);
    let slots = this.limit - running.length;
    for (const entry of this.entries.values()) {
      if (slots <= 0) break;
      if (entry.info.status !== 'queued') continue;
      if (
        entry.info.kind === 'image' &&
        running.some((e) => e.info.kind === 'image' && e.info.documentId === entry.info.documentId)
      )
        continue;
      slots--;
      running.push(entry);
      entry.info.startedAt = Date.now();
      this.update(entry.info.taskId, 'running');
      entry.done = Promise.resolve()
        .then(() => entry.run(entry.controller.signal))
        .then((status) => {
          if (entry.info.status !== 'discarded') this.update(entry.info.taskId, status);
        })
        .catch(() => {
          if (entry.info.status !== 'discarded') this.update(entry.info.taskId, 'failed');
        })
        .finally(() => {
          delete entry.done;
          entry.settle();
          this.pump();
          entry.completed?.();
        });
    }
  }
}
