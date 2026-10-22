import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { safeStorage } from 'electron';
import { createAiService } from '../src/main/ai-service';
import { createSecretStore } from '../src/main/secret-store';
import { defaultAiSettings, providerConnectionStatus, providerSchema } from '../src/shared/ai-api';
import type { AiNotice, ImageTaskRequest } from '../src/shared/ai-api';
import type { Settings } from '../src/shared/api';

const encryption = vi.hoisted(() => ({ available: true, unreadable: false }));
const network = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('No network expected');
  }),
);
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    encryptString: (text: string) => Buffer.from(Buffer.from(text).map((byte) => byte ^ 0xa7)),
    decryptString: (bytes: Buffer) => {
      if (encryption.unreadable) throw new Error('native secret detail');
      return Buffer.from(bytes.map((byte) => byte ^ 0xa7)).toString();
    },
  },
  session: { fromPartition: () => ({ setProxy: async () => undefined, fetch: network }) },
  shell: { openExternal: network },
}));

it.each(['unreadable', 'unavailable'] as const)(
  'snapshots and read operations preserve stored credentials and settings when %s',
  async (failure) => {
    encryption.available = true;
    encryption.unreadable = false;
    network.mockClear();
    const directory = await mkdtemp(path.join(tmpdir(), 'brickloop-ai-credentials-'));
    const provider = providerSchema.parse({
      id: randomUUID(),
      name: 'Test',
      type: 'compatible',
      mode: 'apiKey',
      presetId: 'deepseek',
      endpoint: 'http://127.0.0.1:1/v1',
      model: 'deepseek-chat',
      models: ['deepseek-chat'],
      connectionStatus: 'available',
    });
    const account = {
      id: randomUUID(),
      issuer: 'http://127.0.0.1:1',
      subject: 'fake',
      clientId: 'fake',
      label: 'fake',
      signedIn: true,
      planEnabled: true,
    };
    const chatgpt = providerSchema.parse({
      ...provider,
      id: randomUUID(),
      name: 'ChatGPT',
      type: 'chatgpt',
      mode: 'account',
      presetId: 'chatgpt',
      accountId: account.id,
    });
    let settings: Settings = {
      language: 'zh-CN',
      ai: { ...defaultAiSettings(), providers: [provider, chatgpt], history: false },
    };
    const update = vi.fn(async (patch: Partial<Settings>) => (settings = { ...settings, ...patch }));
    const notices: AiNotice[] = [];
    const store = createSecretStore(path.join(directory, 'ai/secrets'), safeStorage);
    const key = `sk-test-${randomUUID()}`;
    await store.set(`ai:key:${provider.id}`, key);
    await store.set(
      'ai:chatgpt:state',
      JSON.stringify({ hostId: 'test-host', accounts: [account], activeId: account.id }),
    );
    const bytes = async () =>
      Promise.all(
        (await readdir(path.join(directory, 'ai/secrets')))
          .sort()
          .map((file) => readFile(path.join(directory, 'ai/secrets', file))),
      );
    const original = await bytes();
    const service = await createAiService({
      directory,
      shim: '',
      settings: () => settings,
      update,
      emit: (notice) => notices.push(notice),
      call: async (method) => (method === 'task.create' ? { documentId: 'test-document' } : undefined),
    });
    try {
      if (failure === 'unreadable') encryption.unreadable = true;
      else encryption.available = false;
      await service.start();
      const snapshot = await service.api.aiSnapshot();
      expect(snapshot.masks).toEqual({});
      expect(snapshot.unreadableKeys).toEqual([provider.id]);
      expect(snapshot.accounts).toEqual([]);
      expect(providerConnectionStatus(provider, snapshot)).toBe('reenter');
      expect(providerConnectionStatus(chatgpt, snapshot)).toBe('reauth');
      expect(snapshot.settings.providers[0]?.connectionStatus).toBe('available');
      for (const p of [provider, chatgpt]) {
        const message = p === provider ? 'aiSetup.keyUnreadable' : 'aiSetup.accountUnreadable';
        expect(await service.api.aiTestProvider(p.id)).toMatchObject({ error: message });
        await service.api.aiRefreshModels(p.id);
        const chatId = await service.api.aiStart({
          providerId: p.id,
          model: p.model,
          text: 'fake test',
          effort: 'fast',
          images: [],
          selection: false,
          modelContext: false,
        });
        await vi.waitFor(() => expect(notices).toContainEqual({ type: 'failure', key: message, taskId: chatId }));
        const image: ImageTaskRequest = {
          providerId: p.id,
          model: p.model,
          directStart: true,
          input: {
            description: 'fake test',
            images: [],
            targetSize: 'small',
            palette: { source: 'factory' },
            parts: { source: 'factory' },
            style: '',
          },
          budget: { toolCalls: 10, durationMs: 1000 },
        };
        const imageId = await service.api.aiStartImage(image);
        await vi.waitFor(() => expect(notices).toContainEqual({ type: 'failure', key: message, taskId: imageId }));
      }
      await expect(service.api.aiSaveProvider(provider)).rejects.toThrow('aiSetup.keyUnreadable');
      expect(update).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      expect(await bytes()).toEqual(original);
      expect(JSON.stringify(notices)).not.toContain(key);
      expect(JSON.stringify(notices)).not.toContain('native secret detail');
      encryption.available = true;
      encryption.unreadable = false;
      const restored = await service.api.aiSnapshot();
      expect(restored.unreadableKeys).toEqual([]);
      expect(restored.masks[provider.id]).toBe(`****${key.slice(-4)}`);
      expect(restored.accounts).toEqual([account]);
      expect(providerConnectionStatus(provider, restored)).toBe('available');
      expect(update).not.toHaveBeenCalled();
      expect(await bytes()).toEqual(original);
      // Round-tripping a degraded snapshot for an unrelated preference cannot persist reenter.
      await service.api.aiSaveSettings({ ...snapshot.settings, history: true });
      expect(settings.ai?.providers[0]?.connectionStatus).toBe('available');
    } finally {
      await service.close();
      encryption.available = true;
      encryption.unreadable = false;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(
  [
    { kind: 'chat', operation: 'connection' },
    { kind: 'chat', operation: 'edit' },
    { kind: 'image', operation: 'connection' },
    { kind: 'image', operation: 'edit' },
  ].flatMap((scenario) => ['failed', 'merged', 'pending_merge'].map((outcome) => ({ ...scenario, outcome }))),
)(
  '$kind failure finalized as $outcome is published after cleanup, allowing an immediate $operation',
  async ({ kind, operation, outcome }) => {
    encryption.available = true;
    encryption.unreadable = false;
    network.mockClear();
    const directory = await mkdtemp(path.join(tmpdir(), 'brickloop-ai-credentials-'));
    const provider = providerSchema.parse({
      id: randomUUID(),
      name: 'Test',
      type: 'compatible',
      presetId: 'deepseek',
      endpoint: 'http://127.0.0.1:1/v1',
      model: 'deepseek-chat',
    });
    const settings: Settings = {
      language: 'zh-CN',
      ai: { ...defaultAiSettings(), providers: [provider], history: true },
    };
    const store = createSecretStore(path.join(directory, 'ai/secrets'), safeStorage);
    await store.set(`ai:key:${provider.id}`, 'sk-test-fake');
    const notices: AiNotice[] = [];
    const stages = ['history.append', 'release', 'task.finish', ...(outcome === 'failed' ? ['task.failed'] : [])];
    const calls: { method: string; input: unknown }[] = [];
    const gates = stages.map((method) => ({ method, entered: deferred(), finished: deferred() }));
    const notified = deferred();
    let immediateAction: Promise<unknown> | undefined;
    const service = await createAiService({
      directory,
      shim: '',
      settings: () => settings,
      update: async () => settings,
      emit: (notice) => {
        notices.push(notice);
        if (notice.type !== 'failure') return;
        // Invoke from the notification itself, without polling or an extra scheduling delay.
        immediateAction = (
          operation === 'connection' ? service.api.aiTestProvider(provider.id) : service.api.aiSaveProvider(provider)
        ).catch((error: unknown) => error);
        notified.resolve();
      },
      call: async (method, input) => {
        calls.push({ method, input });
        if (method === 'task.create') return { documentId: 'test-document' };
        const gate = gates.find((gate) => gate.method === method);
        if (gate) {
          gate.entered.resolve();
          await gate.finished.promise;
        }
        if (method === 'task.finish') return outcome;
      },
    });
    try {
      encryption.unreadable = true;
      const taskId =
        kind === 'chat'
          ? await service.api.aiStart({
              providerId: provider.id,
              model: provider.model,
              text: 'fake test',
              effort: 'fast',
              images: [],
              selection: false,
              modelContext: false,
            })
          : await service.api.aiStartImage({
              providerId: provider.id,
              model: provider.model,
              directStart: true,
              input: {
                description: 'fake test',
                images: [],
                targetSize: 'small',
                palette: { source: 'factory' },
                parts: { source: 'factory' },
                style: '',
              },
              budget: { toolCalls: 10, durationMs: 1000 },
            });
      for (const gate of gates) {
        await gate.entered.promise;
        expect(notices.filter((notice) => notice.type === 'failure')).toEqual([]);
        expect((await service.api.aiSnapshot()).tasks.find((task) => task.taskId === taskId)?.status).toBe('running');
        await expect(service.api.aiTestProvider(provider.id)).rejects.toThrow('AI_BUSY');
        gate.finished.resolve();
      }
      await notified.promise;
      expect(notices.filter((notice) => notice.type === 'failure')).toEqual([
        { type: 'failure', key: 'aiSetup.keyUnreadable', taskId },
      ]);
      expect(calls).toContainEqual({ method: 'task.finish', input: { stopped: true, failed: true } });
      expect(calls.some((call) => call.method === 'task.failed')).toBe(outcome === 'failed');
      const failureIndex = notices.findIndex((notice) => notice.type === 'failure');
      expect(notices.slice(0, failureIndex)).toContainEqual({
        type: 'task',
        task: expect.objectContaining({ taskId, status: outcome }),
      });
      if (operation === 'connection') expect(await immediateAction).toMatchObject({ error: 'aiSetup.keyUnreadable' });
      else expect(await immediateAction).toEqual(new Error('aiSetup.keyUnreadable'));
      expect(network).not.toHaveBeenCalled();
    } finally {
      for (const gate of gates) gate.finished.resolve();
      await service.close();
      await immediateAction;
      encryption.available = true;
      encryption.unreadable = false;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
