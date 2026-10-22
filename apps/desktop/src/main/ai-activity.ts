import type { AgentEvent, ModelActivity } from '@brickloop/ai';

/** Coalesce only activity IPC; every other event keeps its original order and content. */
export function coalesceActivity<T>(
  emit: (event: T) => void,
  agentEvent: (event: T) => AgentEvent | undefined,
  now: () => number = Date.now,
) {
  type Phase = 'reasoning' | 'content' | 'tool' | undefined;
  let previous: ModelActivity | undefined;
  let phase: Phase;
  let forwardedPhase: Phase;
  let forwardedAt: number | undefined;
  let pending: T | undefined;
  const flush = () => {
    if (pending === undefined) return;
    const event = pending;
    pending = undefined;
    forwardedAt = now();
    forwardedPhase = phase;
    emit(event);
  };
  return {
    flush,
    push(event: T) {
      const agent = agentEvent(event);
      if (agent?.type !== 'activity') {
        flush();
        if (agent?.type === 'request_started') {
          previous = undefined;
          phase = forwardedPhase = undefined;
          forwardedAt = undefined;
        }
        emit(event);
        return;
      }
      if (agent.toolChars > (previous?.toolChars ?? 0)) phase = 'tool';
      else if (agent.contentChars > (previous?.contentChars ?? 0)) phase = 'content';
      else if (agent.reasoningChars > (previous?.reasoningChars ?? 0)) phase = 'reasoning';
      previous = agent;
      pending = event;
      if (forwardedAt === undefined || now() - forwardedAt >= 250 || phase !== forwardedPhase) flush();
    },
  };
}
