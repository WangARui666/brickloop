import type { WorkflowState } from '@brickloop/ai';

/** Progress is a snapshot, not an event log. Publish at most once per UI frame,
 * including while Electron delivers a burst of IPC callbacks in one render cycle. */
export function workflowProgress(publish: (id: string, state: WorkflowState, receivedAt: number) => void) {
  const pending = new Map<string, { state: WorkflowState; receivedAt: number }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const batch = [...pending];
    pending.clear();
    for (const [id, value] of batch) publish(id, value.state, value.receivedAt);
  };
  return {
    push(id: string, state: WorkflowState) {
      pending.set(id, { state, receivedAt: Date.now() });
      timer ??= setTimeout(flush, 16);
    },
    flush,
  };
}
