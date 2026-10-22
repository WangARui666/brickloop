import { usePreferences } from './preferences-store';
import { useAiStore } from './ai-store';
import { useTaskStore } from './ai-task-runtime';
import { documentMcpLocked } from './document-store';
import { reviewFor } from './review-store';
import { useLibraryStore } from './library-store';
import { create } from 'zustand';
import {
  copySelection,
  DocumentSession,
  resolvePath,
  groupAncestors,
  resolveClickSelection,
  pathStartsWith,
} from '@brickloop/core';
import type { InstancePath } from '@brickloop/core';
import type { IoIssue, IoReport, ModelInfo } from '@brickloop/io';
import type { RecoverableDocument } from '@brickloop/io/node';
import type { ExportFormat, ExportResult, ProjectPayload } from '../../shared/project-api';
import {
  activeTab,
  addStep,
  removeStep,
  addDocument,
  captureWorkspace,
  copyEditor,
  displayDocumentTitle,
  dispatchEdit,
  documentSession,
  documentTabs,
  editorViewport,
  ensureDocumentMeshes,
  enter,
  enterContext,
  pasteEditor,
  projectPayload,
  refresh,
  registerEditorActions,
  removeDocument,
  selectPaths,
  switchDocument,
  tabTitle,
  trackTab,
  useDocumentStore,
} from './document-store';
import { i18n, useShellStore } from './store';

export interface ReportView {
  kind: 'import' | 'export' | 'project';
  report?: IoReport;
  result?: ExportResult;
  issues: IoIssue[];
  path: string | null;
}
interface ProjectUi {
  recent: string[];
  recoverable: RecoverableDocument[];
  report: ReportView | null;
  reports: ReportView[];
  exportFormat: ExportFormat | null;
  info: ModelInfo | null;
  busy: boolean;
  error: string | null;
  namePrompt: { title: string; value: string; resolve(value: string | null): void } | null;
  choice: {
    title: string;
    message: string;
    options: { key: string; label: string }[];
    resolve(value: string): void;
  } | null;
  focusedModel: string | null;
}
export const useProjectUi = create<ProjectUi>(() => ({
  recent: [],
  recoverable: [],
  report: null,
  reports: [],
  exportFormat: null,
  info: null,
  busy: false,
  error: null,
  namePrompt: null,
  choice: null,
  focusedModel: null,
}));
export function reportNext() {
  const [report, ...reports] = useProjectUi.getState().reports;
  useProjectUi.setState({ report: report ?? null, reports });
}
export function askName(title: string, value: string): Promise<string | null> {
  return new Promise((resolve) => useProjectUi.setState({ namePrompt: { title, value, resolve } }));
}
function choose(title: string, message: string, keys: string[], taskPrompt = false) {
  return new Promise<string>((resolve) =>
    useProjectUi.setState({
      choice: {
        title,
        message,
        options: keys.map((key) => ({
          key,
          label: i18n.t(taskPrompt && key === 'discard' ? 'parallelUi.discard' : `files.${key}`),
        })),
        resolve,
      },
    }),
  );
}
let fileTasks = Promise.resolve();
export function runFileTask(action: () => Promise<unknown>) {
  const task = fileTasks.then(async () => {
    useProjectUi.setState({ busy: true, error: null });
    try {
      await action();
    } catch (error) {
      useProjectUi.setState({ error: humanFileError(error) });
    } finally {
      useProjectUi.setState({ busy: false });
    }
  });
  fileTasks = task;
  return task;
}
function humanFileError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/EACCES|EPERM|EROFS/.test(message)) return i18n.t('io.SAVE_PERMISSION');
  if (/ENOENT/.test(message)) return i18n.t('files.notFound');
  if (/ENOSPC/.test(message)) return i18n.t('io.SAVE_NO_SPACE');
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
export async function openDocuments(file?: string) {
  if (useDocumentStore.getState().reviewBefore) return;
  await runFileTask(async () => {
    if (file && /\.brklpack$/i.test(file)) {
      const review = await window.brickloop.packsImport({ action: 'choose', kind: 'file', file });
      if (review) useLibraryStore.setState({ managerOpen: true, pendingReview: review });
      return;
    }
    if (file) {
      const existing = [...documentTabs.values()].find(
        (tab) => tab.path?.replaceAll('\\', '/').toLowerCase() === file.replaceAll('\\', '/').toLowerCase(),
      );
      if (existing) {
        switchDocument(existing.session.document.documentId);
        return;
      }
    }
    const opened = await window.brickloop.projectOpen(file);
    const reports: ReportView[] = [];
    for (const project of opened) {
      const empty = activeTab();
      addDocument(project);
      if (
        empty !== activeTab() &&
        !empty.path &&
        !empty.assetsDirty &&
        !empty.session.isDirty &&
        Object.values(empty.session.document.models).every((model) => !Object.keys(model.instances).length)
      )
        await removeDocument(empty.session.document.documentId);
      if (project.report || project.issues.length)
        reports.push({
          kind: project.imported ? 'import' : 'project',
          ...(project.report ? { report: project.report } : {}),
          issues: project.issues,
          path: project.sourcePath,
        });
    }
    useProjectUi.setState({ recent: await window.brickloop.projectRecent(), report: reports.shift() ?? null, reports });
  });
}
const associatedQueue: string[] = [];
let openingAssociatedFiles = false;
async function openAssociatedFiles(files: string[] = []) {
  associatedQueue.push(...files);
  if (openingAssociatedFiles || useDocumentStore.getState().reviewBefore) return;
  openingAssociatedFiles = true;
  try {
    while (associatedQueue.length && !useDocumentStore.getState().reviewBefore)
      await openDocuments(associatedQueue.shift()!);
  } finally {
    openingAssociatedFiles = false;
  }
}
export function unusedModels() {
  const doc = documentSession.document,
    used = new Set<string>();
  function visit(id: string) {
    if (used.has(id)) return;
    used.add(id);
    for (const item of Object.values(doc.models[id]!.instances)) if (item.ref.kind === 'model') visit(item.ref.modelId);
  }
  visit(doc.rootModelId);
  return Object.keys(doc.models).filter((id) => !used.has(id));
}
export async function saveDocument(saveAs = false, tab = activeTab()): Promise<boolean> {
  if (
    documentMcpLocked(tab.session.document.documentId) ||
    reviewFor(tab.session.document.documentId)?.mode === 'before'
  )
    return false;
  switchDocument(tab.session.document.documentId);
  if (tab.readOnly) {
    useProjectUi.setState({ error: i18n.t('io.PROJECT_NEWER_VERSION') });
    return false;
  }
  editorViewport()?.cancelGesture();
  tab.session.cancel();
  const unused = unusedModels();
  if (unused.length) {
    const answer = await choose(i18n.t('files.unusedTitle'), i18n.t('files.unusedMessage', { count: unused.length }), [
      'cancel',
      'keep',
      'clean',
    ]);
    if (answer === 'cancel') return false;
    if (answer === 'clean') {
      const result = tab.session.applyExternal(
        [
          {
            type: 'group.remove',
            items: Object.values(tab.session.document.groups)
              .filter((g) => unused.includes(g.modelId))
              .map((g) => ({ groupId: g.id })),
          },
          { type: 'model.remove', items: unused.map((modelId) => ({ modelId })) },
        ],
        i18n.t('files.clean'),
      );
      if (!result.ok) return false;
      refresh();
    }
  }
  captureWorkspace();
  const payload: ProjectPayload = projectPayload(tab);
  const thumbnail = editorViewport()?.captureLatest();
  const saved = await window.brickloop.projectSave(
    { ...payload, ...(thumbnail ? { thumbnail } : {}) },
    tab.path,
    saveAs,
  );
  if (!saved) return false;
  if (!saved.result.ok) {
    useProjectUi.setState({ error: i18n.t(saved.result.error.messageKey) });
    return false;
  }
  tab.path = saved.path;
  // A native dialog and IO can overlap editing; only mark the revision actually written.
  if (tab.session.document.revision === payload.doc.revision) tab.session.markSaved();
  if (tab.assets === payload.assets) tab.assetsDirty = false;
  refresh();
  useProjectUi.setState({ recent: await window.brickloop.projectRecent() });
  if (saved.result.issues.length)
    useProjectUi.setState({ report: { kind: 'project', issues: saved.result.issues, path: saved.path } });
  if (!thumbnail) {
    // Publish the placeholder immediately, then fill it from the next ordinary viewport frame.
    // Use the existing file queue and revision checks so this cannot overwrite a newer save.
    void runFileTask(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (activeTab() !== tab || tab.path !== saved.path || tab.session.document.revision !== payload.doc.revision)
        return;
      const nextThumbnail = editorViewport()?.captureLatest();
      if (nextThumbnail)
        await window.brickloop.projectSave({ ...payload, thumbnail: nextThumbnail }, saved.path, false);
    });
  }
  return true;
}
export async function closeDocument(id: string, createIfEmpty = true): Promise<boolean> {
  if (documentMcpLocked(id)) return false;
  const tab = documentTabs.get(id);
  if (!tab) return true;
  const tasks = Object.values(useTaskStore.getState().tasks).filter(
    (v) => v.documentId === id && ['queued', 'running', 'pending_merge'].includes(v.status),
  );
  if (tasks.length) {
    const answer = await choose(
      i18n.t('parallelUi.closeTitle'),
      i18n.t('parallelUi.closeMessage', { count: tasks.length }),
      ['cancel', 'discard'],
      true,
    );
    if (answer === 'cancel') return false;
    await Promise.all(
      tasks
        .filter((v) => ['queued', 'running', 'pending_merge'].includes(useTaskStore.getState().tasks[v.taskId]!.status))
        .map((v) => window.brickloop.aiTaskAction(v.taskId, 'discard')),
    );
  }
  switchDocument(id);
  if (tab.session.isDirty || tab.assetsDirty) {
    const answer = await choose(
      i18n.t('files.closeTitle'),
      i18n.t('files.closeMessage', { name: displayDocumentTitle(tabTitle(tab)) }),
      ['cancel', 'discard', 'save'],
    );
    if (answer === 'cancel') return false;
    if (answer === 'save' && !(await saveDocument(false, tab))) return false;
  }
  await removeDocument(id, createIfEmpty);
  return true;
}
export async function recoverDocument(item: RecoverableDocument, action: 'recover' | 'saveAs' | 'discard') {
  await runFileTask(async () => {
    if (action === 'discard') await window.brickloop.recoveryClose(item.documentId);
    else {
      if (!item.doc || !item.workspace) return;
      // Keep the original recovery directory until an explicit choice is made.
      await window.brickloop.recoveryClose(item.documentId);
      const tab = addDocument(
        {
          doc: item.doc,
          workspace: item.workspace,
          assets: item.assets,
          path: item.projectPath,
          sourcePath: item.projectPath,
          imported: false,
          readOnly: false,
          issues: item.issues,
        },
        true,
      );
      await tab.pending;
      if (action === 'saveAs') await saveDocument(true, tab);
      await ensureDocumentMeshes();
      if (item.issues.length)
        useProjectUi.setState({ report: { kind: 'project', path: item.projectPath, issues: item.issues } });
    }
    useProjectUi.setState((state) => ({
      recoverable: state.recoverable.filter((row) => row.documentId !== item.documentId),
    }));
  });
}
export function selectedGroup() {
  const path = documentSession.workspace.selection.at(-1),
    instance = path ? resolvePath(documentSession.document, path)?.instance : undefined;
  const ancestors = groupAncestors(documentSession.document, instance?.groupId ?? null);
  const parent = documentSession.context.activeGroupId;
  return (
    parent
      ? ancestors.slice(
          0,
          ancestors.findIndex((g) => g.id === parent),
        )
      : ancestors
  ).at(-1);
}
export function selectedModel() {
  const focused = useProjectUi.getState().focusedModel;
  if (focused && documentSession.document.models[focused]) return documentSession.document.models[focused];
  const path = documentSession.workspace.selection.at(-1),
    ref = path ? resolvePath(documentSession.document, path)?.instance.ref : undefined;
  return ref?.kind === 'model' ? documentSession.document.models[ref.modelId] : undefined;
}
async function rename() {
  const group = selectedGroup(),
    model = selectedModel();
  const target = group ?? model;
  if (!target) return;
  const name = await askName(i18n.t('structure.rename'), target.name);
  if (!name) return;
  dispatchEdit(
    group ? { type: 'group.rename', groupId: group.id, name } : { type: 'submodel.rename', modelId: model!.id, name },
  );
}
export async function placeSubmodel(modelId: string, pointer?: { x: number; y: number }) {
  const temp = new DocumentSession(documentSession.document, { workspace: documentSession.workspace });
  const result = temp.dispatch({ type: 'submodel.instantiate', modelId });
  if (!result.ok) {
    useDocumentStore.setState({ error: i18n.t('structure.cycle') });
    return;
  }
  const data = copySelection(temp.document, temp.workspace.selection);
  await pasteEditor(true, { data, assets: activeTab().assets }, pointer);
}
export function makeContextUnique() {
  const path = documentSession.workspace.activeModelPath;
  if (!path.length) return;
  enterContext(path.slice(0, -1));
  selectPaths([path]);
  dispatchEdit({ type: 'submodel.makeUnique' });
  enterContext(path);
}
let initialized = false;
export async function initializeProjects() {
  if (initialized) return;
  initialized = true;
  registerEditorActions({
    'file.pdf': () => usePreferences.setState({ pdf: true }),
    'settings.open': () => {
      usePreferences.setState({ page: 'general' });
      useAiStore.setState({ settingsOpen: true });
    },
    'file.new': () => {
      addDocument();
    },
    'file.open': () => openDocuments(),
    'file.import': () => openDocuments(),
    'file.save': () => runFileTask(() => saveDocument()),
    'file.saveAs': () => runFileTask(() => saveDocument(true)),
    'file.close': () => runFileTask(() => closeDocument(documentSession.document.documentId)),
    'file.next': () => {
      const ids = [...documentTabs.keys()];
      switchDocument(ids[(ids.indexOf(documentSession.document.documentId) + 1) % ids.length]!);
    },
    'file.export': () => useProjectUi.setState({ exportFormat: 'io' }),
    'view.screenshot': () => useProjectUi.setState({ exportFormat: 'png' }),
    'model.info': () =>
      runFileTask(async () => useProjectUi.setState({ info: await window.brickloop.projectInfo(projectPayload()) })),
    'edit.copy': () => copyEditor(),
    'edit.cut': () => copyEditor(true),
    'edit.paste': () => pasteEditor(),
    'edit.clone': () => {
      if (documentSession.workspace.selection.length)
        return pasteEditor(true, {
          data: copySelection(documentSession.document, documentSession.workspace.selection),
          assets: activeTab().assets,
        });
    },
    'group.create': async () => {
      if (!documentSession.workspace.selection.length) return;
      const name = await askName(i18n.t('desktop.commands.group.create.label'), i18n.t('structure.newGroup'));
      if (name) dispatchEdit({ type: 'group.create', name });
    },
    'group.dissolve': () => {
      const group = selectedGroup();
      if (group) dispatchEdit({ type: 'group.dissolve', groupIds: [group.id] });
    },
    'submodel.create': async () => {
      if (!documentSession.workspace.selection.length) return;
      await ensureDocumentMeshes();
      const name = await askName(i18n.t('desktop.commands.submodel.create.label'), i18n.t('structure.newSubmodel'));
      if (name) dispatchEdit({ type: 'submodel.create', name });
    },
    'structure.rename': rename,
    'group.rename': rename,
    'submodel.rename': rename,
    'submodel.instantiate': () => {
      const model = selectedModel();
      if (model) return placeSubmodel(model.id);
    },
    'submodel.independent': () => {
      if (!documentSession.workspace.selection.length) return;
      const data = copySelection(documentSession.document, documentSession.workspace.selection);
      data.sourceDocumentId = '';
      return pasteEditor(true, { data, assets: activeTab().assets });
    },
    'submodel.makeUnique': () => {
      dispatchEdit({ type: 'submodel.makeUnique' });
    },
    'submodel.explode': () => {
      dispatchEdit({ type: 'submodel.explode' });
    },
    'group.enter': () => {
      const path = documentSession.workspace.selection.at(-1);
      if (path) enter(path);
    },
    'submodel.enter': () => {
      const path = documentSession.workspace.selection.at(-1);
      if (path) enter(path);
    },
    'group.exit': () =>
      enterContext(
        documentSession.context.activeModelPath,
        documentSession.document.groups[documentSession.context.activeGroupId ?? '']?.parentGroupId ?? undefined,
      ),
    'submodel.exit': () => enterContext(documentSession.workspace.activeModelPath.slice(0, -1)),
    'step.add': addStep,
    'step.remove': () => removeStep(),
  });
  const recoverable = await window.brickloop.recoveryScan();
  window.brickloop.onOpenFiles((files) => {
    void openAssociatedFiles(files);
  });
  useDocumentStore.subscribe((state, previous) => {
    if (previous.locked && !state.locked) void openAssociatedFiles();
  });
  const launchFiles = await window.brickloop.filesReady();
  await openAssociatedFiles(launchFiles);
  const settings = await window.brickloop.getSettings();
  if (!launchFiles.length && !recoverable.length && settings.preferences?.reopenLast && settings.recentFiles?.[0])
    await openDocuments(settings.recentFiles[0]);
  trackTab(activeTab());
  window.brickloop.onCloseRequested(() => {
    void runFileTask(async () => {
      for (const id of [...documentTabs.keys()]) if (!(await closeDocument(id, false))) return;
      await window.brickloop.windowClose();
    });
  });
  window.brickloop.onRecoveryError(() => useProjectUi.setState({ error: i18n.t('files.recoveryFailed') }));
  useProjectUi.setState({
    recent: await window.brickloop.projectRecent(),
    recoverable,
  });
}
export function selectTree(paths: InstancePath[], modelPath: InstancePath, toggle: boolean) {
  useProjectUi.setState({ focusedModel: null });
  const hit = paths[0];
  if (!hit) {
    selectPaths([]);
    return;
  }
  const context = documentSession.context;
  const local = resolvePath(documentSession.document, hit.slice(0, context.activeModelPath.length + 1));
  if (
    !pathStartsWith(hit, context.activeModelPath) ||
    (context.activeGroupId &&
      !groupAncestors(documentSession.document, local?.instance.groupId ?? null).some(
        (g) => g.id === context.activeGroupId,
      ))
  )
    enterContext(modelPath);
  selectPaths(resolveClickSelection(documentSession.document, documentSession.context, hit, { ctrl: toggle }));
  useShellStore.getState().setRightTab('structure');
}
