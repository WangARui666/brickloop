import { ProviderFailure, redact } from '@brickloop/ai';
import type { AiError, ModelProvider, TokenUsage } from '@brickloop/ai';
import type { ConnectionError } from '../shared/ai-setup';

export function maskConnectionDetails(text: string, secrets: readonly string[]): string {
  const variants = secrets.filter(Boolean).flatMap((s) => [s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)]);
  let result = text;
  for (const secret of variants.sort((a, b) => b.length - a.length)) result = result.replaceAll(secret, '[REDACTED]');
  return redact(result)
    .replace(/(Bearer\s+)[^\s"',}]+/gi, '$1[REDACTED]')
    .slice(0, 4000);
}
export function connectionIssue(error: {
  status?: number;
  code?: string;
  message?: string;
  category?: string;
}): ConnectionError {
  const code = `${error.code ?? ''} ${error.message ?? ''}`;
  if (
    error.status === 402 ||
    /insufficient.?balance|arrear|balance.?not.?enough|credit.?balance|403004|1113/i.test(code)
  )
    return 'balance';
  if (error.status === 401 || error.status === 403 || error.category === 'auth') return 'auth';
  if (error.status === 404) return 'address';
  if (error.status === 429 || error.category === 'quota_exceeded' || /quota|rate.?limit/i.test(code)) return 'quota';
  if (/(?:unsupported|not.?support).*(?:tool|vision|image)|(?:tool|vision|image).*not.?support/i.test(code))
    return 'capability';
  if (
    error.category === 'network' ||
    /ENOTFOUND|ECONNRESET|ETIMEDOUT|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|timeout|timed out|fetch failed/i.test(code)
  )
    return 'network';
  return 'unknown';
}
/** Collect bounded diagnostics only for the current probe. Never log headers or bodies. */
export function connectionFetch(fetcher: typeof fetch, signal: AbortSignal, secrets: readonly string[]) {
  let diagnostic: { status?: number; code?: string; message?: string } | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const credentials = [
      ...secrets,
      headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
      headers.get('x-api-key') ?? '',
      headers.get('x-goog-api-key') ?? '',
    ];
    try {
      const response = await fetcher(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
      if (!response.ok) {
        const reader = response.clone().body?.getReader();
        const decoder = new TextDecoder();
        let body = '';
        try {
          while (reader && body.length < 8000) {
            const { value, done } = await reader.read();
            if (done) break;
            body += decoder.decode(value, { stream: true });
          }
        } finally {
          void reader?.cancel().catch(() => undefined);
        }
        diagnostic = { status: response.status, message: maskConnectionDetails(body, credentials) };
      }
      return response;
    } catch (error) {
      diagnostic = { message: maskConnectionDetails(String(error), credentials) };
      throw error;
    }
  };
  return {
    fetch,
    diagnostic: () => diagnostic,
    clear: () => {
      diagnostic = undefined;
    },
  };
}
export function connectionFailure(error: unknown, diagnostic?: { status?: number; code?: string; message?: string }) {
  const detail: Partial<AiError> = error instanceof ProviderFailure ? error.error : { message: String(error) };
  const merged = { ...detail, ...diagnostic };
  return {
    issue: connectionIssue(merged),
    ...(merged.status === undefined ? {} : { status: merged.status }),
    details: merged.message ?? 'Connection failed',
  };
}
export async function minimalConnectionRequest(
  provider: ModelProvider,
  model: string,
  signal: AbortSignal,
  record: (usage: TokenUsage) => Promise<void>,
) {
  let completed = false;
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
  try {
    for await (const event of provider.stream(
      {
        model,
        system: 'Reply only OK. Use no more than 16 output tokens.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'OK' }] }],
        tools: [],
        effort: 'fast',
        maxOutputTokens: 16,
      },
      signal,
    )) {
      if (event.type === 'usage') usage = event.usage;
      if (event.type === 'error') throw new ProviderFailure(event.error);
      if (event.type === 'done' && (event.reason === 'stop' || event.reason === 'max_tokens')) completed = true;
    }
    signal.throwIfAborted();
    if (!completed) throw new Error('Incomplete stream');
  } finally {
    await record(usage);
  }
}
