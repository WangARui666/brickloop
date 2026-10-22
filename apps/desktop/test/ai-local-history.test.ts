import { beforeEach, expect, it, vi } from 'vitest';
import { createDocument, DocumentSession } from '@brickloop/core';
import { readTurns, saveLocalTurn } from '../src/renderer/src/ai-integration';
import { useAiStore } from '../src/renderer/src/ai-store';
import { contextHistory, emptyContextMarks } from '../src/renderer/src/ai-context';
import { defaultAiSettings } from '../src/shared/ai-api';
import type { AiSnapshot } from '../src/shared/ai-api';

vi.mock('../src/renderer/src/document-store', () => ({
  refresh: vi.fn(),
  documentLocked: () => false,
  activeTab: vi.fn(),
  setDocumentLock: vi.fn(),
}));
vi.mock('../src/renderer/src/ai-check', () => ({ checkAiDocument: vi.fn() }));
vi.mock('../src/renderer/src/mesh-client', () => ({}));
vi.mock('../src/renderer/src/library-store', () => ({}));
vi.mock('../src/renderer/src/assembly-store', () => ({}));
vi.mock('../src/renderer/src/buildscript-client', () => ({ runBuildScriptWorker: vi.fn() }));
vi.mock('../src/renderer/src/ai-task-runtime', () => ({ configureTaskRuntime: vi.fn() }));
vi.mock('../src/renderer/src/task-preview', () => ({}));
vi.mock('../src/renderer/src/ask-store', () => ({}));

beforeEach(() => useAiStore.setState({ snapshot: null, turns: [] }));

function snapshot(history: boolean): AiSnapshot {
  return {
    settings: { ...defaultAiSettings(), history },
    tasks: [],
    masks: {},
    unreadableKeys: [],
    accounts: [],
    spent: 0,
    connections: 0,
    httpUrl: null,
    shim: '',
    running: false,
  };
}

it.each([true, undefined])(
  'persists local and legacy turns with history=%s and restores completed context',
  (history) => {
    useAiStore.setState({ snapshot: history === undefined ? null : snapshot(history) });
    const legacy = { id: 'legacy', user: 'old', text: 'answer', images: [], events: [] };
    const tab = {
      session: new DocumentSession(createDocument()),
      assets: { 'ai/history.jsonl': new TextEncoder().encode(JSON.stringify(legacy) + '\n') },
      assetsDirty: false,
      readOnly: false,
      path: null,
      lastRecovery: null,
      pending: Promise.resolve(),
      started: false,
    };
    const local = { shortcut: 'repair' as const, paths: null, selection: false, modelContext: true };
    const turn = saveLocalTurn('check', 'all zero', local, tab);
    expect(tab.assetsDirty).toBe(true);
    expect(useAiStore.getState().turns).toContainEqual(turn);
    const reopened = { ...tab, assets: structuredClone(tab.assets) };
    const restored = readTurns(reopened);
    expect(restored[0]).toMatchObject(legacy);
    expect(restored[0]?.local).toBeUndefined();
    expect(restored[1]).toEqual(turn);
    expect(contextHistory([restored[1]!], emptyContextMarks())).toEqual(turn.history);
    // Optional metadata does not change the legacy turn fields or completed history.
    const { local: ignored, ...oldReader } = restored[1]!;
    void ignored;
    expect(contextHistory([oldReader], emptyContextMarks())).toEqual(turn.history);
  },
);

it.each([false, true])(
  'keeps local turns only in memory when history is off, preserving assetsDirty=%s',
  (assetsDirty) => {
    useAiStore.setState({ snapshot: snapshot(false) });
    const history = new TextEncoder().encode('{"id":"existing"}\n');
    const assets = { 'ai/history.jsonl': history };
    const tab = {
      session: new DocumentSession(createDocument()),
      assets,
      assetsDirty,
      readOnly: false,
      path: null,
      lastRecovery: null,
      pending: Promise.resolve(),
      started: false,
    };
    const turn = saveLocalTurn(
      'check',
      'all zero',
      {
        shortcut: 'factory',
        paths: null,
        selection: false,
        modelContext: true,
      },
      tab,
    );
    expect(tab.assets).toBe(assets);
    expect(tab.assets['ai/history.jsonl']).toBe(history);
    expect(new TextDecoder().decode(history)).toBe('{"id":"existing"}\n');
    expect(tab.assetsDirty).toBe(assetsDirty);
    expect(useAiStore.getState().turns).toEqual([turn]);
    expect(contextHistory([turn], emptyContextMarks())).toEqual(turn.history);
  },
);
