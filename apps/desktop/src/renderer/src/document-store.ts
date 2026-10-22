import { create } from 'zustand';
import {
  createDocument,
  createWorkspace,
  copySelection,
  DocumentSession,
  executeCommand,
  expandInstances,
  fromLDraw,
  groupAncestors,
  identity,
  invert,
  multiply,
  orderedInstances,
  pathStartsWith,
  resolveClickSelection,
  resolveContext,
  resolvePath,
  rotationAxisAngle,
  toLDraw,
  transformPoint,
  translation,
  ulid,
} from '@brickloop/core';
import type { BrkDocument, Command, InstancePath, Result, Vec3, Workspace, ClipboardData } from '@brickloop/core';
import type {
  Viewport,
  ViewPreset,
  EditorEvents,
  PointerModifiers,
  PlacementPreview,
  PartInstance,
} from '@brickloop/viewport';
import type { ProjectPayload, OpenedProject, ClipboardPayload } from '../../shared/project-api';
import type { ProjectAssets, ProjectPreservation } from '@brickloop/io';
import type { Transform } from '@brickloop/ldraw';
import { horizontalAxes, keyboardDelta } from '@brickloop/viewport';
import type { LibraryColor, LibraryPart } from '../../shared/library-api';
import { useLibraryStore } from './library-store';
import { i18n } from './store';
import { clearMeshCache, getMesh, sourceMeshes, retainMeshes } from './mesh-client';
import {
  useAssemblyStore,
  updateAssembly,
  loadAssemblyPart,
  solvePreview,
  showPreview,
  clearAssemblyPreview,
  previewBlocked,
  supportPlane,
  connectedPaths,
  openChecks,
  setAssemblyOption,
  chooseConnectorPivot,
} from './assembly-store';
import { constrainConnectorRotation } from './connector-rotation';
import { macroInsertOps } from '@brickloop/io';
import type { MacroPackage } from '@brickloop/io';
import { modelParts } from './model-thumbnail';
import { shortcutCommand, usePreferences } from './preferences-store';
import { previewDocument } from '../../../../../packages/core/src/history/transform-preview';
import { useReviewStore, reviewFor, observeReview, endReview, updateReview } from './review-store';
import { buildReviewOverlay } from './review-overlay';

export type SelectionMode = 'default' | 'color' | 'type' | 'both' | 'connected';
interface EditorState {
  reviewBefore: boolean;
  locked: 'mcp' | null;
  tabs: { id: string; title: string; dirty: boolean; path: string | null }[];
  activeId: string;
  lastRecovery: string | null;
  document: BrkDocument;
  workspace: Workspace;
  dirty: boolean;
  tick: number;
  tool: 'select' | 'move' | 'rotate';
  space: 'world' | 'primaryLocal';
  pivot: 'center' | 'primary' | 'connector';
  selectionMode: SelectionMode;
  horizontal: number;
  vertical: number;
  angle: number;
  placement: { part: LibraryPart; rotation: Float64Array } | null;
  clipboardPlacement: {
    data: ClipboardPayload;
    preview: PlacementPreview;
    name: string;
    macro?: { pkg: MacroPackage; mode: 'group' | 'submodel'; warning: string | null };
  } | null;
  stepViewing: boolean;
  stepNotice: string | null;
  eyedropper: boolean;
  error: string | null;
  loading: boolean;
  meshProgress: { loaded: number; total: number } | null;
  missingMeshes: string[];
  contextMenu: { x: number; y: number } | null;
}
export const meshes = sourceMeshes;
let untitledNumber = 0;
const nextTitle = () => i18n.t('connectUi.untitledNumber', { number: ++untitledNumber });
export function displayDocumentTitle(title: string) {
  const match = /^(?:未命名|Untitled) (\d+)$/.exec(title);
  return match
    ? i18n.t('connectUi.untitledNumber', { number: Number(match[1]) })
    : title === '未命名' || title === 'Untitled'
      ? i18n.t('editor.untitled')
      : title;
}
export let documentSession = new DocumentSession(createDocument({ title: nextTitle() }), {
  bboxProvider: (id) => meshes.get(id)?.bboxLdu,
});
export interface DocumentTab {
  openingCamera?: { saved: boolean; imported: boolean; touched: boolean; meshesReady: boolean };
  assetsDirty?: boolean;
  session: DocumentSession;
  path: string | null;
  assets: ProjectAssets;
  preservation?: ProjectPreservation;
  readOnly: boolean;
  lastRecovery: string | null;
  pending: Promise<unknown>;
  dispose?: () => void;
  started: boolean;
}
export const documentTabs = new Map<string, DocumentTab>();
documentTabs.set(documentSession.document.documentId, {
  session: documentSession,
  path: null,
  assets: {},
  readOnly: false,
  lastRecovery: null,
  pending: Promise.resolve(),
  started: false,
});
export const useDocumentStore = create<EditorState>(() => ({
  reviewBefore: false,
  locked: null,
  tabs: [
    { id: documentSession.document.documentId, title: documentSession.document.meta.title, dirty: false, path: null },
  ],
  activeId: documentSession.document.documentId,
  lastRecovery: null,
  document: documentSession.document,
  workspace: documentSession.workspace,
  dirty: false,
  tick: 0,
  tool: 'select',
  space: 'world',
  pivot: 'center',
  selectionMode: 'default',
  horizontal: 20,
  vertical: 8,
  angle: 90,
  placement: null,
  clipboardPlacement: null,
  stepViewing: false,
  stepNotice: null,
  eyedropper: false,
  error: null,
  loading: false,
  meshProgress: null,
  missingMeshes: [],
  contextMenu: null,
}));
let viewport: Viewport | null = null;
let stopCameraInteraction: (() => void) | undefined;

/** A-96: only the UI writes a positive, finite span. Keep this separate from camera capture. */
export function hasSavedCamera(camera: Workspace['camera']): camera is Workspace['camera'] & { span: number } {
  return 'span' in camera && typeof camera.span === 'number' && Number.isFinite(camera.span) && camera.span > 0;
}

export function openingCameraAction(input: {
  saved: boolean;
  imported: boolean;
  touched: boolean;
  ready: boolean;
  intersects: boolean | null;
}): 'wait' | 'keep' | 'fit' {
  if (input.touched) return 'keep';
  if (!input.ready) return 'wait';
  // null means there is no visible content. Never move an empty model's camera.
  if (input.intersects === null) return 'keep';
  return input.imported || !input.saved || !input.intersects ? 'fit' : 'keep';
}

function restoreTabCamera() {
  const camera = documentSession.workspace.camera;
  viewport?.restoreCamera(camera, hasSavedCamera(camera) ? camera.span : undefined);
}

function finishOpeningCamera() {
  const tab = activeTab();
  const pending = tab.openingCamera;
  if (!pending || !viewport) return;
  const ready = pending.meshesReady && useLibraryStore.getState().allColors.length > 0;
  if (ready) viewport.refreshCameraClipping();
  const action = openingCameraAction({
    ...pending,
    ready,
    intersects: ready ? (viewport.contentVisibility()?.intersects ?? null) : null,
  });
  if (action === 'wait') return;
  delete tab.openingCamera;
  if (action === 'fit') viewport.setPreset('iso'); // setPreset already fits the content.
  captureWorkspace();
}

export const getViewport = () => viewport;
const mcpLocks = new Set<string>();
export const documentMcpLocked = (id: string) => mcpLocks.has(id);
export const documentLocked = () =>
  useDocumentStore.getState().locked !== null || useDocumentStore.getState().reviewBefore;
export function setDocumentLock(locked: 'ai' | 'mcp' | null, id = documentSession.document.documentId) {
  if (locked === 'ai') return;
  if (locked) mcpLocks.add(id);
  else mcpLocks.delete(id);
  if (id !== documentSession.document.documentId) return;
  if (locked && !documentLocked()) {
    viewport?.cancelGesture();
    documentSession.cancel();
  }
  useDocumentStore.setState({ locked, placement: null, clipboardPlacement: null });
  syncPlacement();
}
let generation = 0;
const actions = new Map<string, () => void | Promise<unknown>>();
export function registerEditorActions(entries: Record<string, () => void | Promise<unknown>>) {
  for (const [key, value] of Object.entries(entries)) {
    actions.set(key, value);
    availableEditorActions.add(key);
  }
}
export function activeTab() {
  return documentTabs.get(documentSession.document.documentId)!;
}
let unmountDocumentRenderer: (() => void) | undefined;
export function registerDocumentRenderer(unmount: () => void) {
  unmountDocumentRenderer = unmount;
}
export function editorViewport() {
  return viewport;
}
export function captureWorkspace() {
  const camera = viewport?.getCamera();
  documentSession.updateWorkspace({
    ...(camera ? { camera } : {}),
    panelState: {
      ...documentSession.workspace.panelState,
      activeGroupId: documentSession.context.activeGroupId ?? null,
      stepId: documentSession.context.stepId ?? null,
    },
  });
}
export function projectPayload(tab = activeTab()): ProjectPayload {
  if (tab === activeTab()) captureWorkspace();
  return {
    doc: tab.session.document,
    workspace: tab.session.workspace,
    assets: tab.assets,
    ...(tab.preservation ? { preservation: tab.preservation } : {}),
  };
}
/** A saved project is named after its file; imports keep their source name until saved. */
export function tabTitle(tab: { path: string | null; session: { document: { meta: { title: string } } } }) {
  return tab.path
    ? tab.path
        .split(/[\\/]/)
        .pop()!
        .replace(/\.brkl$/i, '')
    : tab.session.document.meta.title;
}
function refreshTabs() {
  useDocumentStore.setState({
    tabs: [...documentTabs.values()].map((tab) => ({
      id: tab.session.document.documentId,
      title: tabTitle(tab),
      path: tab.path,
      dirty: tab.session.isDirty || tab.assetsDirty === true,
    })),
    activeId: documentSession.document.documentId,
    lastRecovery: activeTab().lastRecovery,
  });
}
export function trackTab(tab: DocumentTab) {
  if (tab.started || tab.readOnly) return;
  tab.started = true;
  tab.pending = window.brickloop.recoveryStart(projectPayload(tab), tab.path).then((at) => {
    tab.lastRecovery = at;
    refreshTabs();
  });
  void tab.pending.catch(() => useDocumentStore.setState({ error: i18n.t('files.recoveryFailed') }));
  let committed = tab.session.document;
  tab.dispose = tab.session.onChange((change) => {
    const previous = committed;
    committed = tab.session.document;
    observeReview(previous, committed, change);
    const workspace = tab.session.workspace;
    tab.pending = tab.pending
      .then(() => window.brickloop.recoveryChange(tab.session.document.documentId, change, workspace, tab.assets))
      .then((at) => {
        tab.lastRecovery = at;
        refreshTabs();
      });
    void tab.pending.catch(() => useDocumentStore.setState({ error: i18n.t('files.recoveryFailed') }));
    queueMicrotask(() => {
      refreshTabs();
      if (tab.session === documentSession) {
        refresh();
        if (expandInstances(tab.session.document).some((row) => !meshes.has(row.partId))) void ensureDocumentMeshes();
      }
    });
  });
}
export function switchDocument(id: string) {
  const tab = documentTabs.get(id);
  if (!tab || tab.session === documentSession) return;
  updateReview(documentSession.document.documentId, { mode: 'after', focus: null });
  viewport?.cancelGesture();
  if (!documentMcpLocked(documentSession.document.documentId)) documentSession.cancel();
  documentSession.endMerge();
  captureWorkspace();
  generation++;
  documentSession = tab.session;
  const grid = documentSession.workspace.grid;
  useDocumentStore.setState({
    locked: documentMcpLocked(id) ? 'mcp' : null,
    placement: null,
    clipboardPlacement: null,
    stepViewing: false,
    stepNotice: null,
    contextMenu: null,
    eyedropper: false,
    loading: false,
    error: null,
    horizontal: grid.horizontal * 20,
    vertical: grid.vertical === 'plate' ? 8 : grid.vertical === 'brick' ? 24 : 1,
  });
  restoreTabCamera();
  refresh();
  refreshTabs();
  project();
  viewport?.refreshCameraClipping();
  void ensureDocumentMeshes();
}
export function addDocument(opened?: OpenedProject, dirty = false) {
  let doc = opened?.doc ?? createDocument({ title: nextTitle() });
  const existing = documentTabs.get(doc.documentId);
  if (existing) {
    const samePath =
      !opened?.path ||
      existing.path?.replaceAll('\\', '/').toLowerCase() === opened.path.replaceAll('\\', '/').toLowerCase();
    if (samePath) {
      switchDocument(doc.documentId);
      return activeTab();
    }
    // A copied project file keeps its identity; give the copy its own so both can be open.
    doc = { ...doc, documentId: ulid() };
  }
  const preferences = usePreferences.getState().value;
  const storedWorkspace = opened?.workspace ?? {
    ...createWorkspace(),
    grid: { horizontal: (preferences.grid / 20) as 1 | 0.5 | 0.25, vertical: 'plate' as const },
    snapEnabled: preferences.snap,
  };
  // A recovery snapshot may predate deletion of the context occurrence in its journal.
  let activeModelPath = storedWorkspace.activeModelPath;
  while (activeModelPath.length && !resolveContext(doc, { activeModelPath }))
    activeModelPath = activeModelPath.slice(0, -1);
  const model = resolveContext(doc, { activeModelPath })!.model;
  const storedGroup = storedWorkspace.panelState.activeGroupId;
  const activeGroupId =
    typeof storedGroup === 'string' && doc.groups[storedGroup]?.modelId === model.id ? storedGroup : null;
  const storedStep = storedWorkspace.panelState.stepId;
  const stepId = typeof storedStep === 'string' && model.steps[storedStep] ? storedStep : null;
  const workspace = {
    ...storedWorkspace,
    activeModelPath,
    selection: storedWorkspace.selection.filter(
      (path) =>
        path.length === activeModelPath.length + 1 && pathStartsWith(path, activeModelPath) && resolvePath(doc, path),
    ),
    hidden: storedWorkspace.hidden.filter((path) => resolvePath(doc, path)),
    panelState: { ...storedWorkspace.panelState, activeGroupId, stepId },
  };
  const session = new DocumentSession(doc, {
    workspace,
    savedRevision: dirty || opened?.imported ? -1 : doc.revision,
    bboxProvider: (id) => meshes.get(id)?.bboxLdu,
  });
  session.setContext({
    activeModelPath: workspace.activeModelPath,
    selection: workspace.selection,
    hidden: workspace.hidden,
    ...(typeof workspace.panelState.activeGroupId === 'string'
      ? { activeGroupId: workspace.panelState.activeGroupId }
      : {}),
    ...(typeof workspace.panelState.stepId === 'string' ? { stepId: workspace.panelState.stepId } : {}),
  });
  const tab: DocumentTab = {
    ...(opened
      ? {
          openingCamera: {
            saved: hasSavedCamera(workspace.camera),
            imported: opened.imported,
            touched: false,
            meshesReady: false,
          },
        }
      : {}),
    session,
    path: opened?.path ?? null,
    assets: opened?.assets ?? {},
    readOnly: opened?.readOnly ?? false,
    lastRecovery: null,
    pending: Promise.resolve(),
    started: false,
    ...(opened?.preservation ? { preservation: opened.preservation } : {}),
  };
  documentTabs.set(doc.documentId, tab);
  switchDocument(doc.documentId);
  trackTab(tab);
  refreshTabs();
  return tab;
}
export async function removeDocument(id: string, createIfEmpty = true) {
  const tab = documentTabs.get(id);
  if (!tab) return;
  endReview(id);
  tab.dispose?.();
  await tab.pending.catch(() => undefined);
  if (tab.started) await window.brickloop.recoveryClose(id);
  if (documentTabs.size === 1 && createIfEmpty) addDocument();
  if (documentSession === tab.session) {
    const next = [...documentTabs.keys()].find((key) => key !== id);
    if (next) switchDocument(next);
  }
  // Window shutdown has approved closing the last tab. React subscriptions and
  // background effects must stop while their active document still exists.
  if (documentTabs.size === 1 && !createIfEmpty) unmountDocumentRenderer?.();
  documentTabs.delete(id);
  if (documentTabs.size) refreshTabs();
}
function check<T>(result: Result<T>): result is { ok: true; value: T } {
  if (!result.ok)
    useDocumentStore.setState({
      error: i18n.t(result.error.code === 'CYCLE' ? 'structure.cycle' : 'editor.operationFailed'),
    });
  return result.ok;
}
function selectionCenter(): Vec3 | null {
  const bounds = viewport?.selectionBounds(documentSession.workspace.selection);
  return bounds ? [(bounds[0] + bounds[3]) / 2, (bounds[1] + bounds[4]) / 2, (bounds[2] + bounds[5]) / 2] : null;
}
function primaryMatrix() {
  const path = documentSession.workspace.selection.at(-1);
  return path ? resolvePath(previewDocument(documentSession), path)?.worldMatrix : undefined;
}
function syncSettings() {
  const state = useDocumentStore.getState(),
    matrix = primaryMatrix();
  const pivot =
    state.pivot === 'connector'
      ? (useAssemblyStore.getState().pivot?.connector.frame.origin ?? selectionCenter())
      : state.pivot === 'primary' && matrix
        ? ([matrix[12]!, matrix[13]!, matrix[14]!] as const)
        : selectionCenter();
  viewport?.setEditorSettings({
    tool: state.tool,
    space: state.space,
    horizontal: state.horizontal,
    vertical: state.vertical,
    angle:
      state.pivot === 'connector'
        ? typeof useAssemblyStore.getState().pivot?.connector.rotation === 'number'
          ? Number(useAssemblyStore.getState().pivot!.connector.rotation)
          : 0
        : state.angle,
    pivot,
    primaryMatrix: matrix ? Array.from(matrix) : null,
  });
}
function syncPlacement() {
  const state = useDocumentStore.getState(),
    color = useLibraryStore.getState().currentColor;
  const mesh = state.placement && meshes.get(state.placement.part.id);
  if (state.clipboardPlacement) {
    viewport?.setPlacement(state.clipboardPlacement.preview);
    return;
  }
  viewport?.setPlacement(
    state.placement && mesh && color
      ? { partId: state.placement.part.id, mesh, color, rotation: Array.from(state.placement.rotation) }
      : null,
  );
}
function project() {
  if (!viewport) return;
  const workspace = documentSession.workspace;
  viewport.syncDocument(
    reviewFor(documentSession.document.documentId)?.mode === 'before'
      ? reviewFor(documentSession.document.documentId)!.before
      : documentSession.document,
    useDocumentStore.getState().stepViewing
      ? {
          ...workspace,
          selection: [],
          panelState: { ...workspace.panelState, stepViewing: true, stepId: currentStepId() },
        }
      : workspace,
    useLibraryStore.getState().allColors,
  );
  updateAssembly(
    documentSession.isPreviewing ? documentSession.transactionBase : documentSession.document,
    documentSession.workspace,
    viewport,
  );
  syncSettings();
  syncPlacement();
  syncReviewViewport();
  finishOpeningCamera();
}
let projectedReview: ReturnType<typeof buildReviewOverlay> | null = null;
let reviewData: {
  review: NonNullable<ReturnType<typeof reviewFor>>;
  document: BrkDocument;
  viewport: Viewport;
} | null = null;
export function reviewTargets(key: string) {
  return projectedReview?.targets.get(key) ?? [];
}
function syncReviewViewport() {
  if (!viewport) return;
  const review = reviewFor(documentSession.document.documentId);
  if (!review) {
    if (reviewData || projectedReview) viewport.setReview(null);
    reviewData = null;
    projectedReview = null;
    return;
  }
  if (
    !reviewData ||
    reviewData.review.diff !== review.diff ||
    reviewData.review.states !== review.states ||
    reviewData.document !== documentSession.document ||
    reviewData.viewport !== viewport
  ) {
    projectedReview = buildReviewOverlay(review, documentSession.document, meshes);
  }
  if (
    reviewData?.review === review &&
    reviewData.document === documentSession.document &&
    reviewData.viewport === viewport
  )
    return;
  reviewData = { review, document: documentSession.document, viewport };
  if (projectedReview)
    viewport.setReview({
      ...projectedReview.overlay,
      visible: review.visible && review.mode === 'after',
      focus: review.focus ? (projectedReview.targets.get(review.focus)?.[0] ?? null) : null,
    });
}
useReviewStore.subscribe((state, previous) => {
  const id = documentSession.document.documentId;
  if (state.reviews[id] === previous.reviews[id]) return;
  const reviewBefore = state.reviews[id]?.mode === 'before';
  if (reviewBefore !== useDocumentStore.getState().reviewBefore) {
    viewport?.cancelGesture();
    documentSession.cancel();
    useDocumentStore.setState({
      reviewBefore,
      placement: null,
      clipboardPlacement: null,
      eyedropper: false,
      contextMenu: null,
    });
    project();
  } else {
    // Commit listeners run before refresh; project the new document before constructing annotations.
    if (reviewData?.document !== documentSession.document) project();
    else syncReviewViewport();
  }
});
export function refresh() {
  const state = useDocumentStore.getState();
  if (
    state.document === documentSession.document &&
    state.workspace === documentSession.workspace &&
    state.dirty === (documentSession.isDirty || activeTab().assetsDirty === true)
  )
    return;
  useDocumentStore.setState((state) => ({
    document: documentSession.document,
    workspace: documentSession.workspace,
    dirty: documentSession.isDirty || activeTab().assetsDirty === true,
    tick: state.tick + 1,
  }));
  project();
  refreshTabs();
}
export function dispatchEdit(command: Command): boolean {
  if (documentLocked() || useDocumentStore.getState().stepViewing) return false;
  if (activeTab().readOnly) {
    useDocumentStore.setState({ error: i18n.t('io.PROJECT_NEWER_VERSION') });
    return false;
  }
  const count = documentSession.workspace.selection.length;
  const kind =
    command.type === 'transform.translate'
      ? 'move'
      : command.type === 'transform.rotate'
        ? 'rotate'
        : command.type === 'transform.set'
          ? 'transform'
          : command.type === 'color.set'
            ? 'color'
            : command.type === 'edit.delete'
              ? 'delete'
              : 'add';
  const result = documentSession.dispatch({
    ...command,
    label:
      command.label ??
      (command.type.startsWith('group.') || command.type.startsWith('submodel.') || command.type.startsWith('step.')
        ? i18n.t(`desktop.commands.${command.type}.label`)
        : i18n.t(`editor.history.${kind}`, { count })),
  });
  refresh();
  return check(result);
}
export function visiblePaths(): InstancePath[] {
  const { document: doc, context, workspace } = documentSession;
  const resolved = resolveContext(doc, context);
  if (!resolved) return [];
  return orderedInstances(resolved.model)
    .filter(
      (instance) =>
        !context.activeGroupId ||
        groupAncestors(doc, instance.groupId).some((group) => group.id === context.activeGroupId),
    )
    .map((instance) => [...context.activeModelPath, instance.id])
    .filter((path) => !workspace.hidden.some((hidden) => pathStartsWith(path, hidden)));
}
export function selectPaths(paths: InstancePath[]) {
  if (documentLocked()) return;
  documentSession.setContext({ ...documentSession.context, selection: paths });
  refresh();
}
export function enterContext(path: InstancePath, groupId?: string) {
  if (documentLocked()) return;
  viewport?.cancelGesture();
  documentSession.cancel();
  documentSession.setContext({
    activeModelPath: path,
    selection: [],
    hidden: documentSession.workspace.hidden,
    ...(groupId ? { activeGroupId: groupId } : {}),
  });
  documentSession.updateWorkspace({
    panelState: { ...documentSession.workspace.panelState, activeGroupId: groupId ?? null },
  });
  refresh();
}
export function currentStepId() {
  const model = resolveContext(documentSession.document, documentSession.context)!.model;
  const id = documentSession.context.stepId;
  return id && model.steps[id] ? id : model.stepIds[0]!;
}
export function chooseStep(stepId: string) {
  if (documentLocked()) return;
  const model = resolveContext(documentSession.document, documentSession.context)!.model;
  if (!model.steps[stepId]) return;
  documentSession.setContext({ ...documentSession.context, stepId });
  documentSession.updateWorkspace({ panelState: { ...documentSession.workspace.panelState, stepId } });
  refresh();
}
export function addStep() {
  const model = resolveContext(documentSession.document, documentSession.context)!.model;
  const before = new Set(model.stepIds);
  const position = model.stepIds.indexOf(currentStepId()) + 1;
  if (!dispatchEdit({ type: 'step.add', position })) return;
  const id = resolveContext(documentSession.document, documentSession.context)!.model.stepIds.find(
    (id) => !before.has(id),
  );
  if (id) chooseStep(id);
}
export function removeStep(id = currentStepId()) {
  const model = resolveContext(documentSession.document, documentSession.context)!.model;
  const index = model.stepIds.indexOf(id);
  if (index < 0 || model.stepIds.length === 1) return;
  const target = model.stepIds[index > 0 ? index - 1 : 1]!;
  const count = expandInstances(documentSession.document).filter((row) => {
    const instance = resolvePath(
      documentSession.document,
      row.path.slice(0, documentSession.context.activeModelPath.length + 1),
    )?.instance;
    return pathStartsWith(row.path, documentSession.context.activeModelPath) && instance?.stepId === id;
  }).length;
  if (dispatchEdit({ type: 'step.remove', stepId: id, targetStepId: target })) {
    chooseStep(target);
    useDocumentStore.setState({ stepNotice: i18n.t('stepsUi.removed', { count, number: index > 0 ? index : 1 }) });
  }
}
export function toggleStepViewing(enabled = !useDocumentStore.getState().stepViewing) {
  if (documentLocked()) return;
  viewport?.cancelGesture();
  documentSession.cancel();
  generation++;
  clearAssemblyPreview();
  useDocumentStore.setState({ stepViewing: enabled, placement: null, clipboardPlacement: null, loading: false });
  project();
}
export function advanceStep(delta: number) {
  const model = resolveContext(documentSession.document, documentSession.context)!.model;
  chooseStep(
    model.stepIds[Math.max(0, Math.min(model.stepIds.length - 1, model.stepIds.indexOf(currentStepId()) + delta))]!,
  );
}

export async function startMacroPlacement(
  pkg: MacroPackage,
  mode: 'group' | 'submodel',
  name: string,
  warning: string | null,
  pointer?: { x: number; y: number },
) {
  if (documentLocked() || activeTab().readOnly) return;
  if (useDocumentStore.getState().stepViewing) toggleStepViewing(false);
  const ticket = ++generation,
    tab = activeTab();
  useDocumentStore.setState({ placement: null, clipboardPlacement: null, loading: true, error: null });
  syncPlacement();
  try {
    const parts = await modelParts(pkg.document);
    await Promise.all([...new Set(parts.map((part) => part.partId))].map(loadAssemblyPart));
    if (generation !== ticket || tab !== activeTab() || documentLocked()) return;
    for (const part of parts) {
      meshes.set(part.partId, part.mesh);
      viewport?.registerPart(part.partId, part.mesh);
    }
    const first = parts[0]!;
    useDocumentStore.setState({
      loading: false,
      clipboardPlacement: {
        data: {
          data: copySelection(
            pkg.document,
            orderedInstances(pkg.document.models[pkg.document.rootModelId]!).map((item) => [item.id]),
          ),
          assets: {},
        },
        macro: { pkg, mode, warning },
        name,
        preview: {
          partId: first.partId,
          mesh: first.mesh,
          color: first.color,
          rotation: Array.from(identity()),
          parts: parts.map((part) => ({ ...part, color: { ...part.color, alpha: 0.42 } })),
          bounds: pkg.meta.bboxLdu,
        },
      },
    });
    syncPlacement();
    syncSettings();
    if (pointer) viewport?.movePlacementPointer(pointer.x, pointer.y);
  } catch {
    if (generation === ticket) useDocumentStore.setState({ loading: false, error: i18n.t('libraryUi.previewFailed') });
  }
}
function similar(path: InstancePath, mode: SelectionMode): InstancePath[] {
  const length = documentSession.context.activeModelPath.length + 1;
  if (mode === 'connected') {
    const allowed = new Set(visiblePaths().map((p) => p.join('/')));
    return [
      ...new Map(
        connectedPaths(path)
          .map((p) => p.slice(0, length))
          .filter((p) => allowed.has(p.join('/')))
          .map((p) => [p.join('/'), p]),
      ).values(),
    ];
  }
  const target = expandInstances(documentSession.document).find((item) => pathStartsWith(item.path, path));
  if (!target) return [];
  const visible = new Set(visiblePaths().map((path) => path.join('/')));
  return [
    ...new Map(
      expandInstances(documentSession.document)
        .filter(
          (item) =>
            visible.has(item.path.slice(0, length).join('/')) &&
            !documentSession.workspace.hidden.some((hidden) => pathStartsWith(item.path, hidden)) &&
            (mode === 'type' || item.colorId === target.colorId) &&
            (mode === 'color' || item.partId === target.partId),
        )
        .map((item) => {
          const path = item.path.slice(0, length);
          return [path.join('/'), path] as const;
        }),
    ).values(),
  ];
}
function click(path: InstancePath | null, mods: PointerModifiers) {
  const state = useDocumentStore.getState();
  if (state.stepViewing) return;
  useDocumentStore.setState({ contextMenu: null });
  if (state.eyedropper) {
    const row =
      path && expandInstances(documentSession.document).find((item) => item.path.join('/') === path.join('/'));
    const color = useLibraryStore.getState().allColors.find((color) => color.id === row?.colorId);
    if (color) useLibraryStore.getState().chooseColor(color);
    useDocumentStore.setState({ eyedropper: false });
    return;
  }
  if (!path) {
    if (!mods.ctrl && !mods.shift) selectPaths([]);
    return;
  }
  if (state.selectionMode === 'default')
    selectPaths(resolveClickSelection(documentSession.document, documentSession.context, path, mods));
  else {
    const paths = similar(path, state.selectionMode);
    const current = documentSession.workspace.selection,
      keys = new Set(paths.map((p) => p.join('/')));
    selectPaths(
      mods.ctrl && paths.every((p) => current.some((s) => s.join('/') === p.join('/')))
        ? current.filter((p) => !keys.has(p.join('/')))
        : mods.ctrl || mods.shift
          ? [...new Map([...current, ...paths].map((p) => [p.join('/'), p])).values()]
          : paths,
    );
  }
}
export function enter(path: InstancePath) {
  const context = documentSession.context,
    doc = documentSession.document;
  const current = path.slice(0, context.activeModelPath.length + 1),
    resolved = resolvePath(doc, current);
  if (!resolved) return;
  {
    const ancestors = groupAncestors(doc, resolved.instance.groupId);
    const boundary = context.activeGroupId
      ? ancestors.findIndex((g) => g.id === context.activeGroupId)
      : ancestors.length;
    const group = ancestors.slice(0, boundary).at(-1);
    if (group) enterContext(context.activeModelPath, group.id);
    else if (resolved.instance.ref.kind === 'model') enterContext(current);
  }
  refresh();
}
export async function startPlacement(part: LibraryPart, pointer?: { x: number; y: number }) {
  if (useDocumentStore.getState().stepViewing) toggleStepViewing(false);
  if (documentLocked()) return;
  documentSession.cancel();
  documentSession.endMerge();
  useDocumentStore.setState({
    placement: { part, rotation: identity() },
    clipboardPlacement: null,
    loading: true,
    error: null,
    eyedropper: false,
  });
  const ticket = ++generation;
  try {
    const [{ mesh }] = await Promise.all([
      getMesh(part.id, useLibraryStore.getState().status?.pack?.id ?? 'demo'),
      loadAssemblyPart(part.id),
    ]);
    if (ticket !== generation || documentLocked()) return;
    if (!mesh.batches.length) throw new Error('Missing geometry');
    meshes.set(part.id, mesh);
    viewport?.registerPart(part.id, mesh);
    useDocumentStore.setState({ loading: false });
    syncPlacement();
    syncSettings();
    if (pointer) viewport?.movePlacementPointer(pointer.x, pointer.y);
  } catch {
    if (ticket === generation) useDocumentStore.setState({ loading: false, error: i18n.t('libraryUi.previewFailed') });
  }
}
export function chooseEditorColor(color: LibraryColor) {
  useLibraryStore.getState().chooseColor(color);
  if (useDocumentStore.getState().placement) syncPlacement();
  else if (documentSession.workspace.selection.length) dispatchEdit({ type: 'color.set', colorId: color.id });
}
export function setEditorOption<
  K extends 'tool' | 'space' | 'pivot' | 'selectionMode' | 'horizontal' | 'vertical' | 'angle',
>(key: K, value: EditorState[K]) {
  if (documentLocked()) return;
  viewport?.cancelGesture();
  documentSession.cancel();
  documentSession.endMerge();
  useDocumentStore.setState({ [key]: value });
  if (key === 'pivot' && value === 'connector') useAssemblyStore.setState({ connectors: true });
  const state = useDocumentStore.getState();
  documentSession.updateWorkspace({
    grid: {
      horizontal: (state.horizontal / 20) as 1 | 0.5 | 0.25,
      vertical: state.vertical === 8 ? 'plate' : state.vertical === 24 ? 'brick' : 'free',
    },
  });
  viewport?.setGrid({ visible: true, sizeStuds: 64, stepLdu: state.horizontal });
  refresh();
}
export function hideSelection(mode: 'hide' | 'only' | 'all') {
  if (documentLocked()) return;
  const { selection, hidden } = documentSession.workspace;
  const next =
    mode === 'all'
      ? []
      : mode === 'only'
        ? [...hidden, ...visiblePaths().filter((path) => !selection.some((p) => p.join('/') === path.join('/')))]
        : [...hidden, ...selection];
  documentSession.updateWorkspace({
    hidden: [...new Map(next.map((path) => [path.join('/'), path])).values()],
    selection: mode === 'hide' ? [] : selection,
  });
  refresh();
}
export function escapeEditor() {
  if (useDocumentStore.getState().reviewBefore) {
    updateReview(documentSession.document.documentId, { mode: 'after' });
    return;
  }
  if (documentLocked()) return;
  if (useDocumentStore.getState().stepViewing) {
    toggleStepViewing(false);
    return;
  }
  clearAssemblyPreview();
  const wasPreviewing = documentSession.isPreviewing;
  viewport?.cancelGesture();
  if (wasPreviewing) {
    documentSession.cancel();
    refresh();
    return;
  }
  if (useDocumentStore.getState().placement || useDocumentStore.getState().clipboardPlacement) {
    generation++;
    useDocumentStore.setState({ placement: null, clipboardPlacement: null, loading: false, error: null });
    syncPlacement();
    syncSettings();
    return;
  }
  if (useDocumentStore.getState().contextMenu) {
    useDocumentStore.setState({ contextMenu: null });
    return;
  }
  if (useDocumentStore.getState().eyedropper) {
    useDocumentStore.setState({ eyedropper: false });
    return;
  }
  const context = documentSession.context;
  if (context.activeGroupId) {
    enterContext(
      context.activeModelPath,
      documentSession.document.groups[context.activeGroupId]?.parentGroupId ?? undefined,
    );
  } else if (context.activeModelPath.length) {
    enterContext(context.activeModelPath.slice(0, -1));
  } else if (context.selection.length) selectPaths([]);
}
export function runEditorAction(action: string): boolean {
  const independentDocument =
    !useDocumentStore.getState().reviewBefore && ['file.new', 'file.open', 'file.nextTab'].includes(action);
  if (
    documentLocked() &&
    !independentDocument &&
    !['ai.open', 'check.run', 'view.fitAll', 'view.fitSelection'].includes(action)
  )
    return false;
  if (
    useDocumentStore.getState().stepViewing &&
    !['view.steps', 'view.fitAll', 'view.fitSelection', 'view.screenshot', 'check.run'].includes(action)
  )
    toggleStepViewing(false);
  const external = actions.get(action);
  if (external) {
    useDocumentStore.setState({ contextMenu: null });
    void Promise.resolve(external()).catch((error: unknown) =>
      useDocumentStore.setState({ error: error instanceof Error ? error.message : i18n.t('editor.operationFailed') }),
    );
    return true;
  }
  switch (action) {
    case 'view.steps':
      toggleStepViewing();
      break;
    case 'check.run':
      openChecks();
      break;
    case 'tool.snap.toggle':
      setAssemblyOption('snap', !useAssemblyStore.getState().snap);
      break;
    case 'tool.collision.toggle':
      setAssemblyOption('collision', !useAssemblyStore.getState().collision);
      break;
    case 'select.connected': {
      const path = documentSession.workspace.selection.at(-1);
      if (path) selectPaths(similar(path, 'connected'));
      break;
    }
    case 'edit.undo':
      check(documentSession.undo());
      refresh();
      break;
    case 'edit.redo':
      check(documentSession.redo());
      refresh();
      break;
    case 'edit.delete':
      dispatchEdit({ type: 'edit.delete' });
      break;
    case 'select.all':
      selectPaths(visiblePaths());
      break;
    case 'select.clear':
      selectPaths([]);
      break;
    case 'select.invert':
      selectPaths(
        visiblePaths().filter((p) => !documentSession.workspace.selection.some((s) => s.join('/') === p.join('/'))),
      );
      break;
    case 'view.hide':
      hideSelection('hide');
      break;
    case 'view.showOnly':
      hideSelection('only');
      break;
    case 'view.showAll':
      hideSelection('all');
      break;
    case 'view.fitSelection':
      viewport?.fitSelection(documentSession.workspace.selection);
      break;
    case 'view.fitAll':
      viewport?.fitAll();
      break;
    case 'select.sameColor':
    case 'select.sameType':
    case 'select.sameColorAndType': {
      const path = documentSession.workspace.selection.at(-1);
      if (path)
        selectPaths(
          similar(path, action === 'select.sameColor' ? 'color' : action === 'select.sameType' ? 'type' : 'both'),
        );
      break;
    }
    case 'transform.snapToGrid': {
      const s = useDocumentStore.getState();
      dispatchEdit({ type: action, step: [s.horizontal, s.vertical, s.horizontal] });
      break;
    }
    default:
      return false;
  }
  useDocumentStore.setState({ contextMenu: null });
  return true;
}
export const availableEditorActions = new Set([
  'view.steps',
  'check.run',
  'tool.snap.toggle',
  'tool.collision.toggle',
  'select.connected',
  'edit.undo',
  'edit.redo',
  'edit.delete',
  'select.all',
  'select.clear',
  'select.invert',
  'select.sameColor',
  'select.sameType',
  'select.sameColorAndType',
  'view.hide',
  'view.showOnly',
  'view.showAll',
  'view.fitAll',
  'view.fitSelection',
  'transform.snapToGrid',
]);
export function editorKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return;
  if (useDocumentStore.getState().reviewBefore) {
    if (event.key === 'Escape') {
      event.preventDefault();
      escapeEditor();
    } else if (shortcutCommand(event)) event.preventDefault();
    return;
  }
  if (useAssemblyStore.getState().annotation) return;
  if (document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) return;
  const command = shortcutCommand(event);
  if (command === 'ai.open' || command === 'check.run') {
    event.preventDefault();
    if (command === 'check.run') openChecks();
    else runEditorAction(command);
    return;
  }
  if (
    event.target instanceof HTMLElement &&
    event.target.closest('input,textarea,select,[contenteditable="true"], [role="separator"]')
  )
    return;
  const state = useDocumentStore.getState();
  if (!command) return;
  event.preventDefault();
  if (command === 'view.steps') {
    toggleStepViewing();
    return;
  }
  if (state.stepViewing) {
    if (command === 'rotate.left' || command === 'rotate.right') advanceStep(command === 'rotate.left' ? -1 : 1);
    else if (command === 'editor.escape') toggleStepViewing(false);
    return;
  }
  if (command === 'editor.escape') {
    escapeEditor();
    return;
  }
  if (command === 'tool.eyedropper') {
    useDocumentStore.setState({ eyedropper: !state.eyedropper });
    return;
  }
  if (['tool.select', 'tool.move', 'tool.rotate'].includes(command)) {
    setEditorOption('tool', command.slice(5) as EditorState['tool']);
    return;
  }
  if (['tool.grid1', 'tool.grid2', 'tool.grid3'].includes(command)) {
    setEditorOption('horizontal', command === 'tool.grid1' ? 20 : command === 'tool.grid2' ? 10 : 5);
    return;
  }
  const preset = command.slice(5);
  if (command.startsWith('view.') && ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'].includes(preset)) {
    viewport?.setPreset(preset as ViewPreset);
    return;
  }
  const motionKeys: Record<string, string> = {
    'move.forward': 'w',
    'move.back': 's',
    'move.left': 'a',
    'move.right': 'd',
    'move.up': 'q',
    'move.down': 'e',
    'rotate.left': 'ArrowLeft',
    'rotate.right': 'ArrowRight',
    'rotate.up': 'ArrowUp',
    'rotate.down': 'ArrowDown',
  };
  const key = motionKeys[command.replace(/Fine$/, '')];
  if (!key) {
    runEditorAction(command);
    return;
  }
  if (!usePreferences.getState().value.mergeKeyboard) documentSession.endMerge();
  const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key);
  const forward = viewport?.cameraForward() ?? [0, 0, 1];
  if (arrow) {
    event.preventDefault();
    const axis: Vec3 = key === 'ArrowLeft' || key === 'ArrowRight' ? [0, -1, 0] : horizontalAxes(forward).right;
    const degrees =
      (command.endsWith('Fine') ? 45 : state.angle || 5) * (key === 'ArrowLeft' || key === 'ArrowDown' ? -1 : 1);
    if (state.clipboardPlacement) {
      useDocumentStore.setState({
        clipboardPlacement: {
          ...state.clipboardPlacement,
          preview: {
            ...state.clipboardPlacement.preview,
            rotation: Array.from(
              multiply(rotationAxisAngle(axis, degrees), new Float64Array(state.clipboardPlacement.preview.rotation)),
            ),
          },
        },
      });
      syncPlacement();
    } else if (state.placement) {
      useDocumentStore.setState({
        placement: {
          ...state.placement,
          rotation: multiply(rotationAxisAngle(axis, degrees), state.placement.rotation),
        },
      });
      syncPlacement();
    } else if (
      state.pivot === 'connector' &&
      useAssemblyStore.getState().pivot &&
      useAssemblyStore.getState().pivotMate
    ) {
      const joint = useAssemblyStore.getState().pivot!.connector,
        mate = useAssemblyStore.getState().pivotMate!;
      const step = typeof joint.rotation === 'number' ? joint.rotation : state.angle || 5;
      const direction = key === 'ArrowLeft' || key === 'ArrowDown' ? -1 : 1;
      const rotationAxis = joint.type.startsWith('hinge') ? joint.frame.axis : axis;
      const delta = multiply(
        translation(joint.frame.origin),
        multiply(
          rotationAxisAngle(rotationAxis, step * direction),
          translation(joint.frame.origin.map((v) => -v) as [number, number, number]),
        ),
      );
      const constrained = constrainConnectorRotation(joint, mate, delta),
        primary = primaryMatrix();
      if (primary) dispatchEdit({ type: 'transform.set', transform: toLDraw(multiply(constrained, primary)) });
    } else if (documentSession.workspace.selection.length)
      dispatchEdit({
        type: 'transform.rotate',
        axis,
        degrees,
        pivot:
          state.pivot === 'primary'
            ? { kind: 'primaryOrigin' }
            : { kind: 'selectionCenter', point: selectionCenter() ?? [0, 0, 0] },
        space: 'world',
        input: 'keyboard',
        mergeKey: 'arrows',
      });
    return;
  }
  const delta = keyboardDelta(key, forward, state.horizontal, state.vertical);
  if (delta && !state.placement && !state.clipboardPlacement && documentSession.workspace.selection.length) {
    event.preventDefault();
    dispatchEdit({ type: 'transform.translate', delta, space: 'world', input: 'keyboard', mergeKey: 'movement' });
  }
}
export function bindViewport(next: Viewport | null) {
  if (viewport) captureWorkspace();
  stopCameraInteraction?.();
  viewport = next;
  next?.setEdgeMode(usePreferences.getState().value.edgeMode);
  if (!next) return;
  for (const [id, mesh] of meshes) next.registerPart(id, mesh);
  if (!activeTab().openingCamera && !hasSavedCamera(documentSession.workspace.camera)) next.setPreset('iso');
  else restoreTabCamera();
  stopCameraInteraction = next.onCameraInteraction(() => {
    const pending = activeTab().openingCamera;
    if (pending) pending.touched = true;
  });
  let dragPrimary = identity();
  let dragRows: ReturnType<typeof expandInstances> = [];
  const renderDrag = (delta: ReturnType<typeof identity>) => {
    const result = executeCommand(documentSession.transactionBase, documentSession.context, {
      type: 'transform.set',
      transform: toLDraw(multiply(delta, dragPrimary)),
    });
    if (check(result)) check(documentSession.preview(result.value.ops));
    viewport?.syncDocument(
      previewDocument(documentSession),
      documentSession.workspace,
      useLibraryStore.getState().allColors,
    );
    syncSettings();
  };
  let dragSession = documentSession;
  let dragTicket = 0;
  let dragPending: Promise<void> = Promise.resolve();
  let placementTicket = 0;
  const handlers: EditorEvents = {
    supportPlane,
    connectorClick(marker) {
      if (useDocumentStore.getState().tool !== 'rotate' || useDocumentStore.getState().pivot !== 'connector')
        return false;
      if (!['hinge.click', 'ball', 'ball.socket', 'hinge.plain'].includes(marker.connector.type)) return false;
      if (!documentSession.context.selection.some((path) => pathStartsWith(marker.ref.path, path)))
        selectPaths([marker.ref.path.slice(0, documentSession.context.activeModelPath.length + 1)]);
      chooseConnectorPivot(marker);
      syncSettings();
      return true;
    },
    async placementPreview(raw, fallback, mods, pointer) {
      const state = useDocumentStore.getState(),
        options = useAssemblyStore.getState();
      if (!state.placement && !state.clipboardPlacement) return fallback;
      const ticket = ++placementTicket;
      const parts = state.clipboardPlacement?.preview.parts;
      const selection = parts
        ? parts.map((part, index) => ({
            path: ['$preview', String(index)],
            partId: part.partId,
            matrix: Array.from(
              multiply(new Float64Array(raw), part.transform ? fromLDraw(part.transform) : identity()),
            ),
            fallback: Array.from(
              multiply(new Float64Array(fallback), part.transform ? fromLDraw(part.transform) : identity()),
            ),
          }))
        : [{ path: ['$preview'], partId: state.placement!.part.id, matrix: raw, fallback }];
      const result = await solvePreview({
        selection,
        primaryPath: selection[0]!.path,
        enabled: options.snap && !mods.alt,
        collision: options.collision,
        continuous: mods.shift,
        pointer,
      });
      if (
        ticket !== placementTicket ||
        state.placement !== useDocumentStore.getState().placement ||
        state.clipboardPlacement !== useDocumentStore.getState().clipboardPlacement
      )
        return null;
      showPreview(result);
      const matrix = result.transforms[0]?.transform;
      return matrix && parts?.[0]
        ? Array.from(
            multiply(new Float64Array(matrix), invert(parts[0].transform ? fromLDraw(parts[0].transform) : identity())),
          )
        : (matrix ?? fallback);
    },
    click,
    enter,
    box(paths, mods) {
      let selection = mods.shift || mods.ctrl ? documentSession.workspace.selection : [];
      for (const path of paths)
        selection = resolveClickSelection(documentSession.document, { ...documentSession.context, selection }, path, {
          shift: !mods.ctrl,
          ctrl: mods.ctrl,
        });
      selectPaths(selection);
    },
    place(transform, continuous) {
      if (documentLocked() || useDocumentStore.getState().stepViewing || activeTab().readOnly) return;
      if (previewBlocked()) {
        useDocumentStore.setState({ error: i18n.t('connectUi.blocked') });
        return;
      }
      const clip = useDocumentStore.getState().clipboardPlacement;
      if (clip?.macro) {
        const context = resolveContext(documentSession.document, documentSession.context);
        if (!context) return;
        const ops = macroInsertOps(clip.macro.pkg, documentSession.document, {
          as: clip.macro.mode,
          name: clip.name,
          context: documentSession.context,
          stepId: currentStepId(),
          transform: toLDraw(multiply(invert(context.matrix), fromLDraw(transform))),
        });
        const result = documentSession.applyExternal(ops, i18n.t('macroUi.insertHistory', { name: clip.name }), 'ui');
        if (check(result)) {
          const selection = ops.flatMap((op) =>
            op.type === 'instance.add'
              ? op.items
                  .filter((item) => item.modelId === context.model.id)
                  .map((item) => [...documentSession.context.activeModelPath, item.instance.id])
              : [],
          );
          documentSession.setContext({ ...documentSession.context, selection });
          if (!continuous) useDocumentStore.setState({ clipboardPlacement: null });
        }
        refresh();
        syncPlacement();
        clearAssemblyPreview();
        return;
      }
      if (clip) {
        const rotation = fromLDraw(transform);
        rotation[12] = 0;
        rotation[13] = 0;
        rotation[14] = 0;
        const data: ClipboardData = {
          ...clip.data.data,
          instances: clip.data.data.instances.map((item) => ({
            ...item,
            worldMatrix: toLDraw(
              multiply(
                multiply(translation(clip.data.data.anchor), rotation),
                multiply(
                  translation(clip.data.data.anchor.map((v) => -v) as [number, number, number]),
                  fromLDraw(item.worldMatrix),
                ),
              ),
            ),
          })),
        };
        activeTab().assets = { ...activeTab().assets, ...clip.data.assets };
        if (
          dispatchEdit({
            type: 'edit.paste',
            clipboard: data,
            placement: { position: transform.slice(0, 3) as [number, number, number] },
          }) &&
          !continuous
        )
          useDocumentStore.setState({ clipboardPlacement: null });
        syncPlacement();
        syncSettings();
        clearAssemblyPreview();
        return;
      }
      const { placement, loading } = useDocumentStore.getState(),
        color = useLibraryStore.getState().currentColor;
      if (!placement || !color || loading) return;
      const context = resolveContext(documentSession.document, documentSession.context);
      if (!context) return;
      const local = toLDraw(multiply(invert(context.matrix), fromLDraw(transform)));
      if (
        dispatchEdit({
          type: 'part.add',
          partId: placement.part.id,
          colorId: color.id,
          transform: local,
          stepId: currentStepId(),
        }) &&
        !continuous
      )
        useDocumentStore.setState({ placement: null });
      syncPlacement();
      syncSettings();
      clearAssemblyPreview();
    },
    dragStart() {
      if (documentLocked()) return;
      dragSession = documentSession;
      dragTicket++;
      dragPrimary = primaryMatrix() ?? identity();
      dragRows = expandInstances(documentSession.document).filter((row) =>
        documentSession.context.selection.some((path) => pathStartsWith(row.path, path)),
      );
      check(
        documentSession.begin(
          i18n.t(`editor.history.${useDocumentStore.getState().tool === 'move' ? 'move' : 'rotate'}`, {
            count: documentSession.workspace.selection.length,
          }),
        ),
      );
    },
    dragPreview(delta, fallback = delta, mods, pointer) {
      if (documentLocked()) return;
      if (!documentSession.isPreviewing) return;
      const ticket = ++dragTicket,
        options = useAssemblyStore.getState(),
        state = useDocumentStore.getState();
      let rawDelta: ReturnType<typeof identity> = new Float64Array(delta);
      if (state.tool === 'rotate' && state.pivot === 'connector' && options.pivot && options.pivotMate) {
        rawDelta = constrainConnectorRotation(options.pivot.connector, options.pivotMate, rawDelta);
        fallback = Array.from(rawDelta);
      }
      const selected = dragRows;
      const primary =
        selected.find((row) => pathStartsWith(row.path, documentSession.context.selection.at(-1) ?? [])) ?? selected[0];
      if (!primary) return;
      // Show the current grid candidate immediately; a superseded Worker response
      // must not make a busy scene appear frozen until pointer-up.
      renderDrag(new Float64Array(fallback));
      const selection = selected.map((row) => ({
        path: row.path,
        partId: row.partId,
        matrix: Array.from(multiply(rawDelta, row.worldMatrix)),
        fallback: Array.from(multiply(new Float64Array(fallback), row.worldMatrix)),
      }));
      dragPending = solvePreview({
        selection,
        primaryPath: primary.path,
        enabled: state.tool === 'move' && options.snap && !mods?.alt,
        collision: options.collision,
        continuous: mods?.shift ?? false,
        handleDrag: true,
        ...(pointer ? { pointer } : {}),
      })
        .then((preview) => {
          if (
            documentLocked() ||
            ticket !== dragTicket ||
            documentSession !== dragSession ||
            !documentSession.isPreviewing
          )
            return;
          const main = preview.transforms.find((row) => row.path.join('/') === primary.path.join('/'));
          if (!main) return;
          const solvedDelta = multiply(new Float64Array(main.transform), invert(primary.worldMatrix));
          renderDrag(solvedDelta);
          showPreview(preview);
        })
        .catch(() => useDocumentStore.setState({ error: i18n.t('connectUi.failed') }));
    },
    dragEnd(cancel) {
      if (documentLocked()) return;
      if (cancel) {
        dragTicket++;
        documentSession.cancel();
        clearAssemblyPreview(false);
        refresh();
        project();
        return;
      }
      const endingTicket = dragTicket,
        endingSession = dragSession;
      void dragPending.then(() => {
        if (documentLocked() || endingTicket !== dragTicket || endingSession !== documentSession) return;
        if (previewBlocked()) {
          documentSession.cancel();
          useDocumentStore.setState({ error: i18n.t('connectUi.blocked') });
        } else if (documentSession.isPreviewing) check(documentSession.commit());
        clearAssemblyPreview(false);
        refresh();
        project();
      });
    },
    context(path, x, y) {
      if (path && !documentSession.workspace.selection.some((p) => pathStartsWith(path, p)))
        click(path, { ctrl: false, shift: false, alt: false });
      useDocumentStore.setState({ contextMenu: { x, y } });
    },
  };
  next.setEditorEvents(handlers);
  project();
  next.refreshCameraClipping();
  if (import.meta.env.MODE === 'test')
    void import('./editor-test-api').then((module) => module.installEditorTestApi(next));
}
/** Loads geometry for documents supplied by a later import adapter using only catalog/mesh APIs. */
let meshGeneration = 0;
export async function reloadEditorGeometry() {
  meshGeneration++;
  meshes.clear();
  clearMeshCache();
  await ensureDocumentMeshes();
  useDocumentStore.setState((state) => ({ tick: state.tick + 1 }));
}
const meshLoads = new Map<DocumentSession, Promise<void>>();
export function ensureDocumentMeshes(): Promise<void> {
  const session = documentSession;
  const existing = meshLoads.get(session);
  if (existing) return existing;
  const task = loadDocumentMeshes(session);
  meshLoads.set(session, task);
  void task.finally(() => meshLoads.delete(session)).catch(() => undefined);
  return task;
}
async function loadDocumentMeshes(session: DocumentSession) {
  const ticket = meshGeneration;
  // Submit the placeholder scene before cached definitions begin CPU/GPU preparation.
  await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  if (import.meta.env.MODE === 'test') {
    const { waitForTestMeshes } = await import('./editor-test-api');
    await waitForTestMeshes();
  }
  const review = reviewFor(session.document.documentId);
  const reviewParts = review ? expandInstances(review.before).map((item) => item.partId) : [];
  const ids = [...new Set([...expandInstances(session.document).map((item) => item.partId), ...reviewParts])];
  retainMeshes(
    [...documentTabs.values()].flatMap((tab) => [
      ...expandInstances(tab.session.document).map((row) => row.partId),
      ...expandInstances(reviewFor(tab.session.document.documentId)?.before ?? tab.session.document).map(
        (row) => row.partId,
      ),
    ]),
  );
  const current = () => ticket === meshGeneration && session === documentSession;
  let loaded = 0,
    cursor = 0;
  let yieldedAt = performance.now();
  const failed: string[] = [];
  let displayTimer: ReturnType<typeof setTimeout> | undefined;
  const display = () => {
    displayTimer = undefined;
    if (!current()) return;
    useDocumentStore.setState({ meshProgress: { loaded, total: ids.length }, missingMeshes: [...failed] });
    if (!session.isPreviewing) project();
  };
  if (current()) useDocumentStore.setState({ meshProgress: { loaded: 0, total: ids.length }, missingMeshes: [] });
  await Promise.all(
    Array.from({ length: Math.min(16, ids.length) }, async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++]!;
        let mesh = meshes.get(id);
        for (let attempt = 0; !mesh && attempt < 3; attempt++) {
          try {
            mesh = (await getMesh(id as LibraryPart['id'], useLibraryStore.getState().status?.pack?.id ?? 'demo')).mesh;
          } catch {
            if (attempt === 2) failed.push(id);
          }
        }
        if (ticket !== meshGeneration) continue;
        if (mesh) {
          meshes.set(id, mesh);
          viewport?.registerPart(id, mesh);
          reviewData = null;
          loaded++;
        }
        displayTimer ??= setTimeout(display, 160);
        if (performance.now() - yieldedAt > 6) {
          yieldedAt = performance.now();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    }),
  );
  if (displayTimer) clearTimeout(displayTimer);
  const pending = documentTabs.get(session.document.documentId)?.openingCamera;
  if (pending && ticket === meshGeneration) pending.meshesReady = true;
  if (current()) {
    display();
    viewport?.refreshCameraClipping();
    useDocumentStore.setState({ meshProgress: null, missingMeshes: failed });
  }
}
export async function copyEditor(cut = false) {
  const tab = activeTab(),
    session = tab.session;
  if (!session.workspace.selection.length) return;
  const data = copySelection(session.document, session.workspace.selection);
  await window.brickloop.clipboardWrite({ data, assets: tab.assets });
  if (cut && session === documentSession) dispatchEdit({ type: 'edit.cut' });
}
export async function pasteEditor(preview = false, payload?: ClipboardPayload, pointer?: { x: number; y: number }) {
  if (documentLocked()) return;
  const tab = activeTab();
  const value = payload ?? (await window.brickloop.clipboardRead());
  if (!value || activeTab() !== tab || documentLocked()) return;
  if (!preview) {
    tab.assets = { ...tab.assets, ...value.assets };
    dispatchEdit({
      type: 'edit.paste',
      clipboard: value.data,
      placement: { position: viewport?.placementPosition() ?? [0, 0, 0] },
    });
    return;
  }
  const temporary = new DocumentSession(createDocument());
  const result = temporary.dispatch({ type: 'edit.paste', clipboard: value.data, placement: { position: [0, 0, 0] } });
  if (!check(result)) return;
  const rows = expandInstances(temporary.document),
    colors = useLibraryStore.getState().allColors;
  const parts: PartInstance[] = [],
    bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const row of rows) {
    let mesh = meshes.get(row.partId);
    if (!mesh) {
      try {
        mesh = (await getMesh(row.partId as LibraryPart['id'], useLibraryStore.getState().status?.pack?.id ?? 'demo'))
          .mesh;
        meshes.set(row.partId, mesh);
      } catch {
        continue;
      }
    }
    const color = colors.find((c) => c.id === row.colorId) ?? colors[0];
    if (!color) continue;
    parts.push({
      partId: row.partId as LibraryPart['id'],
      mesh,
      color: { ...color, alpha: 0.42 },
      transform: toLDraw(row.worldMatrix) as Transform,
    });
    const box = mesh.bboxLdu;
    for (const x of [box[0], box[3]])
      for (const y of [box[1], box[4]])
        for (const z of [box[2], box[5]]) {
          const p = transformPoint(row.worldMatrix, [x, y, z]);
          for (let i = 0; i < 3; i++) {
            bounds[i] = Math.min(bounds[i]!, p[i]!);
            bounds[i + 3] = Math.max(bounds[i + 3]!, p[i]!);
          }
        }
  }
  if (!parts[0] || activeTab() !== tab) return;
  const first = parts[0];
  useDocumentStore.setState({
    placement: null,
    clipboardPlacement: {
      data: value,
      name: i18n.t('structure.selection'),
      preview: {
        partId: first.partId,
        mesh: first.mesh,
        color: first.color,
        rotation: Array.from(identity()),
        parts,
        bounds: bounds as [number, number, number, number, number, number],
      },
    },
  });
  syncPlacement();
  syncSettings();
  if (pointer) viewport?.movePlacementPointer(pointer.x, pointer.y);
}
