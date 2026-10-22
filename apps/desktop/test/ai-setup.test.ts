import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connectionIssue, maskConnectionDetails, minimalConnectionRequest } from '../src/main/ai-connection';
import { fillFirstProviderDefaults, migrateAiSetup } from '../src/main/provider-models';
import { defaultAiSettings, providerSchema, validAiArguments } from '../src/shared/ai-api';
import type { ChatRequest, ModelProvider } from '@brickloop/ai';

describe('AI setup migration and first service', () => {
  it('only adds setup metadata; preserves credentials references, accounts and all defaults, idempotently', () => {
    const old = defaultAiSettings();
    old.providers = [
      providerSchema.parse({
        id: randomUUID(),
        name: '我的 DeepSeek',
        type: 'compatible',
        endpoint: 'https://api.deepseek.com/v1',
        model: 'custom-model',
      }),
      providerSchema.parse({
        id: randomUUID(),
        name: 'OpenAI',
        type: 'openai',
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-6-sol',
      }),
      providerSchema.parse({
        id: randomUUID(),
        name: '个人账号',
        type: 'chatgpt',
        accountId: 'retained-account',
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-6-astra',
      }),
    ];
    old.defaultProviderId = old.providers[1]!.id;
    old.defaults.chat = `${old.providers[1]!.id}/gpt-6-sol`;
    const before = structuredClone(old),
      migrated = migrateAiSetup(old);
    expect(old).toEqual(before);
    expect(migrated.providers.map((p) => [p.mode, p.presetId])).toEqual([
      ['apiKey', 'deepseek'],
      ['apiKey', 'openai'],
      ['account', 'chatgpt'],
    ]);
    for (let i = 0; i < before.providers.length; i++) expect(migrated.providers[i]).toMatchObject(before.providers[i]!);
    expect(migrated.defaults).toEqual(before.defaults);
    expect(migrated.defaultProviderId).toBe(before.defaultProviderId);
    expect(migrateAiSetup(migrated)).toEqual(migrated);
  });
  it('fills three purposes for the first tested service and preserves subsequent choices', () => {
    const settings = defaultAiSettings();
    const p = providerSchema.parse({
      id: randomUUID(),
      type: 'openai',
      presetId: 'openai',
      name: 'OpenAI',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-6-astra',
      models: ['gpt-6-astra', 'gpt-6-luna'],
    });
    settings.providers.push(p);
    fillFirstProviderDefaults(settings, p);
    expect(settings.defaultProviderId).toBe(p.id);
    expect(settings.defaults).toEqual({
      chat: `${p.id}/gpt-6-astra`,
      vision: `${p.id}/gpt-6-luna`,
      quick: `${p.id}/gpt-6-luna`,
    });
    settings.defaults.vision = 'keep/vision';
    fillFirstProviderDefaults(settings, p);
    expect(settings.defaults.vision).toBe('keep/vision');
    settings.providers.push({ ...p, id: randomUUID() });
    const before = structuredClone(settings);
    fillFirstProviderDefaults(settings, settings.providers[1]!);
    expect(settings).toEqual(before);
    expect(validAiArguments('ai.testDraft', [p, 'offline-key'])).toBe(true);
    expect(validAiArguments('ai.presetLink', ['deepseek', 'key'])).toBe(true);
    expect(validAiArguments('ai.presetLink', ['deepseek', 'javascript:alert(1)'])).toBe(false);
  });
});
describe('connection errors and secret masking', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [402, 'balance'],
    [404, 'address'],
    [429, 'quota'],
    [503, 'unknown'],
  ] as const)('classifies HTTP %s', (status, issue) => expect(connectionIssue({ status })).toBe(issue));
  it.each(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'net::ERR_NAME_NOT_RESOLVED', 'TimeoutError'])(
    'classifies %s as a network failure',
    (message) => expect(connectionIssue({ message })).toBe('network'),
  );
  it('recognizes provider debt and capability failures', () => {
    expect(connectionIssue({ status: 400, code: 'insufficient_balance' })).toBe('balance');
    expect(connectionIssue({ status: 400, code: '1113' })).toBe('balance');
    expect(connectionIssue({ status: 403, message: 'CodeInsufficientBalance 403004' })).toBe('balance');
    expect(connectionIssue({ message: 'model does not support tools' })).toBe('capability');
  });
  it('masks raw, percent-encoded and JSON-escaped credentials, including short arbitrary keys', () => {
    const secret = 'private/"key+abc';
    const masked = maskConnectionDetails(
      `${secret} ${encodeURIComponent(secret)} ${JSON.stringify(secret)} Bearer hidden-access-token`,
      [secret],
    );
    expect(masked).not.toContain(secret);
    expect(masked).not.toContain(encodeURIComponent(secret));
    expect(masked).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(masked).not.toContain('hidden-access-token');
    expect(maskConnectionDetails('oops ab failed', ['ab'])).not.toContain('ab');
  });
  it('caps minimal requests at 16, requires completion and accounts for usage even on failure', async () => {
    const requests: ChatRequest[] = [],
      usage: number[] = [];
    const provider: ModelProvider = {
      id: 'offline',
      endpoint: 'http://127.0.0.1',
      billing: 'api',
      listModels: async () => [],
      capabilities: () => ({ vision: true, tools: true, reasoning: false, maxContext: 1000, contextWindow: 1000 }),
      async *stream(req) {
        requests.push(req);
        yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 1, cacheReadInputTokens: 0 } };
        yield { type: 'done', reason: 'stop' };
      },
    };
    await minimalConnectionRequest(provider, 'model', new AbortController().signal, async (v) => {
      usage.push(v.outputTokens);
    });
    expect(requests[0]).toMatchObject({ maxOutputTokens: 16, tools: [], model: 'model' });
    expect(usage).toEqual([1]);
    provider.stream = async function* () {
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 0 } };
      yield { type: 'error', error: { category: 'network', message: 'Interrupted' } };
    };
    await expect(
      minimalConnectionRequest(provider, 'model', new AbortController().signal, async (v) => {
        usage.push(v.outputTokens);
      }),
    ).rejects.toThrow();
    expect(usage).toEqual([1, 2]);
  });
});
