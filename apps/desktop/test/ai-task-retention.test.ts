import { beforeEach, expect, it, vi } from 'vitest';
import { createDocument, DocumentSession, expandInstances } from '@brickloop/core';
import type { EditorHostServices } from '../src/renderer/src/ai-editor-host';
import type { DocumentTab } from '../src/renderer/src/document-store';
import { activeTab, documentTabs, useDocumentStore } from '../src/renderer/src/document-store';
import {
  configureTaskRuntime,
  createTask,
  finishTask,
  mergeTask,
  receiveTask,
  taskCopies,
  useTaskStore,
} from '../src/renderer/src/ai-task-runtime';
import { reviewFor, useReviewStore } from '../src/renderer/src/review-store';

vi.mock('../src/renderer/src/document-store', async () => {
  const { create } = await import('zustand');
  return {
    activeTab: vi.fn(),
    documentTabs: new Map(),
    useDocumentStore: create(() => ({ activeId: '' })),
    documentLocked: () => false,
    documentMcpLocked: () => false,
    getViewport: () => undefined,
    refresh: vi.fn(),
    ensureDocumentMeshes: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('../src/renderer/src/task-preview', () => ({ scheduleTaskPreview: vi.fn() }));

beforeEach(() => {
  taskCopies.clear();
  documentTabs.clear();
  useTaskStore.setState({ tasks: {}, previewId: null, unread: false });
  useReviewStore.setState({ reviews: {} });
});
function setup() {
  const session = new DocumentSession(createDocument());
  const tab: DocumentTab = {
    session,
    assets: {},
    readOnly: false,
    path: null,
    lastRecovery: null,
    pending: Promise.resolve(),
    started: false,
  };
  documentTabs.set(session.document.documentId, tab);
  useDocumentStore.setState({ activeId: session.document.documentId });
  vi.mocked(activeTab).mockReturnValue(tab);
  const services: EditorHostServices = {
    active: () => tab,
    lock: vi.fn(),
    changed: vi.fn(),
    library: { catalogSearch: vi.fn(), catalogPart: vi.fn(), catalogColors: vi.fn() },
    assemblyPart: vi.fn(),
    catalog: vi.fn(),
    check: vi.fn(async () => []),
    render: vi.fn(),
    decode: vi.fn(),
    encode: vi.fn(),
    bom: vi.fn(),
    exportIo: vi.fn(),
    documents: vi.fn(),
  };
  configureTaskRuntime(services);
  createTask('task', 'chat', {
    providerId: 'fake',
    model: 'fake',
    text: 'Place a brick',
    images: [],
    effort: 'fast',
    selection: false,
    modelContext: false,
  });
  receiveTask({ ...useTaskStore.getState().tasks.task!, status: 'running' });
  return { tab, working: taskCopies.get('task')!.working.session };
}
it.each([false, true])(
  'retains failed task edits with intervening edits=%s and supports one-step undo',
  async (edited) => {
    const { tab, working } = setup();
    expect(working.dispatch({ type: 'part.add', partId: 'ld:3001', colorId: 'c:red' }).ok).toBe(true);
    if (edited)
      expect(
        tab.session.applyExternal([{ type: 'meta.update', changes: { title: 'User edit' } }], 'User edit', 'ui').ok,
      ).toBe(true);
    const before = tab.session.document;
    const historyLength = tab.session.history.length;
    const status = await finishTask('task', true, true);
    expect(status).toBe(edited ? 'pending_merge' : 'merged');
    receiveTask({ ...useTaskStore.getState().tasks.task!, status });
    if (edited) {
      expect(tab.session.document).toBe(before);
      expect(taskCopies.has('task')).toBe(true);
      expect(await mergeTask('task')).toBe('merged');
    }
    expect(expandInstances(tab.session.document)).toHaveLength(1);
    expect(reviewFor(before.documentId)?.diff.instances).toHaveLength(1);
    expect(tab.session.history).toHaveLength(historyLength + 1);
    tab.session.undo();
    expect(expandInstances(tab.session.document)).toHaveLength(0);
    expect(tab.session.document.meta.title).toBe(before.meta.title);
  },
);
it.each([false, true])('fails without net changes even after an undone mutation=%s', async (reverted) => {
  const { tab, working } = setup();
  if (reverted) {
    expect(working.dispatch({ type: 'part.add', partId: 'ld:3001', colorId: 'c:red' }).ok).toBe(true);
    working.undo();
  }
  expect(await finishTask('task', true, true)).toBe('failed');
  expect(tab.session.history).toHaveLength(0);
  expect(reviewFor(tab.session.document.documentId)).toBeUndefined();
  receiveTask({ ...useTaskStore.getState().tasks.task!, status: 'failed' });
  expect(taskCopies.has('task')).toBe(false);
});
it('retains structure-only changes on failure', async () => {
  const { tab, working } = setup();
  const original = tab.session.document.meta.title;
  expect(working.applyExternal([{ type: 'meta.update', changes: { title: 'AI title' } }], 'AI title', 'ai').ok).toBe(
    true,
  );
  expect(await finishTask('task', true, true)).toBe('merged');
  expect(tab.session.document.meta.title).toBe('AI title');
  expect(reviewFor(tab.session.document.documentId)?.diff.structure.length).toBeGreaterThan(0);
  tab.session.undo();
  expect(tab.session.document.meta.title).toBe(original);
});
