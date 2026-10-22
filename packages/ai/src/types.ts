import type { z } from 'zod';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = {
  type: 'image';
  base64: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
};
export type ToolCallBlock = { type: 'tool_call'; id: string; name: string; arguments: unknown };
export type ToolResultBlock = {
  type: 'tool_result';
  id: string;
  name: string;
  content: (TextBlock | ImageBlock)[];
  isError?: boolean;
};
export type Message = {
  role: 'user' | 'assistant' | 'tool';
  content: (TextBlock | ImageBlock | ToolCallBlock | ToolResultBlock)[];
  /** Local checkpoint provenance; adapters send only the message role/content. */
  contextCheckpoint?: { createdAt: string };
  /** Opaque provider-owned replay state (signed thinking / thought signatures). Never log it. */
  providerState?:
    | { provider: string; value: unknown; kind?: never; reasoning?: never }
    | { kind: 'openai-compatible-reasoning'; reasoning: string; provider?: never; value?: never };
};
export interface ContextCheckpoint {
  summary: string;
  createdAt: string;
  /** Prefix replaced in the archival history supplied to this agent turn. */
  coveredMessages: number;
}
export interface ToolSpec {
  name: string;
  description: string;
  namespace: string;
  schema: z.ZodType;
  parameters: Record<string, unknown>;
  mutating: boolean;
}
export interface ModelCapabilities {
  vision: boolean;
  tools: boolean;
  reasoning: boolean;
  /** Legacy alias; 0 means unknown. Use contextWindow for capacity decisions. */
  maxContext: number;
  contextWindow: number | null;
  maxOutputTokens?: number;
  reasoningReplay?: boolean;
  thinkingControl?: 'deepseek';
  /** Anthropic high-resolution vision tier, only when explicitly known for this model. */
  highResolutionImages?: boolean;
}
export interface ModelInfo {
  id: string;
  name: string;
  capabilities?: ModelCapabilities;
  maxOutputTokens?: number;
}
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens?: number;
}
export type ErrorCategory =
  'auth' | 'rate_limit' | 'quota_exceeded' | 'refusal' | 'network' | 'invalid_request' | 'server';
export interface AiError {
  category: ErrorCategory;
  message: string;
  code?: string;
  status?: number;
  requestId?: string;
  details?: JsonValue;
  providerMessage?: string;
  finishReason?: string;
  /** Parsed transport metadata, excluded from public diagnostics and logs. */
  retryAfterMs?: number;
  shouldRetry?: boolean;
  timeout?: boolean;
}
export type RetryMetadata = Pick<AiError, 'retryAfterMs' | 'shouldRetry'>;
export interface StreamOptions {
  /** Called before SDK decoding; no response content crosses this boundary. */
  onResponseBytes?: (activity: { receivedAt: number; bytes: number }) => void;
}
export type PublicAiError = Pick<
  AiError,
  'category' | 'code' | 'status' | 'requestId' | 'providerMessage' | 'finishReason'
>;
export type StopReason = 'stop' | 'tool_calls' | 'max_tokens' | 'refusal' | 'cancelled';
export type ModelActivity = { type: 'activity'; reasoningChars: number; contentChars: number; toolChars: number };
export type ChatEvent =
  | ModelActivity
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_summary'; text: string }
  | { type: 'tool_call'; call: ToolCallBlock }
  | { type: 'provider_state'; state: NonNullable<Message['providerState']> }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; reason: StopReason }
  | { type: 'error'; error: AiError; invalidCall?: ToolCallBlock };
export interface ChatRequest {
  model: string;
  system: string;
  messages: readonly Message[];
  tools: readonly ToolSpec[];
  effort?: 'fast' | 'balanced' | 'deep';
  maxOutputTokens?: number;
}
export interface ModelProvider {
  readonly id: string;
  readonly billing: 'api' | 'plan';
  /** Host uses this before sending data (including first-image consent). */
  readonly endpoint: string;
  listModels(): Promise<ModelInfo[]>;
  capabilities(model: string): ModelCapabilities;
  stream(request: ChatRequest, signal: AbortSignal, options?: StreamOptions): AsyncIterable<ChatEvent>;
}
export const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 });
