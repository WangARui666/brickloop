import { create } from 'zustand';
import { DocumentSession, planMerge, takeTheirs, diffDocuments } from '@brickloop/core';
import type { BrkDocument, MergePlan } from '@brickloop/core';
import type { AiTaskInfo, AiTaskStatus, ImageTaskRequest, TurnRequest } from '../../shared/ai-api';
import { RendererEditorHost } from './ai-editor-host';
import type { EditorHostServices, HostDocument } from './ai-editor-host';
import {
  activeTab,
  documentTabs,
  documentLocked,
  documentMcpLocked,
  refresh,
  ensureDocumentMeshes,
  getViewport,
  useDocumentStore,
} from './document-store';
import { observeReview, reviewFor, updateReview } from './review-store';
import { i18n, useShellStore } from './store';
import { useAiStore } from './ai-store';
import { scheduleTaskPreview } from './task-preview';

export interface TaskView extends AiTaskInfo {
  selectionBounds?: [number, number, number, number, number, number];
  summary: { added: number; modified: number; conflicts: number } | null;
  error?: string;
}
export const useTaskStore = create<{
  tasks: Record<string, TaskView>;
  previewId: string | null;
  unread: boolean;
}>(() => ({ tasks: {}, previewId: null, unread: false }));
export interface TaskCopy {
  baseAssets: HostDocument['assets'];
  base: BrkDocument;
  working: HostDocument;
  host: RendererEditorHost;
  request: TurnRequest | ImageTaskRequest;
  services: EditorHostServices;
}
export const taskCopies = new Map<string, TaskCopy>();
let hostServices: EditorHostServices;
export function configureTaskRuntime(services: EditorHostServices) {
  hostServices = services;
}
function update(id: string, patch: Partial<TaskView>) {
  useTaskStore.setState((s) => ({ tasks: { ...s.tasks, [id]: { ...s.tasks[id]!, ...patch } } }));
}
export function receiveTask(info: AiTaskInfo) {
  const previous = useTaskStore.getState().tasks[info.taskId];
  update(info.taskId, { ...info, summary: previous?.summary ?? null });
  if (
    info.status === 'running' &&
    previous?.status !== 'running' &&
    info.documentId === useDocumentStore.getState().activeId
  ) {
    useTaskStore.setState({ previewId: info.taskId });
    scheduleTaskPreview();
  }
  const shell = useShellStore.getState();
  if (
    ['pending_merge', 'merged', 'stopped', 'failed'].includes(info.status) &&
    (shell.rightCollapsed || shell.rightTab !== 'ai')
  )
    useTaskStore.setState({ unread: true });
  if (!['queued', 'running', 'pending_merge'].includes(info.status)) {
    if (useTaskStore.getState().previewId === info.taskId) useTaskStore.setState({ previewId: null });
    taskCopies.delete(info.taskId);
    scheduleTaskPreview();
  }
}
export function createTask(id: string, kind: AiTaskInfo['kind'], request: TurnRequest | ImageTaskRequest) {
  const tab = activeTab();
  if (tab.readOnly || documentLocked()) throw new Error('DOCUMENT_BUSY');
  const base = tab.session.document;
  const working: HostDocument = {
    session: new DocumentSession(structuredClone(base), { workspace: structuredClone(tab.session.workspace) }),
    assets: { ...tab.assets },
    readOnly: false,
  };
  const turn = kind !== 'image' ? (request as TurnRequest) : undefined;
  working.session.setContext(
    structuredClone({ ...tab.session.context, ...(turn?.selectionPaths ? { selection: turn.selectionPaths } : {}) }),
  );
  const services: EditorHostServices = {
    ...hostServices,
    active: () => working,
    lock: () => undefined,
    changed: () => scheduleTaskPreview(),
    bom: (doc, modelPath) =>
      window.brickloop.projectBom(
        { doc, workspace: working.session.workspace, assets: working.assets },
        { scope: modelPath ? { kind: 'model', path: modelPath } : { kind: 'project' } },
      ),
  };
  taskCopies.set(id, {
    base,
    baseAssets: tab.assets,
    working,
    host: new RendererEditorHost(services, turn?.scope ? { base, paths: turn.scope.paths } : undefined),
    request,
    services,
  });
  update(id, { taskId: id, documentId: base.documentId, kind, status: 'queued', createdAt: Date.now(), summary: null });
  if (kind === 'selection') {
    const bounds = getViewport()?.selectionBounds(turn?.selectionPaths);
    if (bounds) update(id, { selectionBounds: bounds });
    const shell = useShellStore.getState();
    if (shell.rightCollapsed || shell.rightTab !== 'ai') useTaskStore.setState({ unread: true });
  }
  const image = kind === 'image' ? (request as ImageTaskRequest) : null;
  useAiStore.setState((s) => ({
    turns: [
      ...s.turns,
      {
        id,
        documentId: base.documentId,
        user: image ? (image.input.description ?? '') : (request as TurnRequest).text,
        ...(kind === 'selection' ? { selectionCount: turn?.selectionPaths?.length ?? 0 } : {}),
        images: image ? image.input.images.map((v) => v.image) : (request as TurnRequest).images,
        text: '',
        events: [],
      },
    ],
    ...(image
      ? {
          workflows: {
            ...s.workflows,
            [id]: {
              taskId: id,
              documentId: base.documentId,
              request: image,
              state: null,
              plan: null,
              comparison: null,
              updatedAt: Date.now(),
            },
          },
        }
      : {}),
  }));
  scheduleTaskPreview();
  return { documentId: base.documentId };
}
function plan(id: string) {
  const copy = taskCopies.get(id),
    task = useTaskStore.getState().tasks[id];
  const tab = task && documentTabs.get(task.documentId);
  if (!copy || !tab || tab.readOnly) throw new Error('DOCUMENT_CLOSED');
  const merge = planMerge(copy.base, copy.working.session.document, tab.session.document);
  if (!merge.ok) {
    update(id, { error: 'parallelUi.invalidMerge' });
    throw new Error('INVALID_MERGE');
  }
  return { copy, tab, merge: merge.value };
}
function summary(merge: MergePlan) {
  return {
    added: merge.applied.filter((v) => v.kinds.includes('added')).length,
    modified: merge.applied.filter((v) => !v.kinds.includes('added')).length,
    conflicts: merge.conflicts.length,
  };
}
export async function finishTask(id: string, stopped: boolean, failed = false): Promise<AiTaskStatus> {
  const task = useTaskStore.getState().tasks[id];
  if (!task || task.status === 'discarded') return 'discarded';
  const copy = taskCopies.get(id),
    tab = documentTabs.get(task.documentId);
  if (!copy || !tab) return 'discarded';
  const changed = diffDocuments(copy.base, copy.working.session.document);
  if (!changed.instances.length && !changed.structure.length) return failed ? 'failed' : stopped ? 'stopped' : 'merged';
  if (
    tab.session.document.revision === copy.base.revision &&
    !tab.session.isPreviewing &&
    !documentMcpLocked(task.documentId)
  )
    return mergeTask(id);
  try {
    update(id, { status: 'pending_merge', summary: summary(plan(id).merge) });
  } catch {
    update(id, { status: 'pending_merge' });
  }
  return 'pending_merge';
}
export async function mergeTask(id: string): Promise<AiTaskStatus> {
  const task = useTaskStore.getState().tasks[id];
  if (!task || task.status === 'discarded') return 'discarded';
  if (task.status === 'merged') return 'merged';
  const { copy, tab, merge } = plan(id);
  if (tab.session.isPreviewing || documentMcpLocked(task.documentId) || reviewFor(task.documentId)?.mode === 'before')
    return 'pending_merge';
  const before = tab.session.document;
  const text = 'text' in copy.request ? copy.request.text : (copy.request.input.description ?? '');
  // A conflict-only merge still owns a history boundary so its later resolutions can
  // participate in "undo this AI round" just like a merge with automatically applied items.
  const mergeOps =
    merge.ops.length || !merge.conflicts.length ? merge.ops : [{ type: 'meta.update' as const, changes: {} }];
  const result = tab.session.applyExternal(
    mergeOps,
    i18n.t('parallelUi.transaction', { summary: text.slice(0, 48) }),
    'ai',
  );
  if (!result.ok) {
    update(id, { error: 'parallelUi.invalidMerge' });
    return 'pending_merge';
  }
  const changedAssets = Object.fromEntries(
    Object.entries(copy.working.assets).filter(([key, value]) => copy.baseAssets[key] !== value),
  );
  if (Object.keys(changedAssets).length) {
    tab.assets = { ...tab.assets, ...changedAssets };
    tab.assetsDirty = true;
  }
  const after = tab.session.document;
  // Also creates a review for conflict-only merges, which have no document operation.
  observeReview(
    before,
    after,
    {
      type: 'tx',
      transaction: result.value ?? {
        id: '',
        label: '',
        source: 'ai',
        ops: [],
        revisionBefore: before.revision,
        revisionAfter: after.revision,
      },
      ops: merge.ops,
      revisionBefore: before.revision,
      revisionAfter: after.revision,
    },
    merge.conflicts,
  );
  const review = reviewFor(task.documentId);
  update(id, { status: 'merged', summary: summary(merge) });
  refresh();
  void ensureDocumentMeshes();
  try {
    const [oldIssues, newIssues] = await Promise.all([copy.services.check(before), copy.services.check(after)]);
    const key = (issue: (typeof oldIssues)[number]) =>
      JSON.stringify([issue.kind, issue.paths.map((p) => p.join('/')).sort()]);
    const old = new Set(oldIssues.map(key));
    if (review && reviewFor(task.documentId)?.startedAt === review.startedAt)
      updateReview(task.documentId, { newIssues: new Set(newIssues.filter((v) => !old.has(key(v))).map(key)).size });
  } catch {
    update(id, { error: 'parallelUi.checkFailed' });
  }
  return 'merged';
}
export function discardTask(id: string) {
  if (useTaskStore.getState().tasks[id]) update(id, { status: 'discarded' });
  taskCopies.delete(id);
  if (useTaskStore.getState().previewId === id) useTaskStore.setState({ previewId: null });
  scheduleTaskPreview();
}
export function previewTask(id: string | null) {
  useTaskStore.setState({ previewId: id });
  scheduleTaskPreview();
}
export function resolveConflict(key: string, theirs: boolean): boolean {
  const tab = activeTab(),
    doc = tab.session.document,
    review = reviewFor(doc.documentId);
  if (!review || documentLocked() || tab.readOnly) return false;
  const conflict = review.conflicts.find((v) => v.key === key);
  if (!conflict) return false;
  if (theirs) {
    const ops = takeTheirs(doc, conflict);
    if (!ops.ok) {
      useAiStore.setState({ error: 'parallelUi.invalidMerge' });
      return false;
    }
    const result = tab.session.applyExternal(ops.value, i18n.t('parallelUi.resolveTransaction'), 'ui');
    if (!result.ok) return false;
    if (result.value)
      updateReview(doc.documentId, { transactions: new Set([...review.transactions, result.value.id]) });
  }
  updateReview(doc.documentId, { resolvedConflicts: { ...review.resolvedConflicts, [key]: theirs ? 'ai' : 'mine' } });
  refresh();
  void ensureDocumentMeshes();
  return true;
}
