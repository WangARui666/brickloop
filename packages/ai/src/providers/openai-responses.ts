import { isContextOverflow, sanitizeProviderMessage } from '../errors.js';
import OpenAI from 'openai';
import type {
  ResponseInput,
  Tool,
  ResponseOutputItem,
  ResponseCreateParamsStreaming,
} from 'openai/resources/responses/responses';
import { z } from 'zod';
import type { ChatEvent, ChatRequest, ModelInfo, ModelProvider, StreamOptions } from '../types.js';
import {
  checkedCall,
  createStreamTransport,
  dataUrl,
  defaultCapabilities,
  errorFromStatus,
  providerError,
  safeModelList,
  sortedTools,
  streamError,
  type ProviderOptions,
} from './common.js';

export interface OpenAIResponsesOptions extends ProviderOptions {
  mode?: 'api-key' | 'chatgpt';
  toolResultImages?: 'native' | 'user-message';
}
const catalog = z.object({
  models: z.array(z.object({ slug: z.string(), display_name: z.string(), visibility: z.string() })),
});
export class OpenAIResponsesProvider implements ModelProvider {
  readonly id: string;
  readonly billing: 'plan' | 'api';
  readonly endpoint: string;
  constructor(private readonly options: OpenAIResponsesOptions) {
    this.billing = options.mode === 'chatgpt' ? 'plan' : 'api';
    this.id = this.billing === 'plan' ? 'chatgpt-plan' : 'openai';
    this.endpoint = options.baseURL ?? 'https://api.openai.com/v1';
  }
  private async client(apiKey?: string, transport = this.options.fetch) {
    const key = apiKey ?? (typeof this.options.apiKey === 'string' ? this.options.apiKey : await this.options.apiKey());
    return new OpenAI({
      apiKey: key,
      baseURL: this.endpoint,
      // The turn retries failed requests so already executed tools are never repeated.
      maxRetries: 0,
      ...(transport ? { fetch: transport } : {}),
    });
  }
  capabilities(model: string) {
    return this.options.modelCapabilities?.[model] ?? defaultCapabilities;
  }
  async listModels(): Promise<ModelInfo[]> {
    let key: string | undefined;
    return safeModelList(
      async () => {
        key = typeof this.options.apiKey === 'string' ? this.options.apiKey : await this.options.apiKey();
        const client = await this.client(key);
        if (this.billing === 'plan') {
          const response: unknown = await client.get('/models', {});
          return catalog
            .parse(response)
            .models.filter((m) => m.visibility === 'list')
            .map((m) => ({ id: m.slug, name: m.display_name }));
        }
        const models: ModelInfo[] = [];
        for await (const m of client.models.list()) models.push({ id: m.id, name: m.id });
        return models;
      },
      () => (key ? [key] : []),
    );
  }
  private input(request: ChatRequest): ResponseInput {
    const input: ResponseInput = [];
    for (const message of request.messages) {
      if (message.providerState?.provider === this.id) {
        for (const item of message.providerState.value as ResponseOutputItem[]) {
          if (item.type === 'function_call' || item.type === 'message' || item.type === 'reasoning') input.push(item);
        }
        continue;
      }
      for (const block of message.content) {
        if (block.type === 'text')
          input.push({ role: message.role === 'tool' ? 'user' : message.role, content: block.text });
        if (block.type === 'image')
          input.push({ role: 'user', content: [{ type: 'input_image', image_url: dataUrl(block), detail: 'auto' }] });
        if (block.type === 'tool_call')
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
            ...(this.billing === 'plan'
              ? { namespace: request.tools.find((t) => t.name === block.name)?.namespace ?? 'editor' }
              : {}),
          });
        if (block.type === 'tool_result') {
          const images = block.content.filter((c) => c.type === 'image');
          input.push({
            type: 'function_call_output',
            call_id: block.id,
            output:
              this.options.toolResultImages === 'user-message'
                ? block.content
                    .filter((c) => c.type === 'text')
                    .map((c) => c.text)
                    .join('\n')
                : block.content.map((c) =>
                    c.type === 'text'
                      ? { type: 'input_text' as const, text: c.text }
                      : { type: 'input_image' as const, image_url: dataUrl(c), detail: 'auto' as const },
                  ),
          });
          if (images.length && this.options.toolResultImages === 'user-message')
            input.push({
              role: 'user',
              content: [
                { type: 'input_text', text: `Images from tool ${block.name} (${block.id}).` },
                ...images.map((c) => ({
                  type: 'input_image' as const,
                  image_url: dataUrl(c),
                  detail: 'auto' as const,
                })),
              ],
            });
        }
      }
    }
    return input;
  }
  async *stream(request: ChatRequest, signal: AbortSignal, options?: StreamOptions): AsyncIterable<ChatEvent> {
    let key: string | undefined;
    const transport = createStreamTransport(this.options.fetch, options);
    try {
      signal.throwIfAborted();
      const functions = sortedTools(request).map((t) => ({
        type: 'function' as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      }));
      const tools: Tool[] =
        this.billing === 'plan'
          ? [...new Set(sortedTools(request).map((t) => t.namespace))].map((namespace) => ({
              type: 'namespace',
              name: namespace,
              description: `${namespace} tools`,
              tools: functions.filter((f) => request.tools.find((t) => t.name === f.name)?.namespace === namespace),
            }))
          : functions;
      const body: ResponseCreateParamsStreaming = {
        model: request.model,
        instructions: request.system,
        input: this.input(request),
        tools,
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        ...(this.billing === 'api' && request.maxOutputTokens !== undefined
          ? { max_output_tokens: request.maxOutputTokens }
          : {}),
      };
      key = typeof this.options.apiKey === 'string' ? this.options.apiKey : await this.options.apiKey();
      const client = await this.client(key, transport.fetch);
      const stream = await client.responses.create(body, { signal });
      let completed = false;
      let refused = false;
      // The ChatGPT plan endpoint streams output items but completes with an empty `output` (store: false).
      const streamed: ResponseOutputItem[] = [];
      const activity = { type: 'activity' as const, reasoningChars: 0, contentChars: 0, toolChars: 0 };
      const reconcile = (output: ResponseOutputItem[]) => {
        let reasoning = 0,
          content = 0,
          argumentsChars = 0;
        for (const item of output) {
          if (item.type === 'function_call') argumentsChars += item.arguments.length;
          if (item.type === 'message')
            for (const part of item.content) if (part.type === 'output_text') content += part.text.length;
          if (item.type === 'reasoning') {
            for (const part of item.summary) reasoning += part.text.length;
            for (const part of item.content ?? []) reasoning += part.text.length;
          }
        }
        activity.reasoningChars = Math.max(activity.reasoningChars, reasoning);
        activity.contentChars = Math.max(activity.contentChars, content);
        activity.toolChars = Math.max(activity.toolChars, argumentsChars);
      };
      for await (const event of stream) {
        if (event.type === 'response.output_item.done') {
          streamed.push(event.item);
          reconcile(streamed);
        }
        if (event.type === 'response.output_text.delta') activity.contentChars += event.delta.length;
        if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta')
          activity.reasoningChars += event.delta.length;
        if (event.type === 'response.function_call_arguments.delta') activity.toolChars += event.delta.length;
        if (event.type === 'response.completed')
          reconcile(event.response.output?.length ? event.response.output : streamed);
        if (event.type === 'response.output_text.delta') yield { type: 'text_delta', text: event.delta };
        if (event.type === 'response.reasoning_summary_text.delta')
          yield { type: 'reasoning_summary', text: event.delta };
        if (event.type === 'response.refusal.delta') refused = true;
        yield { ...activity };
        if (event.type === 'response.failed' || event.type === 'error') {
          const error = event.type === 'response.failed' ? event.response.error : event;
          const overflow = isContextOverflow([error?.message, error?.code, JSON.stringify(error)].join('\n'));
          yield {
            type: 'error',
            error: {
              category: overflow ? 'invalid_request' : errorFromStatus(undefined, error?.code),
              code: overflow ? 'CONTEXT_OVERFLOW' : (error?.code ?? 'RESPONSE_FAILED'),
              message: 'The provider rejected the response.',
              ...(error?.message ? { providerMessage: sanitizeProviderMessage(error.message, key ? [key] : []) } : {}),
            },
          };
          return;
        }
        if (event.type === 'response.incomplete') {
          yield streamError('Response incomplete; tool calls were not executed.');
          return;
        }
        if (event.type === 'response.completed') {
          completed = true;
          const response = event.response;
          const output = response.output?.length ? response.output : streamed;
          if (response.usage)
            yield {
              type: 'usage',
              usage: {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                cacheReadInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
                cacheWriteInputTokens: response.usage.input_tokens_details?.cache_write_tokens ?? 0,
              },
            };
          if (refused || output.some((o) => o.type === 'message' && o.content.some((c) => c.type === 'refusal'))) {
            yield { type: 'error', error: { category: 'refusal', message: 'The model refused the request.' } };
            return;
          }
          yield { type: 'provider_state', state: { provider: this.id, value: output } };
          const calls = output.filter((o) => o.type === 'function_call');
          for (const call of calls)
            yield checkedCall(
              request,
              { type: 'tool_call', id: call.call_id, name: call.name, arguments: call.arguments },
              true,
            );
          yield { type: 'done', reason: calls.length ? 'tool_calls' : 'stop' };
          return;
        }
      }
      if (!completed) yield streamError();
    } catch (error) {
      if (signal.aborted) yield { type: 'done', reason: 'cancelled' };
      else
        yield {
          type: 'error',
          error: providerError(error, key ? [key] : [], transport.retry),
        };
    }
  }
}
