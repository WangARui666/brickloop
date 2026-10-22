import { create } from 'zustand';
import { expandInstances, pathStartsWith, resolvePath } from '@brickloop/core';
import type { BrkDocument } from '@brickloop/core';
import type { AnimationOptions, AnimationOrder, BuildTimeline } from '@brickloop/animation';
import { animationGroupAt, planBuildAnimation } from '@brickloop/animation';
import { documentSession, getViewport } from './document-store';
import { animationConnections } from './assembly-store';
import { getMesh } from './mesh-client';
import { useLibraryStore } from './library-store';
import { i18n } from './store';
import { loadAnimationResources } from './animation-resources';

export interface AnimationRequest {
  document: BrkDocument;
  modelId: string;
  order: AnimationOrder;
  camera: ReturnType<NonNullable<ReturnType<typeof getViewport>>['getCamera']> | undefined;
  connections: NonNullable<AnimationOptions['connections']>;
}
export const useAnimationStore = create<{ request: AnimationRequest | null }>(() => ({ request: null }));
export const animationPlayer: {
  current: null | {
    seek(time: number): void;
    state(): { time: number; playing: boolean; duration: number; visible: number; backend: string; moving: number };
  };
} = { current: null };
export function hasAnimationParts(doc: BrkDocument, modelId = doc.rootModelId, visited = new Set<string>()): boolean {
  if (visited.has(modelId)) return false;
  visited.add(modelId);
  return Object.values(doc.models[modelId]?.instances ?? {}).some(
    (p) => p.ref.kind === 'part' || hasAnimationParts(doc, p.ref.modelId, visited),
  );
}
export function openBuildAnimation(modelId = documentSession.document.rootModelId, order: AnimationOrder = 'layers') {
  const doc = documentSession.document;
  if (!hasAnimationParts(doc, modelId)) return;
  let connections = animationConnections(doc);
  if (modelId !== doc.rootModelId && connections.length) {
    let prefix: string[] | undefined;
    for (const row of expandInstances(doc)) {
      for (let length = 1; length < row.path.length; length++) {
        const candidate = row.path.slice(0, length),
          ref = resolvePath(doc, candidate)?.instance.ref;
        if (ref?.kind === 'model' && ref.modelId === modelId) {
          prefix = candidate;
          break;
        }
      }
      if (prefix) break;
    }
    const scope = prefix;
    connections = scope
      ? connections
          .filter((edge) => pathStartsWith(edge.a, scope) && pathStartsWith(edge.b, scope))
          .map((edge) => ({ a: edge.a.slice(scope.length), b: edge.b.slice(scope.length) }))
      : [];
  }
  useAnimationStore.setState({
    request: {
      document: structuredClone(doc),
      modelId,
      order,
      camera: getViewport()?.getCamera(),
      connections,
    },
  });
}
export async function prepareAnimation(request: AnimationRequest, signal: AbortSignal) {
  const { allColors: colors, status } = useLibraryStore.getState();
  return loadAnimationResources(
    request.document,
    request.modelId,
    colors,
    async (id) => (await getMesh(id, status?.pack?.id ?? 'demo')).mesh,
    signal,
  );
}
export type AnimationResources = Awaited<ReturnType<typeof prepareAnimation>>;
export function makeTimeline(
  request: AnimationRequest,
  resources: AnimationResources,
  options: Omit<AnimationOptions, 'localBounds' | 'connections'>,
) {
  return planBuildAnimation(request.document, request.modelId, {
    ...options,
    localBounds: resources.bounds,
    excludedPartIds: resources.excludedPartIds,
    connections: request.connections,
  });
}
export function animationCaptions(timeline: BuildTimeline, time: number, title: string) {
  const group = animationGroupAt(timeline, time);
  let lo = 0,
    hi = timeline.parts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timeline.parts[mid]!.start < time) lo = mid + 1;
    else hi = mid;
  }
  return {
    title,
    group:
      time >= timeline.buildDuration
        ? i18n.t('animationUi.complete')
        : i18n.t(timeline.order === 'layers' ? 'animationUi.layerCounter' : 'animationUi.stepCounter', {
            current: group + 1,
            total: timeline.ticks.length,
          }),
    count: i18n.t('animationUi.partCounter', { current: lo, total: timeline.parts.length }),
    visible: lo,
  };
}
/** Shared typography/composition for exported frames and frame-accuracy verification. */
export function compositeAnimation(
  canvas: HTMLCanvasElement,
  source: HTMLCanvasElement,
  timeline: BuildTimeline,
  time: number,
  title: string,
  overlay: boolean,
  white: boolean,
) {
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = white ? '#ffffff' : source.style.backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (!overlay) return;
  const scale = canvas.height / 1080,
    pad = 52 * scale,
    caption = animationCaptions(timeline, time, title);
  const gradient = ctx.createLinearGradient(0, 0, 0, 170 * scale);
  gradient.addColorStop(0, white ? 'rgba(255,255,255,0.7)' : 'rgba(10,12,17,0.5)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, 170 * scale);
  ctx.textBaseline = 'top';
  ctx.fillStyle = white ? '#222733' : '#E7E9EE';
  ctx.font = `600 ${30 * scale}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  ctx.fillText(caption.title, pad, pad, canvas.width - 2 * pad);
  ctx.font = `${22 * scale}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = white ? '#535E70' : '#A3ABBA';
  ctx.fillText(caption.group, pad, pad + 46 * scale);
  ctx.textAlign = 'right';
  ctx.fillText(caption.count, canvas.width - pad, canvas.height - pad - 24 * scale);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#FF8A3D';
  ctx.fillRect(
    pad,
    canvas.height - pad,
    Math.max(0, canvas.width - 2 * pad) * Math.min(1, time / timeline.totalDuration),
    3 * scale,
  );
}
