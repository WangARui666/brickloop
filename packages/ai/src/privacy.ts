import type { ChatEvent, ChatRequest, ModelProvider, StreamOptions } from './types.js';
import { redact } from './secrets.js';

export function isLoopbackEndpoint(endpoint: string): boolean {
  const url = new URL(endpoint);
  return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname);
}
/** Apply to each SDK's fetch option; redirects cannot escape the selected destination. */
export function createPrivacyFetch(options: { localOnly: boolean; fetch?: typeof fetch }): typeof fetch {
  const transport = options.fetch ?? fetch;
  return (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (options.localOnly && !isLoopbackEndpoint(url)) return Promise.reject(new Error('LOCAL_ONLY_POLICY'));
    return transport(input, { ...init, redirect: 'error' });
  };
}
export interface PrivacyPolicy {
  localOnly: boolean;
  /** Host presents destination and returns explicit consent; called once per wrapped destination. */
  confirmImages(destination: { provider: string; endpoint: string }): Promise<boolean>;
}
export function withPrivacyPolicy(provider: ModelProvider, policy: PrivacyPolicy): ModelProvider {
  let imageConsent = false;
  const allowed = () => !policy.localOnly || isLoopbackEndpoint(provider.endpoint);
  return {
    id: provider.id,
    billing: provider.billing,
    endpoint: provider.endpoint,
    capabilities: (model) => provider.capabilities(model),
    listModels: () => (allowed() ? provider.listModels() : Promise.reject(new Error('LOCAL_ONLY_POLICY'))),
    async *stream(request: ChatRequest, signal: AbortSignal, options?: StreamOptions): AsyncIterable<ChatEvent> {
      if (!allowed()) {
        yield {
          type: 'error',
          error: {
            category: 'invalid_request',
            code: 'LOCAL_ONLY_POLICY',
            message: '仅本地模型模式禁止向云端服务发送数据。',
          },
        };
        return;
      }
      const images = request.messages.some((m) =>
        m.content.some(
          (b) => b.type === 'image' || (b.type === 'tool_result' && b.content.some((c) => c.type === 'image')),
        ),
      );
      if (images && !imageConsent && !isLoopbackEndpoint(provider.endpoint)) {
        imageConsent = await policy.confirmImages({ provider: provider.id, endpoint: provider.endpoint });
        if (!imageConsent) {
          yield {
            type: 'error',
            error: {
              category: 'invalid_request',
              code: 'IMAGE_CONSENT_REQUIRED',
              message: '尚未允许向当前服务商发送图片。',
            },
          };
          return;
        }
      }
      if (signal.aborted) {
        yield { type: 'done', reason: 'cancelled' };
        return;
      }
      yield* provider.stream(request, signal, options);
    },
  };
}
export interface LocalLogStore {
  append(entry: { timestamp: number; provider: string; event: string; message: string }): Promise<void>;
  deleteBefore(timestamp: number): Promise<void>;
}
/** No request bodies, tool arguments, image data, signed state or raw SDK errors are logged. */
export async function writeDebugEvent(
  store: LocalLogStore,
  provider: string,
  event: ChatEvent,
  options: { secrets?: readonly string[]; now?: number; retentionDays?: number } = {},
): Promise<void> {
  if (event.type === 'activity') return;
  const now = options.now ?? Date.now();
  const message =
    event.type === 'error'
      ? `${event.error.category}: ${event.error.code ?? ''} ${event.error.message}`
      : event.type === 'usage'
        ? JSON.stringify(event.usage)
        : event.type;
  await store.deleteBefore(now - (options.retentionDays ?? 7) * 86_400_000);
  await store.append({
    timestamp: now,
    provider: redact(provider, options.secrets),
    event: event.type,
    message: redact(message, options.secrets),
  });
}
