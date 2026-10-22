import workerUrl from './instructions.worker?worker&url';
import { createModuleWorker } from './module-worker';
import { expandInstances, toLDraw } from '@brickloop/core';
import type { BrkDocument } from '@brickloop/core';
import type { Transform } from '@brickloop/ldraw';
import type { ColorDef, ColorId, PartId } from '@brickloop/catalog';
import { renderOffscreen } from '@brickloop/viewport';
import type { PartInstance } from '@brickloop/viewport';
import type { InstructionPlan, InstructionHost, StepRenderRequest, PartRenderRequest } from '@brickloop/instructions';
import { getMesh } from './mesh-client';

const pngBytes = (png: string) =>
  Uint8Array.from(atob(png.slice(png.indexOf(',') + 1)), (letter) => letter.charCodeAt(0));
export function createInstructionHost(
  doc: BrkDocument,
  plan: InstructionPlan,
  colors: ColorDef[],
  pack: string,
  signal: AbortSignal,
  highlight: boolean,
) {
  const complete = new Map<string, Promise<(PartInstance & { firstStep: number })[]>>();
  const slots = new Map<string, { width: number; height: number }>();
  for (const page of plan.pages.filter((page) => page.kind === 'steps'))
    for (const element of page.elements) {
      if (element.kind !== 'image' || element.source.kind !== 'step') continue;
      // Ignore the small submodel thumbnails in PLI; each step's main image is the largest matching image.
      if (element.box.width < 80 || element.box.height < 80) continue;
      const previous = slots.get(element.source.modelId);
      const width = Math.round((element.box.width * plan.options.dpi) / 72),
        height = Math.round((element.box.height * plan.options.dpi) / 72);
      slots.set(element.source.modelId, {
        width: Math.min(previous?.width ?? Infinity, width),
        height: Math.min(previous?.height ?? Infinity, height),
      });
    }
  async function modelParts(modelId: string, inheritedColorId: string) {
    const key = `${modelId}/${inheritedColorId}`;
    let pending = complete.get(key);
    if (!pending) {
      pending = (async () => {
        const model = doc.models[modelId]!;
        const local = { ...doc, rootModelId: modelId };
        const steps = new Map(
          model.stepIds.flatMap((id, index) =>
            model.steps[id]!.instanceIds.map((instanceId) => [instanceId, index] as const),
          ),
        );
        return Promise.all(
          expandInstances(local, modelId, inheritedColorId as ColorId).map(async (row) => {
            signal.throwIfAborted();
            const { mesh } = await getMesh(row.partId as PartId, pack);
            if (!mesh.batches.length) throw new Error('Missing part geometry');
            const color =
              colors.find((color) => color.id === row.colorId) ?? colors.find((color) => color.ldrawCode === 16);
            if (!color) throw new Error('Missing color');
            return {
              partId: row.partId as PartId,
              mesh,
              color,
              transform: toLDraw(row.worldMatrix) as Transform,
              firstStep: steps.get(row.path[0]!) ?? 0,
            };
          }),
        );
      })();
      complete.set(key, pending);
    }
    return pending;
  }
  return {
    async renderStep(request: StepRenderRequest) {
      const parts = await modelParts(request.modelId, request.inheritedColorId);
      signal.throwIfAborted();
      const slot = slots.get(request.modelId) ?? { width: request.widthPx, height: request.heightPx };
      // Cover/PLI images can use their own framing; sequence images share the exact pixel scale.
      const thumbnail = request.widthPx < slot.width * 0.6 || request.heightPx < slot.height * 0.6;
      const frame = thumbnail ? { width: request.widthPx, height: request.heightPx } : slot;
      const images = await renderOffscreen(
        parts
          .filter((part) => part.firstStep <= request.stepIndex)
          .map((part) => ({ ...part, highlighted: highlight && !thumbnail && part.firstStep === request.stepIndex })),
        colors,
        {
          views: ['iso'],
          width: request.widthPx,
          height: request.heightPx,
          transparent: true,
          instructionFrame: { instances: parts, ...frame },
          signal,
          outlinePixels: plan.options.dpi / 150,
        },
      );
      return pngBytes(images[0]!.png);
    },
    async renderPart(request: PartRenderRequest) {
      signal.throwIfAborted();
      const { mesh } = await getMesh(request.partId as PartId, pack);
      const color = colors.find((color) => color.id === request.colorId);
      if (!color || !mesh.batches.length) throw new Error('Missing part geometry or color');
      const parts = [{ partId: request.partId as PartId, mesh, color }];
      const images = await renderOffscreen(parts, colors, {
        views: ['iso'],
        width: request.sizePx,
        height: request.sizePx,
        transparent: true,
        signal,
        instructionFrame: { instances: parts, width: request.sizePx, height: request.sizePx },
      });
      return pngBytes(images[0]!.png);
    },
  };
}

export function renderInstructionWorker(plan: InstructionPlan, host: InstructionHost): Promise<Uint8Array> {
  const worker = createModuleWorker(workerUrl);
  return new Promise((resolve, reject) => {
    function finish(error?: unknown, bytes?: Uint8Array) {
      worker.terminate();
      host.signal?.removeEventListener('abort', cancel);
      if (bytes) resolve(bytes);
      else reject(error);
    }
    const cancel = () => finish(new DOMException('Canceled', 'AbortError'));
    host.signal?.addEventListener('abort', cancel, { once: true });
    if (host.signal?.aborted) {
      cancel();
      return;
    }
    worker.onerror = (event) => finish(new Error(event.message));
    worker.onmessage = (
      event: MessageEvent<
        | { type: 'progress'; completedPages: number; totalPages: number }
        | { type: 'done'; bytes: Uint8Array }
        | { type: 'error'; message: string }
        | { type: 'step'; id: number; request: StepRenderRequest }
        | { type: 'part'; id: number; request: PartRenderRequest }
      >,
    ) => {
      const data = event.data;
      if (data.type === 'progress') host.onProgress?.(data);
      else if (data.type === 'done') finish(undefined, data.bytes);
      else if (data.type === 'error') finish(new Error(data.message));
      else
        void Promise.resolve(data.type === 'step' ? host.renderStep(data.request) : host.renderPart(data.request))
          .then((bytes) => {
            if (!host.signal?.aborted) worker.postMessage({ type: 'image', id: data.id, bytes }, [bytes.buffer]);
          })
          .catch((error: unknown) => finish(error));
    };
    worker.postMessage({ type: 'start', plan, fonts: host.fonts });
  });
}
