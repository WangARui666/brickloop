import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionContentPart,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type { ChatEvent, ChatRequest, ModelCapabilities, ModelInfo, ModelProvider, StreamOptions } from '../types.js';
import {
  checkedCall,
  createStreamTransport,
  dataUrl,
  defaultCapabilities,
  providerError,
  safeModelList,
  sortedTools,
  streamError,
  type ProviderOptions,
} from './common.js';

import { compatiblePresets, presetCapabilities } from './presets.js';
export { compatiblePresets } from './presets.js';
export interface CompatibleOptions extends ProviderOptions {
  preset?: keyof typeof compatiblePresets;
  name?: string;
}
export class OpenAIChatCompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly billing = 'api';
  readonly endpoint: string;
  constructor(private readonly options: CompatibleOptions) {
    this.id = `openai-compatible:${options.preset ?? options.name ?? 'custom'}`;
    this.endpoint =
      options.baseURL ?? (options.preset ? compatiblePresets[options.preset]!.baseURL : 'http://127.0.0.1:8000/v1');
  }
  private async client(apiKey?: string, transport = this.options.fetch) {
    return new OpenAI({
      apiKey: apiKey ?? (typeof this.options.apiKey === 'string' ? this.options.apiKey : await this.options.apiKey()),
      baseURL: this.endpoint,
      // The turn retries failed requests so already executed tools are never repeated.
      maxRetries: 0,
      ...(transport ? { fetch: transport } : {}),
    });
  }
  capabilities(model: string): ModelCapabilities {
    const preset = presetCapabilities(
      this.options.preset === undefined ? undefined : String(this.options.preset),
      model,
    );
    return (
      this.options.modelCapabilities?.[model] ?? {
        ...defaultCapabilities,
        vision: preset.vision,
        tools: preset.tools,
        maxContext: preset.maxContext,
        contextWindow: preset.contextWindow,
        reasoningReplay: preset.reasoningReplay,
        ...(preset.thinkingControl ? { thinkingControl: preset.thinkingControl } : {}),
        ...(preset.maxOutputTokens !== null ? { maxOutputTokens: preset.maxOutputTokens } : {}),
      }
    );
  }
  async listModels(): Promise<ModelInfo[]> {
    let key: string | undefined;
    return safeModelList(
      async () => {
        key = typeof this.options.apiKey === 'string' ? this.options.apiKey : await this.options.apiKey();
        const client = await this.client(key);
        const models: ModelInfo[] = [];
        for await (const m of client.models.list()) models.push({ id: m.id, name: m.id });
        return models;
      },
      () => (key ? [key] : []),
    );
  }
  private messages(request: ChatRequest): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [{ role: 'system', content: request.system }];
    for (const message of request.messages) {
      const calls: ChatCompletionMessageToolCall[] = [];
      const content: ChatCompletionContentPart[] = [];
      const extraImages: ChatCompletionContentPart[] = [];
      for (const block of message.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        if (block.type === 'image') content.push({ type: 'image_url', image_url: { url: dataUrl(block) } });
        if (block.type === 'tool_call')
          calls.push({
            type: 'function',
            id: block.id,
            function: { name: block.name, arguments: JSON.stringify(block.arguments) },
          });
        if (block.type === 'tool_result') {
          result.push({
            role: 'tool',
            tool_call_id: block.id,
            content: block.content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n'),
          });
          for (const c of block.content)
            if (c.type === 'image')
              extraImages.push(
                { type: 'text', text: `Image from ${block.name} (${block.id}).` },
                { type: 'image_url', image_url: { url: dataUrl(c) } },
              );
        }
      }
      if (message.role === 'assistant')
        result.push({
          role: 'assistant',
          content: content.filter((c) => c.type === 'text'),
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(message.providerState?.kind === 'openai-compatible-reasoning'
            ? { reasoning_content: message.providerState.reasoning }
            : {}),
        });
      else if (content.length) result.push({ role: 'user', content });
      // Place images after ALL parallel tool results, preserving the protocol's adjacency rule.
      if (extraImages.length) result.push({ role: 'user', content: extraImages });
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
      // Only capabilities verified for this family may add provider-specific fields.
      const thinking =
        this.capabilities(request.model).thinkingControl === 'deepseek'
          ? request.effort === 'fast'
            ? { thinking: { type: 'disabled' } }
            : request.effort === 'deep'
              ? { reasoning_effort: 'max', thinking: { type: 'enabled' } }
              : {}
          : {};
      const stream = await client.chat.completions.create(
        {
          model: request.model,
          messages: this.messages(request),
          stream: true,
          stream_options: { include_usage: true },
          tools: sortedTools(request).map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
          ...(thinking as Partial<ChatCompletionCreateParamsStreaming>),
        },
        { signal },
      );
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      let reason: string | null = null;
      let refused = false;
      let reasoning = '';
      let sawReasoning = false;
      const activity = { type: 'activity' as const, reasoningChars: 0, contentChars: 0, toolChars: 0 };
      for await (const chunk of stream) {
        if (chunk.usage)
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              cacheReadInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            },
          };
        const choice = chunk.choices[0];
        if (!choice) {
          yield { ...activity };
          continue;
        }
        const thought = (choice.delta as { reasoning_content?: unknown }).reasoning_content;
        if (typeof thought === 'string') {
          sawReasoning = true;
          reasoning += thought;
          activity.reasoningChars += thought.length;
        }
        activity.contentChars += choice.delta.content?.length ?? 0;
        if (choice.delta.content) yield { type: 'text_delta', text: choice.delta.content };
        if (choice.delta.refusal) refused = true;
        for (const c of choice.delta.tool_calls ?? []) {
          const call = calls.get(c.index) ?? { id: '', name: '', arguments: '' };
          if (c.id) call.id = c.id;
          if (c.function?.name) call.name += c.function.name;
          call.arguments += c.function?.arguments ?? '';
          activity.toolChars += c.function?.arguments?.length ?? 0;
          calls.set(c.index, call);
        }
        if (choice.finish_reason) reason = choice.finish_reason;
        yield { ...activity };
      }
      if (sawReasoning || this.capabilities(request.model).reasoningReplay)
        yield { type: 'provider_state', state: { kind: 'openai-compatible-reasoning', reasoning } };
      if (refused || reason === 'content_filter') {
        yield { type: 'error', error: { category: 'refusal', message: 'The model refused the request.' } };
        return;
      }
      if (reason === 'length') {
        yield { type: 'done', reason: 'max_tokens' };
        return;
      }
      if (reason !== 'stop' && reason !== 'tool_calls') {
        yield reason
          ? {
              type: 'error',
              error: {
                category: 'server',
                code:
                  reason === 'insufficient_system_resource'
                    ? 'INSUFFICIENT_SYSTEM_RESOURCE'
                    : reason === 'aborted'
                      ? 'STREAM_ABORTED'
                      : 'UNEXPECTED_FINISH_REASON',
                message: 'Provider ended the request unexpectedly.',
                ...(/^[a-z_]{1,40}$/.test(reason) ? { finishReason: reason } : {}),
              },
            }
          : streamError();
        return;
      }
      for (const call of calls.values()) yield checkedCall(request, { type: 'tool_call', ...call }, true);
      yield { type: 'done', reason: calls.size ? 'tool_calls' : 'stop' };
    } catch (error) {
      yield signal.aborted
        ? { type: 'done', reason: 'cancelled' }
        : {
            type: 'error',
            error: providerError(
              error,
              key ? [key] : typeof this.options.apiKey === 'string' ? [this.options.apiKey] : [],
              transport.retry,
            ),
          };
    }
  }
}
