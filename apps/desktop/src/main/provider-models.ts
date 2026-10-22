import { randomUUID } from 'node:crypto';
import type { AiProvider, AiSettings } from '../shared/ai-api';
import { matchProviderPreset, recommendModels } from '@brickloop/ai';

export function migrateAiSetup(settings: AiSettings): AiSettings {
  return {
    ...settings,
    providers: settings.providers.map((p) => ({
      ...p,
      mode: p.mode ?? (p.type === 'chatgpt' ? 'account' : 'apiKey'),
      presetId: p.presetId ?? matchProviderPreset(p.type, p.endpoint),
      connectionStatus: p.connectionStatus ?? 'untested',
    })),
  };
}
export function fillFirstProviderDefaults(settings: AiSettings, provider: AiProvider) {
  if (settings.providers.length !== 1 || settings.providers[0]?.id !== provider.id) return;
  if (!settings.defaultProviderId) settings.defaultProviderId = provider.id;
  const recommended = recommendModels(
    provider.presetId,
    [...new Set([provider.model, ...provider.models])].filter(Boolean).map((id) => ({ id })),
  );
  for (const purpose of ['chat', 'vision', 'quick'] as const) {
    const model = recommended[purpose];
    if (!settings.defaults[purpose] && model) settings.defaults[purpose] = `${provider.id}/${model}`;
  }
}

export function ensureChatGptProvider(settings: AiSettings, accountId: string): AiProvider {
  let provider = settings.providers.find((p) => p.type === 'chatgpt' && p.accountId === accountId);
  if (!provider) {
    provider = {
      id: randomUUID(),
      name: 'ChatGPT',
      type: 'chatgpt',
      mode: 'account',
      presetId: 'chatgpt',
      connectionStatus: 'untested',
      accountId,
      endpoint: 'https://api.openai.com/v1',
      model: '',
      models: [],
      proxy: 'system',
      proxyUrl: '',
    };
    settings.providers.push(provider);
  }
  if (!settings.defaultProviderId) settings.defaultProviderId = provider.id;
  return provider;
}

export function updateProviderModels(provider: AiProvider, models: readonly string[]): AiProvider {
  const { modelsError: _error, ...next } = provider;
  void _error;
  return {
    ...next,
    models: [...new Set(models)],
    model:
      provider.model ||
      recommendModels(
        provider.presetId ?? (provider.type === 'chatgpt' ? 'chatgpt' : undefined),
        models.map((id) => ({ id })),
      ).chat,
    ...(!models.length ? { modelsError: 'aiUi.noModels' as const } : {}),
  };
}
