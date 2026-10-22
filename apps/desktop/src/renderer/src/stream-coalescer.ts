export interface StreamEntry<T> {
  value: T;
  receivedAt: number;
}

export interface StreamScheduler {
  /** Schedule a frame with a hidden-page fallback; return its cancellation function. */
  schedule: (flush: () => void) => () => void;
  now: () => number;
}

export const frameScheduler: StreamScheduler = {
  schedule(flush) {
    const frame = requestAnimationFrame(flush);
    const timer = setTimeout(flush, 50);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  },
  now: () => Date.now(),
};

/** Batch increments per turn. Barriers synchronously drain only their own turn. */
export function streamCoalescer<T>(
  apply: (id: string, entries: readonly StreamEntry<T>[]) => void,
  incremental: (value: T) => boolean,
  scheduler: StreamScheduler = frameScheduler,
) {
  const pending = new Map<string, StreamEntry<T>[]>();
  let cancel: (() => void) | undefined;
  let disposed = false;

  function flush(id?: string) {
    const ids = id === undefined ? [...pending.keys()] : [id];
    for (const key of ids) {
      const entries = pending.get(key);
      if (!entries) continue;
      pending.delete(key);
      // Cancel before applying: subscribers may enqueue the next batch.
      if (!pending.size) {
        cancel?.();
        cancel = undefined;
      }
      apply(key, entries);
    }
  }

  return {
    flush,
    push(id: string, value: T) {
      if (disposed) return;
      const entry = { value, receivedAt: scheduler.now() };
      if (!incremental(value)) {
        flush(id);
        apply(id, [entry]);
        return;
      }
      const entries = pending.get(id);
      if (entries) entries.push(entry);
      else pending.set(id, [entry]);
      cancel ??= scheduler.schedule(() => {
        cancel?.();
        cancel = undefined;
        flush();
      });
    },
    dispose() {
      disposed = true;
      cancel?.();
      cancel = undefined;
      pending.clear();
    },
  };
}
