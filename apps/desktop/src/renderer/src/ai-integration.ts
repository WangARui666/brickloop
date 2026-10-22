import { formatAiFailure } from './ai-failure';
import { expandInstances, pathStartsWith, toLDraw } from '@brickloop/core';
import { renderOffscreen, themeColor } from '@brickloop/viewport';
import { encodeModelImage } from '@brickloop/ai';
import type { ImageBlock } from '@brickloop/ai';
import type { RgbaImage, RGB } from '@brickloop/mosaic';
import {
  documentSession,
  activeTab,
  documentTabs,
  refresh,
  ensureDocumentMeshes,
  meshes,
  switchDocument,
  addDocument,
  registerEditorActions,
  useDocumentStore,
  setDocumentLock,
} from './document-store';
import { useShellStore } from './store';
import { checkAiDocument, summarizeAiDocument } from './ai-check';
import { getMesh } from './mesh-client';
import { useLibraryStore } from './library-store';
import {
  configureTaskRuntime,
  createTask,
  discardTask,
  finishTask,
  mergeTask,
  receiveTask,
  taskCopies,
  useTaskStore,
} from './ai-task-runtime';
import { scheduleTaskPreview } from './task-preview';
import { completedTurnHistory } from './ai-history';
import { buildShortcutStatistics, createLocalTurn, runLocalPrecheck, runShortcutStatistics } from './ai-local-precheck';
import type { BomResult } from '@brickloop/io';
import {
  contextHistory,
  contextTurns,
  parseContextMarks,
  serializeContextMarks,
  saveContextCheckpoint,
  retainedEditContext,
  clearContextMarks,
  turnContextStatus,
} from './ai-context';
import type { ContextMarks } from './ai-context';
import { contextAnalysisCache } from './ai-context-cache';
import { loadAssemblyPart } from './assembly-store';
import type { EditorHostServices } from './ai-editor-host';
import { RendererEditorHost, success } from './ai-editor-host';
import type { ImageTaskRequest, TurnRequest, SavedTurn } from '../../shared/ai-api';
import { receiveAiEvent, clearModelLiveness, flushAiStream, useAiStore } from './ai-store';
import type { PartId } from '@brickloop/catalog';
import { runBuildScriptWorker } from './buildscript-client';
import { editorError } from '../../shared/editor-error';
import { workflowProgress } from './workflow-progress';
import { prepareReferenceImage } from './reference-image';
import type { EditorTestApi } from './editor-test-api';
export function buildCatalog() {
  // Main caches by CatalogService identity, including background catalog refresh and pack activation.
  return window.brickloop.buildScriptCatalog();
}

export function encodeImage(image: RgbaImage, background?: 'viewport', pngBase64?: string): ImageBlock {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d')!;
  try {
    let color: RGB | undefined;
    if (background === 'viewport') {
      const surface = document.querySelector<HTMLElement>('.brickloop-viewport') ?? document.documentElement;
      context.fillStyle = themeColor(surface, 'viewport-bottom');
      context.fillRect(0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      color = [pixel[0]!, pixel[1]!, pixel[2]!];
    }
    return encodeModelImage(
      image,
      (pixels, mime, quality) => {
        context.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
        return canvas.toDataURL(mime, quality).split(',')[1]!;
      },
      color,
      pngBase64,
    );
  } finally {
    canvas.width = canvas.height = 1;
  }
}
export async function decodeImage(image: ImageBlock): Promise<RgbaImage> {
  const bitmap = new Image();
  bitmap.src = `data:${image.mime};base64,${image.base64}`;
  await bitmap.decode();
  if (bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width < 1 || bitmap.height < 1)
    throw new Error('IMAGE_SIZE');
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const result = {
    width: canvas.width,
    height: canvas.height,
    data: new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
  };
  canvas.width = canvas.height = 1;
  return result;
}
let testSummarizeCalls = 0;
const hostServices: EditorHostServices = {
  buildCatalog,
  runBuildScript: runBuildScriptWorker,
  active: activeTab,
  lock: setDocumentLock,
  changed: () => {
    refresh();
    void ensureDocumentMeshes();
  },
  library: {
    catalogSearch: (...args) => window.brickloop.catalogSearch(...args),
    catalogPart: (...args) => window.brickloop.catalogPart(...args),
    catalogColors: () => window.brickloop.catalogColors(),
  },
  assemblyPart: (id) => loadAssemblyPart(id),
  catalog: () => window.brickloop.assemblyCatalog(),
  check: checkAiDocument,
  summarize: async (doc, modelPath) => {
    if (import.meta.env.MODE === 'test') testSummarizeCalls++;
    const start = performance.now();
    const result = await summarizeAiDocument(doc, modelPath);
    // A task starts from a clone of its base. Its unchanged revision can share the
    // analysis with that base; scoped summaries and speculative edits cannot.
    const copy = [...taskCopies.values()].find(
      (copy) => copy.working.session.document === doc && doc.revision === copy.base.revision,
    );
    const source = copy?.base ?? doc;
    if (!modelPath?.length && [...documentTabs.values()].some((tab) => tab.session.document === source))
      contextAnalysisCache.remember(source, result, performance.now() - start);
    return result;
  },
  async render(doc, input) {
    // Load the supplied document, including parts that only exist in a task copy.
    for (const id of new Set(expandInstances(doc).map((r) => r.partId))) {
      if (!meshes.has(id)) await getMesh(id as PartId, useLibraryStore.getState().status?.pack?.id ?? 'demo');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const colors = (await window.brickloop.catalogColors()).all;
    const instances = expandInstances(doc)
      .filter((r) => pathStartsWith(r.path, input.modelPath ?? []))
      .map((r) => {
        const mesh = meshes.get(r.partId),
          color = colors.find((c) => c.id === r.colorId);
        if (!mesh || !color) throw new Error('RENDER_ASSET_MISSING');
        return {
          partId: r.partId as PartId,
          mesh,
          color,
          transform: toLDraw(r.worldMatrix) as [
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
          ],
          highlighted: r.path.some((id) => input.highlightInstanceIds?.includes(id)),
        };
      });
    const images = await renderOffscreen(instances, colors, {
      views: input.views.map((v) => (v === 'isometric' ? 'iso' : v)),
      width: input.width,
      height: input.height,
      transparent: input.transparent,
    });
    return {
      images: images.map((img) => encodeImage(img, undefined, img.png.split(',')[1]!)),
      rgba: images,
    };
  },
  decode: decodeImage,
  encode: encodeImage,
  prepareReferenceImage,
  bom: (doc, modelPath) =>
    window.brickloop.projectBom(
      {
        doc,
        workspace: { ...documentSession.workspace, ...(modelPath ? { activeModelPath: modelPath } : {}) },
        assets: activeTab().assets,
      },
      { scope: modelPath ? { kind: 'model', path: modelPath } : { kind: 'project' } },
    ),
  exportIo: (tab) =>
    window.brickloop.projectExport({
      project: { doc: tab.session.document, workspace: tab.session.workspace, assets: tab.assets },
      format: 'io',
      unit: 'ldu',
      grouping: 'instance',
      includeHidden: true,
      includeEdges: false,
      scope: { kind: 'project' },
      thumbnails: {},
    }),
  async documents(method, input) {
    if (method === 'list_documents')
      return success({
        documents: [...documentTabs.values()].map((tab) => ({
          id: tab.session.document.documentId,
          name: tab.session.document.meta.title,
          active: tab === activeTab(),
        })),
        activeDocumentId: documentSession.document.documentId,
      });
    if (method === 'open_document') {
      const file = (input as { path: string }).path;
      if (!/\.(brkl|io|ldr|mpd)$/i.test(file))
        return { ok: false, code: 'UNSUPPORTED_FORMAT', message: 'UNSUPPORTED_FORMAT' };
      const projects = await window.brickloop.projectOpen(file);
      for (const project of projects) addDocument(project);
      if (!projects.length) return { ok: false, code: 'OPEN_CANCELLED', message: 'OPEN_CANCELLED' };
      await ensureDocumentMeshes();
      return success({
        documentId: documentSession.document.documentId,
        name: documentSession.document.meta.title,
        active: true,
      });
    }
    const id = (input as { documentId: string }).documentId;
    if (!documentTabs.has(id)) return { ok: false, code: 'DOCUMENT_NOT_FOUND', message: 'DOCUMENT_NOT_FOUND' };
    switchDocument(id);
    return success({ documentId: id });
  },
};
// Offscreen rendering yields between views. Serialize jobs and admit them at an idle
// opportunity so concurrent image tasks cannot all prepare GPU scenes in one frame.
const renderDocument = hostServices.render;
let renderQueue = Promise.resolve(),
  renderedAt = 0;
hostServices.render = (doc, input) => {
  const job = renderQueue.then(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, 500 - (performance.now() - renderedAt))));
    await new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 1000 }));
    try {
      return await renderDocument(doc, input);
    } finally {
      renderedAt = performance.now();
    }
  });
  renderQueue = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
};
export const rendererHost = new RendererEditorHost(hostServices);
/** Bind the real validate implementation to this tab without reserving or copying it. */
export function precheckLocalTurn(local: NonNullable<SavedTurn['local']>, tab = activeTab()) {
  if (local.shortcut === 'palette') return Promise.resolve(false);
  const host = new RendererEditorHost({
    ...hostServices,
    active: () => tab,
    check: (...args) => {
      if (import.meta.env.MODE === 'test' && sessionStorage.getItem('brickloop:test:precheck-failure'))
        throw new Error('ENGINE_UNAVAILABLE: local precheck fixture');
      return hostServices.check(...args);
    },
  });
  return runLocalPrecheck((input) => host.request('validate', input, 'ai'), local.shortcut, local.paths);
}
export function prepareShortcutStatistics(
  shortcut: 'palette' | 'explain',
  paths: string[][] | null,
  t: Parameters<typeof buildShortcutStatistics>[4],
  language: string,
  tab = activeTab(),
) {
  const doc = tab.session.document;
  const started = performance.now();
  const summarizeCallsBefore = testSummarizeCalls;
  return runShortcutStatistics(
    async (check, signal) => {
      if (import.meta.env.MODE === 'test' && sessionStorage.getItem('brickloop:test:statistics-failure'))
        throw new Error('STATISTICS_UNAVAILABLE: local fixture');
      if (import.meta.env.MODE === 'test') {
        const delay = Number(sessionStorage.getItem('brickloop:test:statistics-delay-ms'));
        if (delay > 0) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              signal.removeEventListener('abort', finish);
              resolve();
            };
            const timer = setTimeout(finish, delay);
            signal.addEventListener('abort', finish, { once: true });
          });
          check();
        }
      }
      return buildShortcutStatistics(
        shortcut,
        doc,
        paths,
        {
          bom: async (doc) => (await hostServices.bom(doc)) as BomResult,
          colors: () => window.brickloop.catalogColors(),
        },
        t,
        language,
        check,
      );
    },
    () => activeTab() === tab && tab.session.document === doc,
  ).then((result) => {
    if (import.meta.env.MODE === 'test')
      sessionStorage.setItem(
        'brickloop:test:statistics-result',
        JSON.stringify({
          shortcut,
          scope: paths ? 'selection' : 'document',
          elapsedMs: performance.now() - started,
          summarizeCalls: testSummarizeCalls - summarizeCallsBefore,
          attached: !!result?.attachment,
        }),
      );
    return result;
  });
}
function appendHistory(tab: ReturnType<typeof activeTab>, saved: unknown) {
  const previous = tab.assets['ai/history.jsonl'];
  const bytes = new TextEncoder().encode(
    `${previous ? new TextDecoder().decode(previous) : ''}${JSON.stringify(saved)}\n`,
  );
  tab.assets = { ...tab.assets, 'ai/history.jsonl': bytes };
  tab.assetsDirty = true;
  refresh();
}
export function saveLocalTurn(user: string, text: string, local: NonNullable<SavedTurn['local']>, tab = activeTab()) {
  const turn = createLocalTurn(tab.session.document.documentId, user, text, local);
  if (useAiStore.getState().snapshot?.settings.history !== false) appendHistory(tab, turn);
  useAiStore.setState((state) => ({ turns: [...state.turns, turn] }));
  return turn;
}
configureTaskRuntime(hostServices);
async function storeImages(value: unknown, tab: ReturnType<typeof activeTab>): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((v) => storeImages(v, tab)));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.type === 'image' && typeof record.base64 === 'string' && typeof record.mime === 'string') {
    const bytes = Uint8Array.from(atob(record.base64), (c) => c.charCodeAt(0));
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    tab.assets[`assets/images/${hash}`] = bytes;
    return { type: 'image', resource: hash, mime: record.mime };
  }
  return Object.fromEntries(
    await Promise.all(
      Object.entries(record)
        .filter(([key]) => key !== 'providerState')
        .map(async ([key, val]) => [key, await storeImages(val, tab)]),
    ),
  );
}
function restoreImages(value: unknown, tab: ReturnType<typeof activeTab>): unknown {
  if (Array.isArray(value)) return value.map((v) => restoreImages(v, tab));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.type === 'image' && typeof record.resource === 'string') {
    const bytes = tab.assets[`assets/images/${record.resource}`];
    if (!bytes) return { type: 'text', text: '[image unavailable]' };
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return { type: 'image', base64: btoa(binary), mime: record.mime };
  }
  return Object.fromEntries(Object.entries(record).map(([key, val]) => [key, restoreImages(val, tab)]));
}
const turnCache = new WeakMap<ReturnType<typeof activeTab>, { bytes: Uint8Array | undefined; turns: SavedTurn[] }>();
export function readTurns(tab = activeTab()): SavedTurn[] {
  const bytes = tab.assets['ai/history.jsonl'];
  const cached = turnCache.get(tab);
  if (cached?.bytes === bytes && cached) return cached.turns;
  const turns: SavedTurn[] = [];
  let damaged = false;
  for (const line of (bytes ? new TextDecoder().decode(bytes) : '').split('\n').filter((line) => line.trim())) {
    try {
      const turn = restoreImages(JSON.parse(line), tab) as SavedTurn;
      if (
        !turn ||
        typeof turn.id !== 'string' ||
        typeof turn.user !== 'string' ||
        typeof turn.text !== 'string' ||
        !Array.isArray(turn.images) ||
        !Array.isArray(turn.events)
      )
        throw new Error('INVALID_TURN');
      turns.push({ ...turn, documentId: tab.session.document.documentId });
    } catch {
      damaged = true;
    }
  }
  if (damaged) console.warn('Ignored invalid ai/history.jsonl rows');
  turnCache.set(tab, { bytes, turns });
  return turns;
}
const marksCache = new WeakMap<ReturnType<typeof activeTab>, { bytes: Uint8Array | undefined; marks: ContextMarks }>();
export function readContextMarks(tab = activeTab()): ContextMarks {
  if (!tab) return parseContextMarks(undefined).marks;
  const bytes = tab.assets['ai/context.json'];
  const cached = marksCache.get(tab);
  if (cached?.bytes === bytes && cached) return cached.marks;
  const { marks, warning } = parseContextMarks(bytes ? new TextDecoder().decode(bytes) : undefined);
  if (warning) console.warn('Missing or invalid ai/context.json; using empty context marks');
  marksCache.set(tab, { bytes, marks });
  return marks;
}
function writeContextMarks(tab: ReturnType<typeof activeTab>, marks: ContextMarks) {
  const bytes = new TextEncoder().encode(serializeContextMarks(marks));
  tab.assets = { ...tab.assets, 'ai/context.json': bytes };
  marksCache.set(tab, { bytes, marks });
  tab.assetsDirty = true;
  refresh();
}
export function documentTurns(tab = activeTab()): SavedTurn[] {
  return [
    ...new Map(
      [
        ...readTurns(tab),
        ...useAiStore.getState().turns.filter((turn) => turn.documentId === tab.session.document.documentId),
      ].map((turn) => [turn.id, turn]),
    ).values(),
  ];
}
export function startNewConversation(documentId: string): boolean {
  const tab = documentTabs.get(documentId);
  const tasks = useTaskStore.getState().tasks;
  if (
    !tab ||
    Object.values(tasks).some((task) => task.documentId === documentId && ['queued', 'running'].includes(task.status))
  )
    return false;
  const turns = documentTurns(tab),
    marks = readContextMarks(tab);
  if (!contextTurns(turns, marks, tasks).length) return false;
  writeContextMarks(
    tab,
    clearContextMarks(
      marks,
      turns.map((turn) => turn.id),
    ),
  );
  return true;
}
import { openSelectionAsk } from './ask-store';
let initialized = false;
const contextSnapshots = new Map<string, { turns: SavedTurn[]; marks: ContextMarks }>();
function taskEditContext(taskId: string) {
  const copy = taskCopies.get(taskId);
  return copy ? retainedEditContext(copy.base, copy.working.session.document) : undefined;
}
export function initializeAi() {
  if (initialized) return;
  initialized = true;
  if (import.meta.env.MODE === 'test') {
    // The viewport installs/replaces the test API after AI initialization.
    // Keep its state read synchronous without flushing normal React store reads.
    let api: EditorTestApi;
    Object.defineProperty(window, 'brickloopEditorTest', {
      configurable: true,
      enumerable: true,
      get: () => api,
      set: (next: typeof api) => {
        const read = next.aiState;
        next.aiState = () => {
          flushAiStream();
          return read();
        };
        api = next;
      },
    });
  }
  registerEditorActions({
    'ai.open': () => {
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        focused.closest('.viewport, .properties-dock, .structure-panel') &&
        openSelectionAsk()
      )
        return;
      useShellStore.setState({ rightCollapsed: false, rightTab: 'ai', rightWidth: 380 });
      useAiStore.setState((s) => ({ focusComposer: s.focusComposer + 1 }));
    },
  });
  window.brickloop.onEditorRequest((request) => {
    void (async () => {
      try {
        const taskId = request.taskId;
        const task = taskId ? useTaskStore.getState().tasks[taskId] : undefined;
        const tab = task ? documentTabs.get(task.documentId) : undefined;
        let value: unknown;
        if (taskId && request.method === 'task.create') {
          const input = request.input as {
            kind: 'chat' | 'image' | 'selection';
            request: TurnRequest | ImageTaskRequest;
          };
          value = createTask(taskId, input.kind, input.request);
        } else if (taskId && request.method === 'task.discard') {
          discardTask(taskId);
          if (tab && documentTurns(tab).some((turn) => turn.id === taskId)) {
            const marks = readContextMarks(tab);
            writeContextMarks(tab, { ...marks, discardedTurnIds: [...new Set([...marks.discardedTurnIds, taskId])] });
          }
        } else if (taskId && request.method === 'task.failed') {
          taskCopies.delete(taskId);
          scheduleTaskPreview();
        } else if (taskId && request.method === 'task.finish') {
          const input = request.input as { stopped: boolean; failed?: boolean };
          const context = taskEditContext(taskId);
          useAiStore.setState((state) => ({
            turns: state.turns.map((turn) => (turn.id === taskId && context ? { ...turn, context } : turn)),
          }));
          value = await finishTask(taskId, input.stopped, input.failed);
          const snapshot = contextSnapshots.get(taskId);
          contextSnapshots.delete(taskId);
          const turn = tab && documentTurns(tab).find((entry) => entry.id === taskId);
          if (
            tab &&
            snapshot &&
            turn?.result?.checkpoint &&
            turnContextStatus(turn, readContextMarks(tab)).included &&
            ['merged', 'pending_merge'].includes(String(value))
          ) {
            const saved = saveContextCheckpoint([...snapshot.turns, turn], snapshot.marks, turn.result.checkpoint);
            if (saved.checkpoint) writeContextMarks(tab, { ...readContextMarks(tab), checkpoint: saved.checkpoint });
          }
        } else if (taskId && request.method === 'task.merge') value = await mergeTask(taskId);
        else if (request.method === 'history.read') {
          if (tab && taskId) {
            const marks = readContextMarks(tab);
            const turns = contextTurns(documentTurns(tab), marks, useTaskStore.getState().tasks);
            contextSnapshots.set(taskId, { turns, marks });
            value = contextHistory(turns, marks);
          } else value = [];
        } else if (request.method === 'history.append') {
          if (tab && task?.status !== 'discarded') {
            const input = request.input as SavedTurn;
            const context = taskId ? taskEditContext(taskId) : undefined;
            const saved = await storeImages(
              { ...input, history: completedTurnHistory(input), ...(context ? { context } : {}) },
              tab,
            );
            if (
              documentTabs.get(task!.documentId) === tab &&
              useTaskStore.getState().tasks[taskId!]?.status !== 'discarded'
            ) {
              appendHistory(tab, saved);
            }
          }
        } else if (taskId) {
          const copy = taskCopies.get(taskId);
          if (!copy) throw new Error('TASK_CLOSED');
          value = await copy.host.request(request.method, request.input, request.owner);
        } else {
          if (useDocumentStore.getState().reviewBefore && ['reserve', 'beginTransaction'].includes(request.method))
            throw new Error('DOCUMENT_BUSY');
          value = await rendererHost.request(request.method, request.input, request.owner);
        }

        await window.brickloop.editorReply({ id: request.id, value });
      } catch (error) {
        const failure = editorError(error, request.method);
        await window.brickloop.editorReply(
          request.method === 'run_build_script'
            ? { id: request.id, value: failure }
            : { id: request.id, error: failure.code },
        );
      }
    })();
  });
  const progress = workflowProgress((id, state, updatedAt) => {
    if (useTaskStore.getState().tasks[id]?.status === 'discarded') return;
    useAiStore.setState((s) => {
      const previous = s.workflows[id];
      if (!previous) return s;
      const workflow = { ...previous, state, updatedAt };
      return { workflows: { ...s.workflows, [id]: workflow }, ...(s.workflow?.taskId === id ? { workflow } : {}) };
    });
  });
  window.brickloop.onAiNotice((notice) => {
    const taskId =
      notice.type === 'event' || notice.type === 'workflow'
        ? notice.turnId
        : notice.type === 'failure'
          ? notice.taskId
          : undefined;
    if (taskId && useTaskStore.getState().tasks[taskId]?.status === 'discarded') return;
    if (notice.type === 'workflow' && notice.event.type === 'state') {
      progress.push(notice.turnId, notice.event.state);
      return;
    }
    if (notice.type === 'workflow' && notice.event.type === 'agent') {
      const event = notice.event.event;
      receiveAiEvent(notice.turnId, event, notice.stallNoticeMs, true);
      // Planning text deltas are not displayed. Do not clone the workflow and notify
      // every useSyncExternalStore subscriber for each token in the JSON plan.
      return;
    }
    progress.flush();
    if (notice.type !== 'event' && notice.type !== 'workflow')
      flushAiStream(
        notice.type === 'task' ? notice.task.taskId : notice.type === 'failure' ? notice.taskId : undefined,
      );
    if (notice.type === 'state') useAiStore.setState({ snapshot: notice.snapshot });
    if (notice.type === 'task') {
      receiveTask(notice.task);
      if (!['running', 'queued'].includes(notice.task.status)) clearModelLiveness(notice.task.taskId);
    }
    if (notice.type === 'approval') useAiStore.setState({ approval: notice.approval });
    if (notice.type === 'failure')
      useAiStore.setState({
        error: notice.error || notice.reason ? formatAiFailure(notice.error, notice.reason) : notice.key,
      });
    if (notice.type === 'event') receiveAiEvent(notice.turnId, notice.event, notice.stallNoticeMs);
    if (notice.type === 'workflow') {
      const event = notice.event;
      if (event.type === 'finished') clearModelLiveness(notice.turnId);
      useAiStore.setState((s) => {
        const previous = s.workflows[notice.turnId];
        const workflow = previous
          ? {
              ...previous,
              ...(event.type === 'plan'
                ? {
                    plan: {
                      ...event.plan,
                      ...(event.paletteColorIds
                        ? {
                            colorReview: { repairs: event.colorRepairs, paletteColorIds: event.paletteColorIds },
                          }
                        : {}),
                    },
                    viewWarnings: event.repairs.filter((r) => r.startsWith('view_estimate')),
                    boxRepairs: event.boxRepairs,
                  }
                : {}),
              ...(event.type === 'comparison' ? { comparison: event.comparison } : {}),
              ...(event.type === 'round'
                ? { rounds: [...(previous.rounds ?? []), event.round], script: event.script }
                : {}),
            }
          : null;
        return {
          ...(workflow ? { workflows: { ...s.workflows, [notice.turnId]: workflow } } : {}),
          ...(workflow?.documentId === documentSession.document.documentId ? { workflow } : {}),
          turns:
            event.type === 'finished'
              ? s.turns.map((turn) =>
                  turn.id === notice.turnId
                    ? { ...turn, report: event.report, ...(notice.cost ? { cost: notice.cost } : {}) }
                    : turn,
                )
              : s.turns,
        };
      });
    }
  });
  useDocumentStore.subscribe((state, previous) => {
    if (state.activeId !== previous.activeId) {
      const stored = useAiStore.getState();
      const loaded = readTurns().filter((turn) => !stored.turns.some((v) => v.id === turn.id));
      const imageTask = Object.values(useTaskStore.getState().tasks).find(
        (v) => v.documentId === state.activeId && v.kind === 'image' && v.status === 'running',
      );
      const workflow = imageTask ? (stored.workflows[imageTask.taskId] ?? null) : null;
      useAiStore.setState({ turns: [...stored.turns, ...loaded], workflow });
      const latest = Object.values(useTaskStore.getState().tasks)
        .reverse()
        .find((v) => v.documentId === state.activeId && ['running', 'queued', 'pending_merge'].includes(v.status));
      useTaskStore.setState({ previewId: latest?.taskId ?? null });
      scheduleTaskPreview();
    }
    if (state.reviewBefore !== previous.reviewBefore) scheduleTaskPreview();
  });
  useTaskStore.subscribe(() => {
    const tasks = Object.values(useTaskStore.getState().tasks);
    const image = tasks.find(
      (v) => v.documentId === documentSession.document.documentId && v.kind === 'image' && v.status === 'running',
    );
    useAiStore.setState({
      running: tasks.some((v) => v.status === 'running'),
      workflow: image ? (useAiStore.getState().workflows[image.taskId] ?? null) : null,
    });
  });
  useShellStore.subscribe((s) => {
    if (!s.rightCollapsed && s.rightTab === 'ai' && useTaskStore.getState().unread)
      useTaskStore.setState({ unread: false });
  });
  void window.brickloop
    .aiSnapshot()
    .then((snapshot) => useAiStore.setState({ snapshot }))
    .catch(() => useAiStore.setState({ error: 'aiUi.failed' }));
}
