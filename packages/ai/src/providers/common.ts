import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { ApiError } from '@google/genai';
import { isContextOverflow, parseRetryHeaders, sanitizeProviderMessage } from '../errors.js';
import { CredentialError, redact } from '../secrets.js';
import type {
  AiError,
  ChatEvent,
  ChatRequest,
  ErrorCategory,
  JsonValue,
  ModelCapabilities,
  RetryMetadata,
  StreamOptions,
  ToolCallBlock,
} from '../types.js';

export const defaultCapabilities: ModelCapabilities = {
  vision: true,
  tools: true,
  reasoning: true,
  maxContext: 0,
  contextWindow: null,
};
export interface ProviderOptions {
  apiKey: string | (() => Promise<string>);
  baseURL?: string;
  fetch?: typeof fetch;
  /** Optional per-image estimate used until actual input usage becomes available. */
  modelCapabilities?: Record<string, ModelCapabilities & { imageTokens?: number }>;
}
/** A request-local wrapper below every SDK's SSE decoder, including Gemini (which drops error headers).
 * Keep backpressure and cancellation; observe only byte counts/times, never decode or retain the bytes. */
export function createStreamTransport(
  transport: typeof fetch = fetch,
  options?: StreamOptions,
  now: () => number = Date.now,
): { fetch: typeof fetch; retry: RetryMetadata } {
  const retry: RetryMetadata = {};
  return {
    retry,
    fetch: async (input, init) => {
      const response = await transport(input, init);
      if (!response.ok) Object.assign(retry, parseRetryHeaders(response.headers, now));
      if (!response.body || !options?.onResponseBytes) return response;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                controller.close();
                reader.releaseLock();
              } else {
                if (chunk.value.byteLength)
                  options.onResponseBytes?.({ receivedAt: now(), bytes: chunk.value.byteLength });
                controller.enqueue(chunk.value);
              }
            } catch (error) {
              controller.error(error);
              reader.releaseLock();
            }
          },
          async cancel(reason) {
            await reader.cancel(reason);
            reader.releaseLock();
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}
export function sortedTools(request: ChatRequest) {
  return [...request.tools].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
export function checkedCall(request: ChatRequest, call: ToolCallBlock, json = false): ChatEvent {
  let args = call.arguments;
  try {
    if (json && typeof args === 'string') args = JSON.parse(args) as unknown;
  } catch {
    return invalid(call);
  }
  const tool = request.tools.find((item) => item.name === call.name);
  const result = tool?.schema.safeParse(args);
  return result?.success
    ? { type: 'tool_call', call: { ...call, arguments: result.data } }
    : invalid({ ...call, arguments: args });
}
function invalid(call: ToolCallBlock): ChatEvent {
  return {
    type: 'error',
    error: {
      category: 'invalid_request',
      code: 'INVALID_TOOL_ARGUMENTS',
      message: 'Invalid JSON or tool arguments; return an error result to the model.',
    },
    invalidCall: call,
  };
}
function isInsufficientBalance(code?: string | null, description?: string): boolean {
  return /insufficient[\s_-]+balance|余额不足|arrear|credit[\s_-]+balance/i.test([code, description].join('\n'));
}
export function errorFromStatus(status?: number, code?: string | null): ErrorCategory {
  if (status === 402 || isInsufficientBalance(code)) return 'quota_exceeded';
  if (
    [
      'subscription_sharing_usage_limit_exceeded',
      'subscription_sharing_usage_unavailable',
      'insufficient_quota',
      'insufficient_balance',
      'credit_balance_too_low',
      'quota_exceeded',
    ].includes(code ?? '')
  )
    return 'quota_exceeded';
  if (
    [
      'invalid_api_key',
      'authentication_error',
      'permission_denied',
      'subscription_sharing_invalid_user',
      'subscription_sharing_user_not_eligible',
      'chatpass_v2_scope_not_authorized',
      'chatpass_v2_invalid_authorization_context',
    ].includes(code ?? '')
  )
    return 'auth';
  if (
    [
      'invalid_request',
      'invalid_request_error',
      'subscription_sharing_unsupported_capability',
      'subscription_sharing_route_not_supported',
    ].includes(code ?? '')
  )
    return 'invalid_request';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'network';
  if (status === 409) return 'server';
  if (status === 429 || code === 'rate_limit_exceeded') return 'rate_limit';
  if (code === 'content_policy_violation' || code === 'refusal') return 'refusal';
  if (status !== undefined && status >= 500) return 'server';
  if (status !== undefined && status >= 400) return 'invalid_request';
  return 'server';
}
export function providerError(error: unknown, secrets: readonly string[] = [], retry: RetryMetadata = {}): AiError {
  let category: ErrorCategory = 'network';
  let status: number | undefined;
  let code: string | undefined;
  let requestId: string | undefined;
  let details: JsonValue | undefined;
  let description: string | undefined;
  let rawBody: unknown;
  let emptyBody = false;
  if (error instanceof OpenAI.APIError || error instanceof Anthropic.APIError)
    retry = { ...(error.headers ? parseRetryHeaders(error.headers) : {}), ...retry };
  let timeout =
    error instanceof OpenAI.APIConnectionTimeoutError ||
    error instanceof Anthropic.APIConnectionTimeoutError ||
    (error instanceof Error &&
      ['TimeoutError', 'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError'].includes(error.name));
  // fetch/undici timeouts can sit underneath an SDK connection error and TypeError cause.
  const visited = new Set<unknown>();
  let cause: unknown = error;
  while (cause && typeof cause === 'object' && !visited.has(cause)) {
    visited.add(cause);
    if (
      'code' in cause &&
      /^(?:ETIMEDOUT|ESOCKETTIMEDOUT|ERR_(?:CONNECTION_)?TIMED_OUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(
        String(cause.code),
      )
    )
      timeout = true;
    if (cause instanceof Error && /\bnet::ERR_(?:CONNECTION_)?TIMED_OUT\b/.test(cause.message)) timeout = true;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  const bodyMessage = (body: unknown): string | undefined => {
    if (!body || typeof body !== 'object') return undefined;
    const value = body as { error?: unknown; message?: unknown };
    return bodyMessage(value.error) ?? (typeof value.message === 'string' ? value.message : undefined);
  };
  if (error instanceof CredentialError) return { category: 'auth', code: error.code, message: error.message };
  if (error instanceof OpenAI.APIError) {
    status = error.status;
    code = error.code == null ? undefined : String(error.code);
    requestId = error.requestID ?? undefined;
    category = error instanceof OpenAI.APIConnectionError ? 'network' : errorFromStatus(status, code);
    rawBody = error.error;
    details = errorShape(error.error);
    description = bodyMessage(error.error) ?? error.message;
  } else if (error instanceof Anthropic.APIError) {
    status = error.status;
    requestId = error.requestID ?? undefined;
    code = error.type ?? undefined;
    description = bodyMessage(error.error) ?? error.message;
    rawBody = error.error;
    details = errorShape(error.error);
    category =
      error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError
        ? 'auth'
        : error instanceof Anthropic.RateLimitError
          ? 'rate_limit'
          : error instanceof Anthropic.APIConnectionError
            ? 'network'
            : errorFromStatus(status);
  } else if (error instanceof ApiError) {
    status = error.status;
    category = errorFromStatus(status);
    rawBody = error.message;
    try {
      description = bodyMessage(JSON.parse(error.message));
      // Gemini wraps an empty HTTP body in a synthetic JSON error envelope.
      if (description === '') emptyBody = true;
    } catch {
      /* Plain-text SDK message. */
    }
  }
  description ??= error instanceof Error ? error.message : undefined;
  const text = [
    ...(emptyBody ? [`${status} (no body)`] : []),
    description,
    code,
    error instanceof Error ? error.message : '',
    typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody),
  ]
    .filter(Boolean)
    .join('\n');
  if (status === 402 || isInsufficientBalance(code, description)) {
    category = 'quota_exceeded';
  } else if (isContextOverflow(text)) {
    category = 'invalid_request';
    code = 'CONTEXT_OVERFLOW';
  }
  return {
    category,
    ...retry,
    ...(timeout || status === 408 ? { timeout: true } : {}),
    message: `Provider request failed (${category}).`,
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code: redact(code, secrets) } : {}),
    ...(requestId ? { requestId: redact(requestId, secrets) } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(description ? { providerMessage: sanitizeProviderMessage(description, secrets) } : {}),
  };
}
/** Preserve diagnostic body shape without retaining arbitrary echoed prompts or credentials. */
function errorShape(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(errorShape);
  if (typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, errorShape(entry)]));
  return `[${typeof value}]`;
}
export class ProviderFailure extends Error {
  constructor(readonly error: AiError) {
    super(error.message);
    this.name = 'ProviderFailure';
  }
}
export async function safeModelList<T>(
  operation: () => Promise<T>,
  secrets: () => readonly string[] = () => [],
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ProviderFailure(providerError(error, secrets()));
  }
}
export function streamError(message = 'Stream ended before a terminal event.'): ChatEvent {
  return { type: 'error', error: { category: 'network', code: 'INCOMPLETE_STREAM', message } };
}
export const dataUrl = (image: { base64: string; mime: string }): string => `data:${image.mime};base64,${image.base64}`;
