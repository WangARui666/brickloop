import type { ChatEvent, ChatRequest, ModelProvider } from '../types.js';

export const STREAM_STALL_MS = 600_000;
export type RequestStarted = { type: 'request_started' };
export type TransportActivity = { type: 'transport_activity'; receivedAt: number; bytes: number };
const TRANSPORT_ACTIVITY_INTERVAL_MS = 250;

/** Each attempt owns its signal and idle timer. Cancellation of the turn always wins. */
export async function* watchModelStream(
  provider: ModelProvider,
  request: ChatRequest,
  parent: AbortSignal,
  stallMs = STREAM_STALL_MS,
): AsyncGenerator<ChatEvent | RequestStarted | TransportActivity> {
  const controller = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: () => void = () => undefined;
  let transport: TransportActivity | undefined;
  let rawBytes = false;
  let publishedAt = -Infinity;
  const cancel = () => {
    clearTimeout(timer);
    controller.abort();
    release();
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      cancel();
    }, stallMs);
  };
  parent.addEventListener('abort', cancel, { once: true });
  let iterator: AsyncIterator<ChatEvent> | undefined;
  try {
    if (parent.aborted) {
      cancel();
      return;
    }
    arm();
    const stream = provider.stream(request, controller.signal, {
      onResponseBytes(activity) {
        if (controller.signal.aborted) return;
        rawBytes = true;
        arm();
        transport = {
          type: 'transport_activity',
          receivedAt: activity.receivedAt,
          bytes: (transport?.bytes ?? 0) + activity.bytes,
        };
        if (activity.receivedAt - publishedAt >= TRANSPORT_ACTIVITY_INTERVAL_MS) release();
      },
    });
    iterator = stream[Symbol.asyncIterator]();
    let next: IteratorResult<ChatEvent> | undefined;
    let failed = false;
    let failure: unknown;
    const read = () => {
      next = undefined;
      // Attach once per SDK read, even if many keep-alives wake us before it resolves.
      void iterator!.next().then(
        (value) => {
          next = value;
          release();
        },
        (error: unknown) => {
          failed = true;
          failure = error;
          release();
        },
      );
    };
    // Start before publishing UI state: a workflow pause must not bypass its gate.
    read();
    yield { type: 'request_started' };
    while (true) {
      if (parent.aborted) return;
      if (stalled) {
        yield {
          type: 'error',
          error: {
            category: 'network',
            code: 'STREAM_STALLED',
            message: 'The provider stream stopped responding.',
          },
        };
        return;
      }
      if (failed) throw failure;
      if (transport && (next?.done || transport.receivedAt - publishedAt >= TRANSPORT_ACTIVITY_INTERVAL_MS)) {
        const activity = transport;
        transport = undefined;
        publishedAt = activity.receivedAt;
        yield activity;
        continue;
      }
      if (next) {
        if (next.done) return;
        // Custom providers without a raw fetch hook fall back to SDK event timing.
        // All four built-in HTTP adapters report bytes before decoding any event.
        if (!rawBytes) arm();
        yield next.value;
        read();
        continue;
      }
      await new Promise<void>((resolve) => {
        release = resolve;
        if (controller.signal.aborted) resolve();
      });
    }
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', cancel);
    controller.abort();
    // Do not let an adapter ignoring abort strand the turn. Rejections remain observed.
    void iterator?.return?.().catch(() => undefined);
  }
}
