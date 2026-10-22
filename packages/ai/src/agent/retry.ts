import type { AiError } from '../types.js';

// opencode packages/core/src/model-retry.ts (A-121): exponential gaps, ten retries,
// a separate three-timeout allowance, and provider delays bounded to fifteen minutes.
export const RETRY_INITIAL_MS = 2000;
export const RETRY_MAX_GAP_MS = 10_000;
export const MAX_RETRIES = 10;
export const MAX_TIMEOUT_RETRIES = 3;
export const RETRY_AFTER_MAX_MS = 15 * 60_000;
// openai-node src/client.ts: jitter only shortens the calculated gap, by up to 25%.
export const RETRY_JITTER = 0.25;

export function isTimeoutFailure(error: AiError): boolean {
  return (
    error.timeout === true ||
    error.status === 408 ||
    error.code === 'STREAM_STALLED' ||
    /^(?:ETIMEDOUT|ESOCKETTIMEDOUT|TIMEOUT|ERR_(?:CONNECTION_)?TIMED_OUT|.*_TIMEOUT)$/i.test(error.code ?? '')
  );
}

export function transientDelay(
  error: AiError | undefined,
  retries: number,
  options: { overrideMs?: number; random?: () => number; timeoutRetries?: number } = {},
): number | undefined {
  if (
    !error ||
    error.code === 'CONTEXT_OVERFLOW' ||
    error.shouldRetry === false ||
    retries >= MAX_RETRIES ||
    (isTimeoutFailure(error) && (options.timeoutRetries ?? retries) >= MAX_TIMEOUT_RETRIES)
  )
    return undefined;
  if (error.shouldRetry !== true && !['network', 'server', 'rate_limit'].includes(error.category)) return undefined;
  const gap = Math.min(RETRY_INITIAL_MS * 2 ** retries, RETRY_MAX_GAP_MS);
  const jittered = Math.ceil(gap * (1 - (options.random ?? Math.random)() * RETRY_JITTER));
  // The test-only override shortens backoff, but must not bypass a provider's minimum wait.
  const delay = Math.min(jittered, options.overrideMs ?? jittered);
  return Math.max(delay, Math.min(error.retryAfterMs ?? 0, RETRY_AFTER_MAX_MS));
}

/** An abort releases the wait immediately; the turn owns the final stop reason. */
export async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}
