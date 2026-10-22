import type { AiError, PublicAiError, RetryMetadata } from './types.js';
import { redact } from './secrets.js';

/** openai-node client.ts: prefer retry-after-ms, then seconds / HTTP date; only retain parsed values. */
export function parseRetryHeaders(headers: Headers, now: () => number = Date.now): RetryMetadata {
  const result: RetryMetadata = {};
  const shouldRetry = headers.get('x-should-retry');
  if (shouldRetry === 'true' || shouldRetry === 'false') result.shouldRetry = shouldRetry === 'true';
  const milliseconds = headers.get('retry-after-ms');
  let delay = milliseconds ? Number.parseFloat(milliseconds) : NaN;
  if (Number.isNaN(delay)) {
    const after = headers.get('retry-after');
    if (after) {
      const seconds = Number.parseFloat(after);
      delay = Number.isNaN(seconds) ? Date.parse(after) - now() : seconds * 1000;
    }
  }
  if (Number.isFinite(delay) && delay >= 0) result.retryAfterMs = delay;
  return result;
}

/** Provider overflow wording, matched before diagnostics are shortened or redacted.
 * Rules follow opencode's provider-error classification (reviewed 2026-10-20). */
export function isContextOverflow(text: string): boolean {
  if (
    /^(?:throttling error|service unavailable):/i.test(text) ||
    /rate limit|too many requests|max[_ ]tokens must be less than/i.test(text)
  )
    return false;
  return [
    /prompt (?:is too long|too long|超长)|input is too long for requested model/i,
    /exceeded this model context window limit|exceeds the context window|context window exceeds limit/i,
    /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
    /input token count.*exceeds the maximum|number of input tokens exceeds maximum length/i,
    /tokens in request more than max tokens allowed|maximum prompt length is \d+/i,
    /reduce the length of the messages|requested input length \d+ exceeds maximum input length/i,
    /maximum context length is \d+ tokens|exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
    /input(?: \(\d+ tokens\))? is longer than the model'?s context length/i,
    /exceeds the limit of \d+|exceeds the available context size|greater than the context length/i,
    /\x60inputs\x60 tokens \+ \x60max_new_tokens\x60 must be <= \d+/i,
    /exceeded model token limit|context[_ ]length[_ ]exceeded|context length is only \d+ tokens/i,
    /input length.*exceeds.*context length|too large for model with \d+ maximum context length/i,
    /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
    /model_context_window_exceeded|range of input length should be|too many tokens|token limit exceeded|request_too_large/i,
    /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i,
  ].some((rule) => rule.test(text));
}

/** Provider diagnostics are bounded, single-line and safe to cross IPC / persist. */
export function sanitizeProviderMessage(value: string, secrets: readonly string[] = []): string {
  const variants = secrets.filter(Boolean).flatMap((s) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)]);
  return redact(value, variants)
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
export function publicAiError(error: AiError | PublicAiError, secrets: readonly string[] = []): PublicAiError {
  return {
    category: error.category,
    ...(error.code ? { code: sanitizeProviderMessage(error.code, secrets) } : {}),
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.requestId ? { requestId: sanitizeProviderMessage(error.requestId, secrets) } : {}),
    ...(error.providerMessage ? { providerMessage: sanitizeProviderMessage(error.providerMessage, secrets) } : {}),
    ...(error.finishReason && /^[a-z_]{1,40}$/.test(error.finishReason) ? { finishReason: error.finishReason } : {}),
  };
}
