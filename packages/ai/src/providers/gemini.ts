import { GoogleGenAI, type Content, type Part, type GenerateContentResponseUsageMetadata } from '@google/genai';
import type { ChatEvent, ChatRequest, ModelInfo, ModelProvider, ToolCallBlock, StreamOptions } from '../types.js';
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

export class GeminiProvider implements ModelProvider {
  readonly id = 'gemini';
  readonly billing = 'api';
  readonly endpoint: string;
  private catalog = new Map<string, ModelInfo>();
  constructor(private readonly options: ProviderOptions) {
    this.endpoint = options.baseURL ?? 'https://generativelanguage.googleapis.com';
  }
  private async client(apiKey?: string, transport = this.options.fetch) {
    return new GoogleGenAI({
      apiKey: apiKey ?? (typeof this.options.apiKey === 'string' ? this.options.apiKey : await this.options.apiKey()),
      httpOptions: {
        baseUrl: this.endpoint,
        // One attempt is Gemini's maxRetries: 0 equivalent; the turn owns retries and tool history.
        retryOptions: { attempts: 1 },
        ...(transport ? { fetch: transport } : {}),
      },
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
        for await (const m of await client.models.list()) {
          if (m.name)
            result.push({
              id: m.name,
              name: m.displayName ?? m.name,
              capabilities: {
                ...defaultCapabilities,
                maxContext: m.inputTokenLimit ?? 0,
                contextWindow: m.inputTokenLimit ?? null,
                ...(m.outputTokenLimit ? { maxOutputTokens: m.outputTokenLimit } : {}),
              },
              ...(m.outputTokenLimit ? { maxOutputTokens: m.outputTokenLimit } : {}),
            });
        }
        this.catalog = new Map(result.map((m) => [m.id, m]));
        return result;
      },
      () => (key ? [key] : []),
    );
  }
  private contents(request: ChatRequest): Content[] {
    const replayedIds = new Set<string>();
    for (const message of request.messages) {
      if (message.providerState?.provider === this.id) {
        for (const part of message.providerState.value as Part[]) {
          if (part.functionCall?.id) replayedIds.add(part.functionCall.id);
        }
      } else {
        for (const block of message.content) if (block.type === 'tool_call') replayedIds.add(block.id);
      }
    }
    return request.messages.map((message): Content => {
      if (message.providerState?.provider === this.id)
        return { role: 'model', parts: message.providerState.value as Part[] };
      const parts: Part[] = [];
      for (const block of message.content) {
        if (block.type === 'text') parts.push({ text: block.text });
        if (block.type === 'image') parts.push({ inlineData: { mimeType: block.mime, data: block.base64 } });
        if (block.type === 'tool_call')
          parts.push({
            functionCall: { id: block.id, name: block.name, args: block.arguments as Record<string, unknown> },
          });
        if (block.type === 'tool_result') {
          parts.push({
            functionResponse: {
              ...(replayedIds.has(block.id) ? { id: block.id } : {}),
              name: block.name,
              response: {
                [block.isError ? 'error' : 'result']: block.content
                  .filter((c) => c.type === 'text')
                  .map((c) => c.text)
                  .join('\n'),
              },
            },
          });
          for (const c of block.content)
            if (c.type === 'image') parts.push({ inlineData: { mimeType: c.mime, data: c.base64 } });
        }
      }
      return { role: message.role === 'assistant' ? 'model' : 'user', parts };
    });
  }
  async *stream(request: ChatRequest, signal: AbortSignal, options?: StreamOptions): AsyncIterable<ChatEvent> {
    let key: string | undefined;
    const transport = createStreamTransport(this.options.fetch, options);
    try {
      signal.throwIfAborted();
      key = typeof this.options.apiKey === 'string' ? this.options.apiKey : await this.options.apiKey();
      const client = await this.client(key, transport.fetch);
      const stream = await client.models.generateContentStream({
        model: request.model,
        contents: this.contents(request),
        config: {
          systemInstruction: request.system,
          abortSignal: signal,
          ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
          tools: [
            {
              functionDeclarations: sortedTools(request).map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.parameters,
              })),
            },
          ],
        },
      });
      let finish: string | undefined;
      let blocked = false;
      let usage: GenerateContentResponseUsageMetadata | undefined;
      const calls: ToolCallBlock[] = [];
      const parts: Part[] = [];
      const activity = { type: 'activity' as const, reasoningChars: 0, contentChars: 0, toolChars: 0 };
      for await (const chunk of stream) {
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        if (chunk.promptFeedback?.blockReason) blocked = true;
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) finish = candidate.finishReason;
        for (const part of candidate?.content?.parts ?? []) {
          parts.push(part);
          if (part.text) activity[part.thought ? 'reasoningChars' : 'contentChars'] += part.text.length;
          if (part.functionCall) activity.toolChars += JSON.stringify(part.functionCall.args ?? {}).length;
          if (part.text && !part.thought) yield { type: 'text_delta', text: part.text };
          if (part.functionCall)
            calls.push({
              type: 'tool_call',
              id: part.functionCall.id ?? `gemini-${calls.length}`,
              name: part.functionCall.name ?? '',
              arguments: part.functionCall.args ?? {},
            });
        }
        yield { ...activity };
      }
      if (usage)
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.promptTokenCount ?? 0,
            outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
            cacheReadInputTokens: usage.cachedContentTokenCount ?? 0,
          },
        };
      if (blocked || (finish && !['STOP', 'MAX_TOKENS', 'MALFORMED_FUNCTION_CALL'].includes(finish))) {
        yield {
          type: 'error',
          error: { category: 'refusal', message: 'The model refused the request.', code: finish ?? 'PROMPT_BLOCKED' },
        };
        return;
      }
      if (finish === 'MAX_TOKENS') {
        yield { type: 'done', reason: 'max_tokens' };
        return;
      }
      if (finish !== 'STOP') {
        yield streamError();
        return;
      }
      yield { type: 'provider_state', state: { provider: this.id, value: parts } };
      for (const call of calls) yield checkedCall(request, call);
      yield { type: 'done', reason: calls.length ? 'tool_calls' : 'stop' };
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
