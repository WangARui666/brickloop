import {
  executeCommand,
  identity,
  orderedInstances,
  toLDraw,
  ulid,
  serializeDocument,
  expandInstances,
} from '@brickloop/core';
import { animationTestApi } from './animation-test-api';
import type { Instance, Op } from '@brickloop/core';
import type { Viewport } from '@brickloop/viewport';
import type { ExportFormat } from '../../shared/project-api';
import {
  documentSession as session,
  ensureDocumentMeshes,
  selectPaths,
  useDocumentStore,
  dispatchEdit,
  documentTabs,
  enterContext,
  switchDocument,
  runEditorAction,
  activeTab,
  bindViewport,
} from './document-store';
import { useProjectUi, openDocuments, saveDocument, runFileTask } from './project-controller';
import { useShellStore } from './store';
import { useLibraryStore } from './library-store';
import { assemblyReady, refreshChecks, useAssemblyStore, setAssemblyOption } from './assembly-store';
import { useAiStore, startImageTask } from './ai-store';
import { rendererHost } from './ai-integration';
import { createModuleWorker } from './module-worker';
import { macroThumbnailMetrics } from './model-thumbnail';
import { usePreferences, savePreferences } from './preferences-store';
import { planInstructions } from '@brickloop/instructions';
import { createInstructionHost } from './instruction-host';
import { meshMetrics } from './mesh-client';
import { previewDocument } from '../../../../../packages/core/src/history/transform-preview';
import { reviewFor, updateReview, endReview } from './review-store';
import { applyReview, canUndoReview, undoReview } from './review-actions';
import { useTaskStore, previewTask, resolveConflict, taskCopies } from './ai-task-runtime';

let meshGate: Promise<void> | undefined;
let releaseMeshes: (() => void) | undefined;
let waitingMeshes = 0;
export async function waitForTestMeshes() {
  if (!meshGate) return;
  waitingMeshes++;
  try {
    await meshGate;
  } finally {
    waitingMeshes--;
  }
}

/** Loaded only by the --mode test build. Production exposes no document mutation bridge. */
export function installEditorTestApi(viewport: Viewport) {
  const api = {
    requestRender: viewport.requestRender,
    captureViewport: async () => Array.from(await viewport.capture({ hideGrid: true })),
    holdMeshes: () => {
      releaseMeshes?.();
      meshGate = new Promise<void>((resolve) => {
        releaseMeshes = resolve;
      });
    },
    releaseMeshes: () => {
      releaseMeshes?.();
      meshGate = undefined;
      releaseMeshes = undefined;
    },
    openingCamera: () => ({ pending: activeTab().openingCamera ?? null, waitingMeshes }),
    cameraVisibility: viewport.contentVisibility,
    // Exercise projects opened before a viewport can be bound without relying on GPU startup speed.
    bindCameraViewport: (bound: boolean) => bindViewport(bound ? viewport : null),
    animation: animationTestApi,
    // Corrupt only the view snapshot to exercise the root boundary; the document session and journal stay intact.
    crashRenderer: async () => {
      await Promise.all([...documentTabs.values()].map((tab) => tab.pending));
      useDocumentStore.setState({ document: null! });
    },
    probeWorker: (url: string) =>
      new Promise<unknown>((resolve, reject) => {
        const worker = createModuleWorker(url);
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error('Worker probe timed out'));
        }, 10_000);
        worker.onmessage = (event) => {
          clearTimeout(timer);
          worker.terminate();
          resolve(event.data);
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(event.message));
        };
      }),
    ask: () => ({
      overlays: [...document.querySelectorAll<HTMLElement>('[data-ask-anchor]')].map((node) => ({
        kind: node.dataset.testid,
        taskId: node.dataset.taskId,
        rect: node.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number },
      })),
      scopes: [...taskCopies].map(([id, copy]) => ({
        id,
        scope: 'scope' in copy.request ? copy.request.scope : undefined,
      })),
    }),
    tasks: () => Object.values(useTaskStore.getState().tasks),
    savedHistory: (id: string) => new TextDecoder().decode(documentTabs.get(id)?.assets['ai/history.jsonl']),
    taskMerge: (id: string) => window.brickloop.aiTaskAction(id, 'merge'),
    taskDiscard: (id: string) => window.brickloop.aiTaskAction(id, 'discard'),
    taskPreview: previewTask,
    taskResolve: resolveConflict,
    previewCounts: () => {
      const data = document.querySelector<HTMLElement>('.brickloop-viewport')!.dataset;
      return {
        parts: Number(data.taskPreviewParts ?? 0),
        removed: Number(data.taskPreviewRemoved ?? 0),
        updates: Number(data.taskPreviewUpdates ?? 0),
      };
    },
    async concurrency(value: number) {
      const snapshot = await window.brickloop.aiSnapshot();
      await window.brickloop.aiSaveSettings({ ...snapshot.settings, concurrency: value });
    },
    camera: () => viewport.getCamera(),
    restoreCamera: viewport.restoreCamera,
    zoomReview: (factor: number) => {
      const camera = viewport.getCamera();
      viewport.restoreCamera(
        {
          ...camera,
          position: camera.position.map(
            (value, axis) => camera.target[axis]! + (value - camera.target[axis]!) * factor,
          ) as [number, number, number],
        },
        camera.span * factor,
      );
    },
    orbit: (angle: number) => {
      const camera = viewport.getCamera(),
        radius = Math.hypot(camera.position[0] - camera.target[0], camera.position[2] - camera.target[2]);
      viewport.restoreCamera(
        {
          ...camera,
          position: [
            camera.target[0] + Math.cos(angle) * radius,
            camera.position[1],
            camera.target[2] + Math.sin(angle) * radius,
          ],
        },
        camera.span,
      );
    },
    review: () => {
      const review = reviewFor(session.document.documentId);
      return review
        ? {
            transactionId: review.transactionId,
            beforeRevision: review.before.revision,
            afterRevision: review.after.revision,
            items: review.diff.instances.map((change) => ({ ...change, state: review.states[change.key] })),
            structure: review.diff.structure,
            conflicts: review.conflicts,
            resolvedConflicts: review.resolvedConflicts,
            newIssues: review.newIssues,
            mode: review.mode,
            visible: review.visible,
            canUndo: canUndoReview(),
            diffMs: review.diffMs,
            firstScreenMs: review.firstScreenMs,
          }
        : null;
    },
    reviewApply: applyReview,
    reviewUndo: undoReview,
    reviewMode: (mode: 'before' | 'after') => updateReview(session.document.documentId, { mode }),
    reviewVisible: (visible: boolean) => updateReview(session.document.documentId, { visible }),
    reviewEnd: () => endReview(session.document.documentId),
    applyOps: (ops: Op[], source: 'ui' | 'ai' | 'mcp' = 'ui') => session.applyExternal(ops, 'E2E transaction', source),
    meshMetrics: () => ({ ...meshMetrics }),
    metrics: () => viewport.metrics(),
    preferences: () => usePreferences.getState().value,
    savePreferences,
    pdf: () => usePreferences.setState({ pdf: true }),
    about: () => usePreferences.setState({ about: true }),
    settings: (page: string) => {
      usePreferences.setState({ page });
      useAiStore.setState({ settingsOpen: true });
    },
    async instructionFrames() {
      const plan = planInstructions(session.document, {
        paper: 'A4-landscape',
        stepsPerPage: 4,
        includeCover: false,
        includeBom: false,
        dpi: 150,
      });
      const host = createInstructionHost(
        session.document,
        plan,
        useLibraryStore.getState().allColors,
        useLibraryStore.getState().status?.pack?.id ?? 'demo',
        new AbortController().signal,
        false,
      );
      const result: { modelId: string; step: number; png: number[] }[] = [];
      for (const step of plan.steps)
        result.push({
          modelId: step.modelId,
          step: step.stepIndex,
          png: Array.from(
            await host.renderStep({
              modelId: step.modelId,
              stepIndex: step.stepIndex,
              inheritedColorId: step.inheritedColorId,
              highlightNew: true,
              widthPx: 640,
              heightPx: 480,
            }),
          ),
        });
      return result;
    },
    macroThumbnailMetrics: () => ({ ...macroThumbnailMetrics }),
    imageStart: startImageTask,
    aiState: () => useAiStore.getState(),
    modelSummary: () => rendererHost.request('get_model_summary', {}, 'ai'),
    aiTool: (name: string, input: unknown) => rendererHost.request(name, input, 'ai'),
    mcpTool: (name: string, input: unknown) => rendererHost.request(name, input, 'mcp'),
    assembly: () => useAssemblyStore.getState(),
    assemblyReady: async () => {
      await assemblyReady();
      await refreshChecks();
    },
    assemblyOption: setAssemblyOption,
    meshesReady: ensureDocumentMeshes,
    select: selectPaths,
    enter: enterContext,
    switch: switchDocument,
    action: runEditorAction,
    normalized: () => serializeDocument(session.document),
    expanded: () =>
      expandInstances(session.document).map((row) => ({
        partId: row.partId,
        colorId: row.colorId,
        path: row.path,
        matrix: Array.from(row.worldMatrix),
      })),
    open: openDocuments,
    save: (saveAs = false) => runFileTask(() => saveDocument(saveAs)),
    showExport: (format: ExportFormat) => useProjectUi.setState({ exportFormat: format }),
    structure: () => useShellStore.getState().setRightTab('structure'),
    flush: async () => {
      await Promise.all([...documentTabs.values()].map((tab) => tab.pending));
    },
    prepareClose: () => {
      for (const tab of documentTabs.values()) {
        tab.assetsDirty = false;
        tab.session.cancel();
        tab.session.markSaved();
      }
    },
    snapshot: () => ({
      document: session.document,
      workspace: session.workspace,
      history: session.history,
      redo: session.redoHistory,
      dirty: session.isDirty,
      previewing: session.isPreviewing,
      state: useDocumentStore.getState(),
      metrics: viewport.metrics(),
    }),
    project: viewport.projectPoint,
    preset: viewport.setPreset,
    handles: viewport.handlePoints,
    command: dispatchEdit,
    markSaved: () => {
      session.markSaved();
      selectPaths(session.workspace.selection);
    },
    async seed(count: number) {
      const model = session.document.models[session.document.rootModelId]!;
      session.setContext({ activeModelPath: [], selection: [] });
      session.updateWorkspace({ hidden: [] });
      const items = Array.from({ length: count }, (_, i) => {
        const transform = toLDraw(identity());
        transform[0] = (i % 100) * 100;
        transform[2] = Math.floor(i / 100) * 60;
        transform[1] = -24;
        const instance: Instance = {
          id: ulid(),
          ref: { kind: 'part', partId: 'ld:3001' },
          colorId: 'c:bright-red',
          transform,
          stepId: model.stepIds[0]!,
          groupId: null,
        };
        return { modelId: model.id, instance };
      });
      const ops: Op[] = [];
      if (Object.keys(model.instances).length)
        ops.push({
          type: 'instance.remove',
          items: Object.keys(model.instances).map((instanceId) => ({ modelId: model.id, instanceId })),
        });
      ops.push({ type: 'instance.add', items });
      const result = session.applyExternal(ops, 'Performance fixture', 'import');
      if (!result.ok) throw new Error(result.error.messageKey);
      await ensureDocumentMeshes();
      viewport.fitAll();
    },
    async benchmark(count: number, moving = 1) {
      await api.seed(count);
      const model = session.document.models[session.document.rootModelId]!;
      selectPaths(
        orderedInstances(model)
          .slice(0, Math.min(count, moving))
          .map((instance) => [instance.id]),
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      session.begin('Benchmark drag');
      const times: number[] = [],
        updates: number[] = [];
      let previous = performance.now();
      for (let frame = 0; frame < 90; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const now = performance.now();
        if (frame > 10) times.push(now - previous);
        previous = now;
        const start = performance.now();
        const result = executeCommand(session.transactionBase, session.context, {
          type: 'transform.translate',
          delta: [frame * 5, 0, 0],
        });
        if (!result.ok) throw new Error(result.error.messageKey);
        const preview = session.preview(result.value.ops);
        if (!preview.ok) throw new Error(preview.error.messageKey);
        viewport.syncDocument(previewDocument(session), session.workspace, useLibraryStore.getState().allColors);
        // Match gestures: panels publish the committed document, not each transient matrix.
        updates.push(performance.now() - start);
      }
      const commitStart = performance.now();
      const committed = session.commit();
      const commitMs = performance.now() - commitStart;
      if (!committed.ok) throw new Error(committed.error.messageKey);
      times.sort((a, b) => a - b);
      updates.sort((a, b) => a - b);
      const { batches, matrixWrites, allocations } = viewport.metrics();
      return {
        count,
        moving,
        frames: times.length,
        p50Ms: times[Math.floor(times.length * 0.5)],
        p95Ms: times[Math.floor(times.length * 0.95)],
        maxMs: times.at(-1),
        updateP50Ms: updates[45],
        updateP95Ms: updates[Math.floor(updates.length * 0.95)],
        updateMaxMs: updates.at(-1),
        commitMs,
        backend: viewport.backend,
        metrics: { batches, matrixWrites, allocations },
      };
    },
  };
  Object.assign(window, { brickloopEditorTest: api });
  return api;
}
export type EditorTestApi = ReturnType<typeof installEditorTestApi>;
