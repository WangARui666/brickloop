interface RenderSchedulerOptions {
  render(): void;
  settle(): void;
  visible(): boolean;
  report(error: unknown): void;
}

/** One demand-driven frame, with recovery only while work is pending. */
export function createRenderScheduler(options: RenderSchedulerOptions) {
  let disposed = false;
  let pendingFrame: number | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let settling: ReturnType<typeof setTimeout> | undefined;

  function clearWatchdog() {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  }
  function cancelPending() {
    if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
    pendingFrame = undefined;
    clearWatchdog();
  }
  function request() {
    if (disposed || pendingFrame !== undefined) return;
    const frame = requestAnimationFrame(() => {
      // A canceled callback must not clear a newer request if it arrives late.
      if (pendingFrame !== frame) return;
      pendingFrame = undefined;
      clearWatchdog();
      try {
        options.render();
      } catch (error) {
        options.report(error);
      }
    });
    pendingFrame = frame;
    if (options.visible()) {
      watchdog = setTimeout(() => {
        watchdog = undefined;
        if (!options.visible()) return;
        cancelPending();
        request();
      }, 1000);
    }
  }
  return {
    request,
    resized() {
      if (disposed) return;
      request();
      if (settling !== undefined) clearTimeout(settling);
      settling = setTimeout(() => {
        settling = undefined;
        // Recheck size once, including recovery from a transient setSize failure.
        options.settle();
        request();
      }, 100);
    },
    visibilityChanged() {
      if (disposed) return;
      if (!options.visible()) {
        clearWatchdog();
        return;
      }
      cancelPending();
      request();
    },
    dispose() {
      disposed = true;
      cancelPending();
      if (settling !== undefined) clearTimeout(settling);
      settling = undefined;
    },
  };
}
