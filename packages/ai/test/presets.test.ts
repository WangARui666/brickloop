import { describe, expect, it } from 'vitest';
import {
  compatiblePresets,
  matchProviderPreset,
  presetCapabilities,
  providerPresets,
  recommendModels,
} from '../src/providers/presets';

describe('AI setup preset catalog', () => {
  it('contains the ordered catalog, bilingual copy, HTTPS documentation and compilable rules', () => {
    expect(providerPresets.map((p) => p.id)).toEqual([
      'deepseek',
      'qwen',
      'doubao',
      'kimi',
      'zhipu',
      'siliconflow',
      'minimax',
      'hunyuan',
      'qianfan',
      'openai',
      'anthropic',
      'gemini',
      'openrouter',
      'ollama',
      'lmstudio',
      'vllm',
      'custom',
    ]);
    for (const p of providerPresets) {
      expect(p.verified.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.verified.sources.length).toBeGreaterThan(0);
      for (const url of [p.keyUrl, p.docsUrl, ...p.verified.sources].filter(Boolean))
        expect(new URL(url!).protocol).toBe('https:');
      for (const field of [p.name, p.description, p.keyHint])
        for (const value of Object.values(field)) expect(value.length).toBeGreaterThan(0);
      for (const rule of [...Object.values(p.recommendations).flat(), ...p.capabilities.map((r) => r.match)])
        expect(() => new RegExp(rule, 'i')).not.toThrow();
      if (p.requiresKey) expect(p.keyUrl).toBeTruthy();
    }
    expect(compatiblePresets.deepseek?.baseURL).toBe(providerPresets[0]!.endpoint);
    expect(
      providerPresets.filter((p) => ['ollama', 'lmstudio', 'vllm'].includes(p.id)).every((p) => !p.requiresKey),
    ).toBe(true);
    expect(providerPresets.find((p) => p.id === 'kimi')!.keyHint['zh-CN']).toContain('开放平台');
  });
  it('picks current models by purpose from the actual list, without inventing unavailable models', () => {
    const models = ['gpt-6-sol', 'gpt-6-astra', 'gpt-7-astra', 'gpt-6-luna'].map((id) => ({ id }));
    expect(recommendModels('chatgpt', models)).toMatchObject({ chat: 'gpt-7-astra', quick: 'gpt-6-luna' });
    expect(
      recommendModels(
        'qwen',
        ['qwen-plus', 'qwen-vl-plus', 'qwen-flash'].map((id) => ({ id })),
      ),
    ).toEqual({ chat: 'qwen-plus', vision: 'qwen-vl-plus', quick: 'qwen-flash' });
    expect(recommendModels('custom', [{ id: 'my-model' }])).toEqual({
      chat: 'my-model',
      vision: 'my-model',
      quick: 'my-model',
    });
    expect(recommendModels('custom', [])).toEqual({ chat: '', vision: '', quick: '' });
    expect(presetCapabilities('deepseek', 'deepseek-chat')).toMatchObject({ vision: false, tools: true, known: true });
    expect(presetCapabilities('custom', 'unknown')).toMatchObject({ known: false });
  });
  it('recommends DeepSeek Flash for every purpose, with legacy fallbacks', () => {
    const legacy = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-vision'];
    const models = [...legacy, 'deepseek-flash', 'deepseek-v4-pro'].map((id) => ({ id }));
    expect(recommendModels('deepseek', models)).toEqual({
      chat: 'deepseek-flash',
      vision: 'deepseek-flash',
      quick: 'deepseek-flash',
    });
    expect(
      recommendModels(
        'deepseek',
        models.filter((m) => m.id !== 'deepseek-v4-pro'),
      ),
    ).toEqual({
      chat: 'deepseek-flash',
      vision: 'deepseek-flash',
      quick: 'deepseek-flash',
    });
    expect(presetCapabilities('deepseek', 'deepseek-flash')).toMatchObject({
      vision: true,
      tools: true,
      known: true,
    });
    expect(presetCapabilities('deepseek', 'deepseek-v4-pro')).toMatchObject({ tools: true, known: true });
    expect(
      recommendModels(
        'deepseek',
        legacy.map((id) => ({ id })),
      ),
    ).toEqual({
      chat: 'deepseek-reasoner',
      vision: 'deepseek-vision',
      quick: 'deepseek-chat',
    });
    for (const id of ['deepseek-chat', 'deepseek-reasoner'])
      expect(presetCapabilities('deepseek', id)).toMatchObject({ vision: false, tools: true, known: true });
  });
  it('matches exact service URLs and legacy aliases without accepting lookalike hosts or changing paths', () => {
    expect(matchProviderPreset('compatible', 'https://api.deepseek.com/v1/')).toBe('deepseek');
    expect(matchProviderPreset('compatible', 'http://localhost:1234/v1')).toBe('lmstudio');
    expect(matchProviderPreset('compatible', 'https://api.moonshot.ai/v1')).toBe('kimi');
    expect(matchProviderPreset('openai', 'https://api.openai.com/v1')).toBe('openai');
    expect(matchProviderPreset('compatible', 'https://api.deepseek.com.attacker.test/v1')).toBe('custom');
    expect(matchProviderPreset('compatible', 'https://api.deepseek.com/else')).toBe('custom');
  });
});
it('keeps DeepSeek Pro available but does not recommend it even when it is the only model', () => {
  expect(presetCapabilities('deepseek', 'deepseek-v4-pro').tools).toBe(true);
  expect(recommendModels('deepseek', [{ id: 'deepseek-v4-pro' }])).toEqual({ chat: '', vision: '', quick: '' });
  const preset = providerPresets.find((p) => p.id === 'deepseek')!;
  for (const purpose of ['chat', 'vision', 'quick'] as const)
    expect(preset.recommendations[purpose][0]).toBe('^deepseek-flash$');
});
