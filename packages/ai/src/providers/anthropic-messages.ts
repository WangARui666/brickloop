import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaThinkingBlockParam,
  BetaRedactedThinkingBlockParam,
  BetaTextBlockParam,
  BetaToolUseBlockParam,
  BetaStopReason,
  BetaRefusalStopDetails,
  BetaOutputConfig,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ChatEvent, ChatRequest, ModelInfo, ModelProvider, TokenUsage, StreamOptions } from '../types.js';
import { emptyUsage } from '../types.js';
import {
  checkedCall,
  createStreamTransport,
  defaultCapabilities,
  providerError,
  safeModelList,
  sortedTools,
  streamError,
  type ProviderOptions,
} from './common.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export const anthropicEffortPresets = { fast: 'low', balanced: 'medium', deep: 'high' } as const;
export interface AnthropicOptions extends ProviderOptions {
  serverSideFallback?: boolean;
  effort?: NonNullable<BetaOutputConfig['effort']>;
}
export class AnthropicMessagesProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly billing = 'api';
  readonly endpoint: string;
  private catalog = new Map<string, ModelInfo>();
  constructor(private readonly options: AnthropicOptions) {
    this.endpoint = options.baseURL ?? 'https://api.anthropic.com';
  }
  private async client(apiKey?: string, transport = this.options.fetch) {
    return new Anthropic({
      apiKey: apiKey ?? (typeof this.options.apiKey === 'string' ? this.options.apiKey : await this.options.apiKey()),
      baseURL: this.endpoint,
      // The turn retries failed requests so already executed tools are never repeated.
      maxRetries: 0,
      ...(transport ? { fetch: transport } : {}),
    });
  }
  capabilities(model: string) {
    return this.options.modelCapabilities?.[model] ?? this.catalog.get(model)?.capabilities ?? defaultCapabilities;
  }
  async listModels(): Promise<ModelInfo[]> {
    let key: string | undefined;
    return safeModelList(
      async () => {
        key = typeof this.options.apiKey === 'string' ? this.options.apiKey : await this.options.apiKey();
        const client = await this.client(key);
        const result: ModelInfo[] = [];
        for await (const model of client.models.list()) {
          result.push({
            id: model.id,
            name: model.display_name,
            capabilities: {
              vision: model.capabilities?.image_input.supported ?? false,
              tools: true,
              reasoning: model.capabilities?.thinking.supported ?? false,
              maxContext: model.max_input_tokens ?? 0,
              contextWindow: model.max_input_tokens ?? null,
              ...(model.max_tokens ? { maxOutputTokens: model.max_tokens } : {}),
            },
            ...(model.max_tokens ? { maxOutputTokens: model.max_tokens } : {}),
          });
        }
        this.catalog = new Map(result.map((m) => [m.id, m]));
        return result;
      },
      () => (key ? [key] : []),
    );
  }
  private messages(request: ChatRequest): BetaMessageParam[] {
    const result: BetaMessageParam[] = [];
    for (const message of request.messages) {
      const content: BetaContentBlockParam[] = [];
      if (message.providerState?.provider === this.id) {
        result.push({ role: 'assistant', content: message.providerState.value as BetaContentBlockParam[] });
        continue;
      }
      for (const block of message.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        if (block.type === 'image')
          content.push({ type: 'image', source: { type: 'base64', media_type: block.mime, data: block.base64 } });
        if (block.type === 'tool_call')
          content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.arguments });
        if (block.type === 'tool_result')
          content.push({
            type: 'tool_result',
            tool_use_id: block.id,
            is_error: block.isError ?? false,
            content: block.content.map((c) =>
              c.type === 'text'
                ? { type: 'text', text: c.text }
                : { type: 'image', source: { type: 'base64', media_type: c.mime, data: c.base64 } },
            ),
          });
      }
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const previous = result.at(-1);
      if (previous?.role === role && Array.isArray(previous.content)) previous.content.push(...content);
      else if (content.length) result.push({ role, content });
    }
    return result;
  }
  async *stream(request: ChatRequest, signal: AbortSignal, options?: StreamOptions): AsyncIterable<ChatEvent> {
    let key: string | undefined;
    const transport = createStreamTransport(this.options.fetch, options);
    try {
      signal.throwIfAborted();
      key = typeof this.options.apiKey === 'string' ? this.options.apiKey : await this.options.apiKey();
      const client = await this.client(key, transport.fetch);
      const messages = this.messages(request);
      if (messages.at(-1)?.role === 'assistant') {
        yield { type: 'error', error: { category: 'invalid_request', message: 'Assistant prefill is not supported.' } };
        return;
      }
      const stream = await client.beta.messages.create(
        {
          model: request.model || DEFAULT_ANTHROPIC_MODEL,
          system: request.system,
          messages,
          stream: true,
          // The SDK requires a number in its type; undefined is omitted on the wire.
          max_tokens: request.maxOutputTokens!,
          thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
          output_config: { effort: this.options.effort ?? anthropicEffortPresets[request.effort ?? 'balanced'] },
          cache_control: { type: 'ephemeral' },
          tools: sortedTools(request).map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: { ...t.parameters, type: 'object' },
            eager_input_streaming: true,
          })),
          tool_choice: { type: 'auto' },
          betas: [
            'thinking-binding-controls-2026-08-01',
            ...(this.options.serverSideFallback !== false ? ['server-side-fallback-2026-07-01'] : []),
          ],
          ...(this.options.serverSideFallback !== false ? { fallbacks: 'default' as const } : {}),
        },
        { signal },
      );
      const calls = new Map<number, { id: string; name: string; arguments: string; initial: unknown }>();
      const blocks = new Map<
        number,
        BetaThinkingBlockParam | BetaRedactedThinkingBlockParam | BetaTextBlockParam | BetaToolUseBlockParam
      >();
      let reason: BetaStopReason | null = null;
      let details: BetaRefusalStopDetails | null = null;
      let stopped = false;
      const usage: TokenUsage = emptyUsage();
      const activity = { type: 'activity' as const, reasoningChars: 0, contentChars: 0, toolChars: 0 };
      for await (const event of stream) {
        if (event.type === 'message_start') {
          const u = event.message.usage;
          usage.inputTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          usage.outputTokens = u.output_tokens;
          usage.cacheReadInputTokens = u.cache_read_input_tokens ?? 0;
          usage.cacheWriteInputTokens = u.cache_creation_input_tokens ?? 0;
        }
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'text') activity.contentChars += block.text.length;
          if (block.type === 'thinking') activity.reasoningChars += block.thinking.length;
          if (block.type === 'tool_use' && block.input && Object.keys(block.input).length)
            activity.toolChars += JSON.stringify(block.input).length;
          if (block.type === 'tool_use')
            calls.set(event.index, { id: block.id, name: block.name, arguments: '', initial: block.input });
          if (
            block.type === 'thinking' ||
            block.type === 'redacted_thinking' ||
            block.type === 'text' ||
            block.type === 'tool_use'
          )
            blocks.set(event.index, { ...block });
          if (block.type === 'text' && block.text) yield { type: 'text_delta', text: block.text };
        }
        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') activity.contentChars += delta.text.length;
          if (delta.type === 'thinking_delta') activity.reasoningChars += delta.thinking.length;
          if (delta.type === 'input_json_delta') activity.toolChars += delta.partial_json.length;
          const call = calls.get(event.index);
          const thought = blocks.get(event.index);
          if (delta.type === 'text_delta') yield { type: 'text_delta', text: delta.text };
          if (delta.type === 'text_delta' && thought?.type === 'text') thought.text += delta.text;
          if (delta.type === 'input_json_delta' && call) call.arguments += delta.partial_json;
          if (delta.type === 'thinking_delta' && thought?.type === 'thinking') thought.thinking += delta.thinking;
          if (delta.type === 'signature_delta' && thought?.type === 'thinking') thought.signature += delta.signature;
        }
        if (event.type === 'message_delta') {
          reason = event.delta.stop_reason;
          details = event.delta.stop_details;
          usage.outputTokens = event.usage.output_tokens;
        }
        if (event.type === 'message_stop') stopped = true;
        yield { ...activity };
      }
      yield { type: 'usage', usage };
      if (!stopped || !reason) {
        yield streamError();
        return;
      }
      if (reason === 'refusal') {
        yield {
          type: 'error',
          error: {
            category: 'refusal',
            message: 'The model refused the request.',
            details: JSON.parse(JSON.stringify(details)) as null | Record<string, string>,
          },
        };
        return;
      }
      if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') {
        yield { type: 'done', reason: 'max_tokens' };
        return;
      }
      for (const [index, call] of calls) {
        const block = blocks.get(index);
        if (block?.type === 'tool_use' && call.arguments) {
          try {
            block.input = JSON.parse(call.arguments) as unknown;
          } catch {
            block.input = { _invalid_json: call.arguments };
          }
        }
      }
      yield { type: 'provider_state', state: { provider: this.id, value: [...blocks.values()] } };
      for (const call of calls.values())
        yield checkedCall(
          request,
          { type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments || call.initial },
          Boolean(call.arguments),
        );
      yield { type: 'done', reason: calls.size ? 'tool_calls' : 'stop' };
    } catch (error) {
      yield signal.aborted
        ? { type: 'done', reason: 'cancelled' }
        : {
            type: 'error',
            error: providerError(error, key ? [key] : [], transport.retry),
          };
    }
  }
}
