import { describe, expect, it } from 'vitest';
import { ensureChatGptProvider, updateProviderModels } from '../src/main/provider-models';
import { defaultAiSettings } from '../src/shared/ai-api';
import { toolErrorKey } from '../src/renderer/src/ai-tool-error';
import { createI18n } from '@brickloop/i18n';

describe('ChatGPT provider setup', () => {
  it('creates one bound provider per account, preserving an existing default and edited configuration', () => {
    const settings = defaultAiSettings();
    const first = ensureChatGptProvider(settings, 'one');
    expect(first).toMatchObject({ name: 'ChatGPT', type: 'chatgpt', accountId: 'one', models: [] });
    expect(settings.defaultProviderId).toBe(first.id);
    first.name = '工作账号';
    first.model = 'custom';
    expect(ensureChatGptProvider(settings, 'one')).toBe(first);
    ensureChatGptProvider(settings, 'two');
    expect(settings.providers).toHaveLength(2);
    expect(settings.defaultProviderId).toBe(first.id);
    expect(first.model).toBe('custom');
  });
  it('prefers Astra, falls back to the first model, handles empty lists and preserves custom choices on refresh', () => {
    const provider = ensureChatGptProvider(defaultAiSettings(), 'one');
    expect(updateProviderModels(provider, ['gpt-6-sol', 'gpt-6-astra']).model).toBe('gpt-6-astra');
    expect(updateProviderModels(provider, ['first', 'second']).model).toBe('first');
    expect(updateProviderModels(provider, [])).toMatchObject({ model: '', modelsError: 'aiUi.noModels' });
    expect(
      updateProviderModels({ ...provider, model: 'mine', modelsError: 'aiUi.modelsFailed' }, ['first']),
    ).toMatchObject({ model: 'mine', models: ['first'] });
    expect(
      updateProviderModels({ ...provider, modelsError: 'aiUi.modelsFailed' }, ['first']).modelsError,
    ).toBeUndefined();
  });
  it('explains comparison failures in both languages without exposing internal codes', () => {
    for (const language of ['zh-CN', 'en'] as const) {
      const t = createI18n({ language }).t;
      for (const code of [
        'REFERENCE_EMPTY',
        'EMPTY_FOREGROUND',
        'REFERENCE_NOT_FOUND',
        'VIEW_MISMATCH',
        'INVALID_ARGUMENTS',
        'HOST_ERROR',
      ]) {
        expect(t(toolErrorKey(code))).not.toContain(code);
        expect(t(toolErrorKey(code))).not.toContain('aiToolErrors.');
      }
    }
  });
});
