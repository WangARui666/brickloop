import workerUrl from './assembly.worker?worker&url';
import { createModuleWorker } from './module-worker';
import { create } from 'zustand';
import { expandInstances, pathStartsWith, transformPoint, transformDirection } from '@brickloop/core';
import type { BrkDocument, InstancePath, Workspace } from '@brickloop/core';
import type { ConnectionEdge, WorldConnector, Connector } from '@brickloop/connect';
import { instantiateConnectors } from '@brickloop/connect';
import type { Issue, CheckOptions, CollisionResult } from '@brickloop/collide';
import type { Viewport, ConnectorMarker } from '@brickloop/viewport';
import type { AssemblyPart } from '../../shared/assembly-api';
import type { AssemblyCatalog } from '../../shared/assembly-api';
import type { LibraryPart } from '../../shared/library-api';
import type { AssemblyEngine, PreviewRequest, PreviewResult } from './assembly-engine';
import { i18n, useShellStore } from './store';

interface AssemblyState {
  lastChecks: Record<string, { at: string; count: number; revision: number; scope: string }>;
  snap: boolean;
  collision: boolean;
  policy: 'warn' | 'block';
  connectors: boolean;
  connectorScope: 'selection' | 'visible';
  scope: 'project' | 'currentModel' | 'selection';
  visibleOnly: boolean;
  groundIsFixed: boolean;
  issues: Issue[];
  checking: boolean;
  error: string | null;
  hitCount: number;
  chosen: PreviewResult['chosen'];
  timings: PreviewResult['timing'][];
  maintenance: boolean;
  annotation: LibraryPart | null;
  pivot: ConnectorMarker | null;
  pivotMate: Connector | null;
  ready: boolean;
}
export const useAssemblyStore = create<AssemblyState>(() => ({
  lastChecks: {},
  snap: true,
  collision: true,
  policy: 'warn',
  connectors: false,
  connectorScope: 'selection',
  scope: 'project',
  visibleOnly: true,
  groundIsFixed: false,
  issues: [],
  checking: false,
  error: null,
  hitCount: 0,
  chosen: null,
  timings: [],
  maintenance: false,
  annotation: null,
  pivot: null,
  pivotMate: null,
  ready: false,
}));
export const assemblyParts = new Map<string, AssemblyPart>();
export const partNames = new Map<string, LibraryPart>();
const loads = new Map<string, Promise<AssemblyPart>>();
const uploaded = new Map<string, AssemblyPart>();
let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
function rpc<T>(kind: 'sync' | 'preview' | 'check', value: unknown): Promise<T> {
  if (!worker) {
    worker = createModuleWorker(workerUrl);
    worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const task = pending.get(event.data.id);
      pending.delete(event.data.id);
      if (event.data.error) task?.reject(new Error(event.data.error));
      else task?.resolve(event.data.result);
    };
    worker.onerror = () => {
      for (const task of pending.values()) task.reject(new Error('Assembly worker unavailable'));
      pending.clear();
      useAssemblyStore.setState({ error: i18n.t('connectUi.failed'), ready: false });
    };
  }
  return new Promise<T>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: (value) => resolve(value as T), reject });
    worker!.postMessage({ id, kind, value });
  });
}
let viewport: Viewport | null = null;
let document: BrkDocument | undefined, workspace: Workspace | undefined;
let graph: ReturnType<AssemblyEngine['sync']> = { markers: [], edges: [], components: [] };
/** Only expose a graph that belongs to this exact document snapshot. */
export function animationConnections(doc: BrkDocument) {
  return synced === doc && useAssemblyStore.getState().ready
    ? graph.edges.map((edge) => ({ a: [...edge.a.path], b: [...edge.b.path] }))
    : [];
}
let synced: BrkDocument | undefined;
let syncedHidden = '';
let syncing: Promise<void> = Promise.resolve();
let revision = 0;
let checkRevision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let committedCollision: CollisionResult | undefined;
let catalog: AssemblyCatalog | undefined;
export async function reloadAssemblyCatalog(clearGeometry = false) {
  await syncing.catch(() => undefined);
  if (clearGeometry) {
    await Promise.allSettled(loads.values());
    assemblyParts.clear();
    partNames.clear();
    uploaded.clear();
    loads.clear();
  }
  catalog = undefined;
  synced = undefined;
  if (document && workspace) updateAssembly(document, workspace, viewport);
  await syncing;
}
let previewCollision: CollisionResult | undefined;
let previewMarkers: ConnectorMarker[] = [];
let movingMarkers: ConnectorMarker[] = [];
let movingPaths = new Set<string>();
let displayGraph: typeof graph | undefined;
let displayKey = '';
let displayMarkers: ConnectorMarker[] = [];
const key = (path: readonly string[]) => path.join('/');
const refKey = (value: WorldConnector['ref']) => JSON.stringify(value);

export async function loadAssemblyPart(id: string): Promise<AssemblyPart> {
  const found = assemblyParts.get(id);
  if (found) return found;
  let task = loads.get(id);
  if (!task) {
    task = Promise.all([window.brickloop.assemblyPart(id), window.brickloop.catalogPart(id as LibraryPart['id'])]).then(
      ([part, name]) => {
        assemblyParts.set(id, part);
        if (name) partNames.set(id, name);
        return part;
      },
    );
    loads.set(id, task);
    void task.finally(() => loads.delete(id)).catch(() => undefined);
  }
  return task;
}
export function replaceAssemblyPart(id: string, part: AssemblyPart) {
  assemblyParts.set(id, part);
  synced = undefined;
  if (document && workspace) updateAssembly(document, workspace, viewport);
}
const peerPaths = new Map<string, Map<string, InstancePath>>();
const rowsByPath = new Map<string, string>();
function indexGraphLabels(edges: ConnectionEdge[]) {
  peerPaths.clear();
  for (const edge of edges)
    for (const [a, b] of [
      [edge.a, edge.b],
      [edge.b, edge.a],
    ] as const) {
      const peers = peerPaths.get(refKey(a)) ?? new Map<string, InstancePath>();
      peers.set(key(b.path), b.path);
      peerPaths.set(refKey(a), peers);
    }
}
function markerLabel(marker: WorldConnector) {
  const language = useShellStore.getState().language === 'zh-CN' ? 'nameZh' : 'nameEn';
  const name = partNames.get(rowsByPath.get(key(marker.ref.path)) ?? '');
  const peers = [...(peerPaths.get(refKey(marker.ref))?.values() ?? [])];
  return `${i18n.t(`connectorTypes.${marker.connector.type.replaceAll('.', '_')}`)} · ${name?.[language] ?? i18n.t('connectUi.previewPart')} · ${peers.length ? i18n.t('connectUi.connectedTo', { part: peers.map((path) => partNames.get(rowsByPath.get(key(path)) ?? '')?.[language] ?? key(path)).join('、') }) : i18n.t('connectUi.unconnected')}`;
}
let expandRows: ReturnType<typeof expandInstances> = [];
export function drawAssembly() {
  const state = useAssemblyStore.getState();
  const nextKey = JSON.stringify([
    state.connectors,
    state.connectorScope,
    workspace?.selection,
    workspace?.hidden,
    [...movingPaths],
    useShellStore.getState().language,
  ]);
  if (displayGraph !== graph || displayKey !== nextKey) {
    displayGraph = graph;
    displayKey = nextKey;
    const connected = new Set(graph.edges.flatMap((edge) => [refKey(edge.a), refKey(edge.b)]));
    displayMarkers = state.connectors
      ? graph.markers
          .filter(
            (marker) =>
              !movingPaths.has(key(marker.ref.path)) &&
              !workspace?.hidden.some((path) => pathStartsWith(marker.ref.path, path)) &&
              (state.connectorScope === 'visible' ||
                workspace?.selection.some((path) => pathStartsWith(marker.ref.path, path))),
          )
          .map((marker) => ({
            ...marker,
            label: markerLabel(marker),
            connected: connected.has(refKey(marker.ref)),
          }))
      : [];
  }
  viewport?.setConnectors(displayMarkers, [...previewMarkers, ...(state.connectors ? movingMarkers : [])]);
  const collision = state.collision ? (previewCollision ?? committedCollision) : undefined;
  const hits = collision?.pairs.filter((pair) => pair.status === 'hit').flatMap((pair) => [pair.a, pair.b]) ?? [];
  const unknown = [
    ...(collision?.unknownPaths ?? []),
    ...(collision?.pairs.filter((pair) => pair.status === 'unknown').flatMap((pair) => [pair.a, pair.b]) ?? []),
  ];
  const unique = (paths: InstancePath[]) => [...new Map(paths.map((path) => [key(path), path])).values()];
  const hitPaths = unique(hits);
  viewport?.setCollisions(
    hitPaths.filter((path) => path[0] !== '$preview'),
    unique(unknown),
    hitPaths.some((path) => path[0] === '$preview'),
  );
  if (state.hitCount !== hitPaths.length) useAssemblyStore.setState({ hitCount: hitPaths.length });
}
export function updateAssembly(doc: BrkDocument, state: Workspace, view: Viewport | null) {
  const previousWorkspace = workspace;
  viewport = view;
  workspace = state;
  document = doc;
  const hiddenKey = JSON.stringify(state.hidden);
  if (synced === doc && syncedHidden === hiddenKey) {
    drawAssembly();
    const scope = useAssemblyStore.getState().scope;
    if (
      previousWorkspace?.grid !== state.grid ||
      (scope === 'selection' && previousWorkspace?.selection !== state.selection) ||
      (scope === 'currentModel' && previousWorkspace?.activeModelPath !== state.activeModelPath)
    )
      scheduleChecks();
    return;
  }
  synced = doc;
  syncedHidden = hiddenKey;
  expandRows = expandInstances(doc);
  rowsByPath.clear();
  expandRows.forEach((row) => rowsByPath.set(key(row.path), row.partId));
  const ticket = ++revision;
  useAssemblyStore.setState({ ready: false, checking: true });
  syncing = syncing
    .catch(() => undefined)
    .then(async () => {
      if (ticket !== revision) return;
      const ids = [...new Set(expandRows.map((row) => row.partId))];
      const parts: [string, AssemblyPart][] = [];
      let cursor = 0;
      // Leave the worker queue short so an interactive placement can request a new part.
      await Promise.all(
        Array.from({ length: Math.min(8, ids.length) }, async () => {
          while (cursor < ids.length && ticket === revision) {
            const id = ids[cursor++]!;
            parts.push([id, await loadAssemblyPart(id)]);
          }
        }),
      );
      const changed = parts.filter(([id, part]) => uploaded.get(id) !== part);
      if (ticket !== revision) return;
      catalog ??= await window.brickloop.assemblyCatalog();
      const next = await rpc<ReturnType<AssemblyEngine['sync']>>('sync', {
        doc,
        parts: changed,
        collision: useAssemblyStore.getState().collision,
        hidden: state.hidden,
        catalog,
      });
      changed.forEach(([id, part]) => uploaded.set(id, part));
      if (ticket !== revision) return;
      graph = next;
      indexGraphLabels(graph.edges);
      const selectedPivot = useAssemblyStore.getState().pivot;
      if (selectedPivot) {
        const updated = graph.markers.find((marker) => refKey(marker.ref) === refKey(selectedPivot.ref));
        useAssemblyStore.setState({ pivot: updated ? { ...updated, label: selectedPivot.label } : null });
      }
      useAssemblyStore.setState({ ready: true, error: null });
      drawAssembly();
      scheduleChecks();
    })
    .catch(() => {
      if (ticket === revision)
        useAssemblyStore.setState({ ready: false, checking: false, error: i18n.t('connectUi.failed') });
    });
}
export async function assemblyReady() {
  let current: Promise<void>;
  do {
    current = syncing;
    await current;
  } while (current !== syncing);
}
async function requestPreview(request: PreviewRequest): Promise<PreviewResult> {
  if (!useAssemblyStore.getState().ready)
    return {
      transforms: request.selection.map((row) => ({ path: row.path, transform: row.fallback })),
      chosen: null,
      markers: [],
      timing: { snapMs: 0, collisionMs: 0 },
      collision: {
        status: 'unknown',
        pairs: [],
        unknownPaths: request.selection.map((row) => row.path),
        reasons: ['budget'],
        testedPairs: 0,
      },
    };
  await syncing;
  // A placement part may not occur in the document yet; sync its definition before querying.
  const missing = request.selection.filter((row) => !assemblyParts.has(row.partId));
  if (missing.length) await Promise.all(missing.map((row) => loadAssemblyPart(row.partId)));
  const changed = request.selection
    .filter((row) => uploaded.get(row.partId) !== assemblyParts.get(row.partId))
    .map((row) => [row.partId, assemblyParts.get(row.partId)!] as [string, AssemblyPart]);
  if (document && changed.length) {
    await rpc('sync', { doc: document, parts: changed, collision: request.collision });
    changed.forEach(([id, part]) => uploaded.set(id, part));
  }
  const result = await rpc<PreviewResult>('preview', request);
  return result;
}
let previewRunning = false;
let queuedPreview:
  | { request: PreviewRequest; listeners: { resolve(value: PreviewResult): void; reject(reason: unknown): void }[] }
  | undefined;
/** Keep one running solve and one newest pointer sample; settle superseded callers with the newest result. */
export function solvePreview(request: PreviewRequest): Promise<PreviewResult> {
  return new Promise((resolve, reject) => {
    const listeners = [...(queuedPreview?.listeners ?? []), { resolve, reject }];
    queuedPreview = { request, listeners };
    if (previewRunning) return;
    previewRunning = true;
    void (async () => {
      try {
        while (queuedPreview) {
          const job = queuedPreview;
          queuedPreview = undefined;
          try {
            const result = await requestPreview(job.request);
            job.listeners.forEach((listener) => listener.resolve(result));
          } catch (error) {
            job.listeners.forEach((listener) => listener.reject(error));
          }
        }
      } finally {
        previewRunning = false;
      }
    })();
  });
}
export function showPreview(result: PreviewResult) {
  previewCollision = result.collision;
  movingPaths = new Set(result.transforms.filter((row) => row.path[0] !== '$preview').map((row) => key(row.path)));
  movingMarkers = result.transforms.flatMap((row) => {
    const partId = rowsByPath.get(key(row.path));
    if (!partId) return [];
    return instantiateConnectors({
      path: row.path,
      worldMatrix: new Float64Array(row.transform),
      connectors: assemblyParts.get(partId)?.connectors.connectors ?? [],
    })
      .filter(
        (marker) =>
          !result.chosen ||
          key(marker.ref.path) !== key(result.chosen.source.path) ||
          marker.ref.connectorId !== result.chosen.source.connectorId,
      )
      .map((marker) => ({ ...marker, label: markerLabel(marker) }));
  });
  previewMarkers = result.markers.map((marker) => ({
    ...marker,
    label: markerLabel(marker),
    highlight: key(marker.ref.path) === key(result.chosen?.source.path ?? []) ? 'source' : 'target',
  }));
  useAssemblyStore.setState((state) => ({
    chosen: result.chosen,
    timings: [...state.timings.slice(-599), result.timing],
  }));
  drawAssembly();
}
export function clearAssemblyPreview(redraw = true) {
  previewCollision = undefined;
  previewMarkers = [];
  movingMarkers = [];
  movingPaths = new Set();
  useAssemblyStore.setState({ chosen: null });
  if (redraw) drawAssembly();
}
export function previewBlocked() {
  return (
    useAssemblyStore.getState().collision &&
    useAssemblyStore.getState().policy === 'block' &&
    !!previewCollision?.pairs.some((pair) => pair.status === 'hit')
  );
}
export function supportPlane(path: InstancePath): number | undefined {
  const row = expandRows.find((row) => key(row.path) === key(path));
  if (!row) return undefined;
  const planes = (assemblyParts.get(row.partId)?.connectors.connectors ?? [])
    .filter(
      (c) =>
        (c.type === 'stud' || c.type === 'stud.hollow') && transformDirection(row.worldMatrix, c.frame.axis)[1] < -0.99,
    )
    .map((c) => transformPoint(row.worldMatrix, c.frame.origin)[1]);
  return planes.length ? Math.min(...planes) : undefined;
}
export function connectedPaths(path: InstancePath): InstancePath[] {
  const components = graph.components.filter((component) => component.some((p) => pathStartsWith(p, path)));
  return components.flat();
}
export function chooseConnectorPivot(marker: ConnectorMarker) {
  const edge = graph.edges.find(
    (edge) => refKey(edge.a) === refKey(marker.ref) || refKey(edge.b) === refKey(marker.ref),
  );
  const other = edge ? (refKey(edge.a) === refKey(marker.ref) ? edge.b : edge.a) : undefined;
  const mate = other ? graph.markers.find((item) => refKey(item.ref) === refKey(other))?.connector : undefined;
  useAssemblyStore.setState({
    pivot: marker,
    pivotMate: mate ?? {
      ...marker.connector,
      frame: {
        ...marker.connector.frame,
        axis: marker.connector.frame.axis.map((v) => -v) as [number, number, number],
      },
    },
  });
}
export function scheduleChecks() {
  checkRevision++;
  useAssemblyStore.setState({ checking: true });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void refreshChecks();
  }, 220);
}
let checksTask: { key: string; ticket: number; promise: Promise<void> } | undefined;
export async function refreshChecks() {
  await assemblyReady();
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  const state = useAssemblyStore.getState();
  const options: CheckOptions = {
    scope: state.scope,
    visibleOnly: state.visibleOnly,
    collisionEnabled: state.collision,
    groundIsFixed: state.groundIsFixed,
    activeModelPath: workspace?.activeModelPath ?? [],
    selection: workspace?.selection ?? [],
    hidden: workspace?.hidden ?? [],
    grid: {
      step: [
        20 * (workspace?.grid.horizontal ?? 1),
        workspace?.grid.vertical === 'brick' ? 24 : workspace?.grid.vertical === 'free' ? 1 : 8,
        20 * (workspace?.grid.horizontal ?? 1),
      ],
    },
  };
  const key = JSON.stringify([revision, options]);
  if (checksTask?.key === key && checksTask.ticket === checkRevision) return checksTask.promise;
  const ticket = ++checkRevision;
  const promise = performChecks(revision, ticket, options);
  checksTask = { key, ticket, promise };
  try {
    await promise;
  } finally {
    if (checksTask?.promise === promise) checksTask = undefined;
  }
}
async function performChecks(ticket: number, checkTicket: number, options: CheckOptions) {
  useAssemblyStore.setState({ checking: true });
  try {
    const result = await rpc<ReturnType<AssemblyEngine['check']>>('check', options);
    if (ticket !== revision || checkTicket !== checkRevision) return;
    committedCollision = result.collision;
    useAssemblyStore.setState((state) => ({
      issues: result.issues,
      error: null,
      lastChecks: document
        ? {
            ...state.lastChecks,
            [document.documentId]: {
              at: new Date().toISOString(),
              count: result.issues.length,
              revision: document.revision,
              scope: options.scope ?? 'project',
            },
          }
        : state.lastChecks,
    }));
    drawAssembly();
  } catch {
    if (ticket === revision && checkTicket === checkRevision)
      useAssemblyStore.setState({ error: i18n.t('connectUi.failed') });
  } finally {
    if (ticket === revision && checkTicket === checkRevision) useAssemblyStore.setState({ checking: false });
  }
}
export function setAssemblyOption<
  K extends
    'snap' | 'collision' | 'policy' | 'connectors' | 'connectorScope' | 'scope' | 'visibleOnly' | 'groundIsFixed',
>(name: K, value: AssemblyState[K]) {
  useAssemblyStore.setState({ [name]: value });
  if (name === 'collision' && !value) {
    committedCollision = undefined;
    previewCollision = undefined;
    useAssemblyStore.setState((state) => ({
      hitCount: 0,
      issues: state.issues.filter((issue) => !['collision', 'collisionUnknown'].includes(issue.kind)),
    }));
  }
  drawAssembly();
  if (['collision', 'scope', 'visibleOnly', 'groundIsFixed'].includes(name)) scheduleChecks();
  if (name === 'collision' && document) void rpc('sync', { doc: document, parts: [], collision: value });
}
export function openChecks() {
  useShellStore.setState({ rightTab: 'checks', rightCollapsed: false });
  void refreshChecks();
}
export async function setMaintenance(enabled: boolean) {
  try {
    useAssemblyStore.setState({ maintenance: await window.brickloop.setMaintenanceMode(enabled) });
  } catch {
    useAssemblyStore.setState({ error: i18n.t('connectUi.failed') });
  }
}
