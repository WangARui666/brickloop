/** Imported exclusively by the test-build editor bridge. */
import { createDocument, expandInstances, toLDraw } from '@brickloop/core';
import type { BrkDocument } from '@brickloop/core';
import { sampleBuildAnimation } from '@brickloop/animation';
import type { AnimationOrder } from '@brickloop/animation';
import { createBuildAnimationView, renderOffscreen } from '@brickloop/viewport';
import { documentSession, getViewport } from './document-store';
import { animationPlayer } from './animation-host';
import {
  openBuildAnimation,
  prepareAnimation,
  makeTimeline,
  compositeAnimation,
  useAnimationStore,
} from './animation-host';
import type { AnimationRequest } from './animation-host';
import { chooseAnimationEncoder, encodeAnimation } from './animation-export';
import type { VideoSettings } from './animation-export';

const snapshot = (doc = documentSession.document): AnimationRequest => ({
  document: structuredClone(doc),
  modelId: doc.rootModelId,
  order: 'layers',
  camera: getViewport()?.getCamera(),
  connections: [],
});
function repeated(count: number): BrkDocument {
  const rows = expandInstances(documentSession.document);
  let serial = 0;
  const id = () => String(++serial).padStart(26, '0');
  const doc = createDocument({ title: 'Animation performance' }, { id });
  const root = doc.models[doc.rootModelId]!;
  const from = documentSession.document;
  // Reuse the completed building ten times, retaining all geometry and original colors.
  for (let i = 0; i < count; i++) {
    const row = rows[i % rows.length]!,
      key = id();
    const transform = toLDraw(row.worldMatrix);
    transform[0] = row.worldMatrix[12]! + (Math.floor(i / rows.length) % 5) * 1000;
    transform[1] = row.worldMatrix[13]!;
    transform[2] = row.worldMatrix[14]! + Math.floor(i / rows.length / 5) * 1000;
    root.instances[key] = {
      ...row.instance,
      id: key,
      transform,
      stepId: root.stepIds[0]!,
      groupId: null,
      colorId: row.colorId,
    };
    root.steps[root.stepIds[0]!]!.instanceIds.push(key);
  }
  doc.catalogPack = { ...from.catalogPack };
  return doc;
}
let exporting: AbortController | null = null;
export const animationTestApi = {
  open: openBuildAnimation,
  close: () => useAnimationStore.setState({ request: null }),
  seek: (time: number) => animationPlayer.current?.seek(time),
  state: () => animationPlayer.current?.state(),
  /** Seek a default-timing guide scene to an actual fade-in near the requested fraction. */
  async seekMoving(fraction: number, order: AnimationOrder = 'layers') {
    const request = useAnimationStore.getState().request!;
    const resources = await prepareAnimation(request, new AbortController().signal);
    const timeline = makeTimeline(request, resources, { order });
    const target = timeline.totalDuration * fraction;
    const part = timeline.parts.reduce((best, part) =>
      Math.abs(part.start - target) < Math.abs(best.start - target) ? part : best,
    );
    const time = part.start + part.duration * 0.15;
    animationPlayer.current!.seek(time);
    const samples = sampleBuildAnimation(timeline, time);
    return {
      time,
      duration: timeline.totalDuration,
      translucent: samples.filter((part) => part.opacity > 0 && part.opacity < 1).length,
      settled: samples.filter((part) => part.offset.every((value) => value === 0)).length,
      groups: timeline.ticks.length,
      coarseSteps: timeline.coarseSteps,
    };
  },
  cancel: () => exporting?.abort(),
  async compareCompleted(preferWebGPU: boolean) {
    const request = snapshot(),
      resources = await prepareAnimation(request, new AbortController().signal),
      timeline = makeTimeline(request, resources, { durationSeconds: 30 }),
      width = 1920,
      height = 1080;
    const view = await createBuildAnimationView(timeline, resources.instances, resources.colors, {
      width,
      height,
      preferWebGPU,
      overlay: false,
    });
    try {
      view.render(timeline.totalDuration);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(view.canvas, 0, 0);
      const actualPng = canvas.toDataURL(),
        actual = ctx.getImageData(0, 0, width, height).data;
      const [reference] = await renderOffscreen([...resources.instances.values()], resources.colors, {
        views: ['iso'],
        width,
        height,
        transparent: true,
        camera: view.getCamera(),
      });
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(atob(reference!.png.split(',')[1]!), (c) => c.charCodeAt(0))], { type: 'image/png' }),
      );
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const expectedPng = canvas.toDataURL(),
        expected = ctx.getImageData(0, 0, width, height).data;
      let count = 0,
        difference = 0,
        redCount = 0,
        actualRed = 0,
        expectedRed = 0;
      let left = width,
        right = 0,
        top = height,
        bottom = 0;
      for (let y = 1; y < height - 1; y++)
        for (let x = 1; x < width - 1; x++) {
          const i = (y * width + x) * 4;
          if (expected[i + 3]! < 250) continue;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
          // Erode only the silhouette by one pixel to exclude antialias coverage against the contact shadow.
          if ([-4, 4, -width * 4, width * 4].some((d) => expected[i + d + 3]! < 250)) continue;
          count++;
          for (let c = 0; c < 3; c++) difference += Math.abs(actual[i + c]! - expected[i + c]!);
          if (expected[i]! > 80 && expected[i]! > expected[i + 1]! * 1.6 && expected[i]! > expected[i + 2]! * 1.6) {
            redCount++;
            actualRed += 0.2126 * actual[i]! + 0.7152 * actual[i + 1]! + 0.0722 * actual[i + 2]!;
            expectedRed += 0.2126 * expected[i]! + 0.7152 * expected[i + 1]! + 0.0722 * expected[i + 2]!;
          }
        }
      const handoff = [];
      for (const transparent of [false, true]) {
        const instances = new Map(
          [...resources.instances].map(([key, instance]) => [
            key,
            {
              ...instance,
              color:
                transparent && instance.color.id === 'c:bright-red'
                  ? resources.colors.find((c) => c.id === 'c:transparent-red')!
                  : instance.color,
            },
          ]),
        );
        const settled = await createBuildAnimationView(
          { ...timeline, parts: timeline.parts.map((p) => ({ ...p, start: 0 })) },
          instances,
          resources.colors,
          { width, height, preferWebGPU, cameraMode: 'fixed', camera: view.getCamera(), overlay: false },
        );
        try {
          settled.render(0.74999); // Highlight has decayed; still in the moving pool.
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(settled.canvas, 0, 0);
          const moving = ctx.getImageData(0, 0, width, height).data;
          settled.render(0.75001); // Same pose and camera, now in staticDraws.
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(settled.canvas, 0, 0);
          const completed = ctx.getImageData(0, 0, width, height).data;
          let delta = 0,
            pixels = 0;
          for (let i = 0; i < moving.length; i += 4)
            if (moving[i + 3]! > 128 && completed[i + 3]! > 128) {
              pixels++;
              for (let c = 0; c < 3; c++) delta += Math.abs(moving[i + c]! - completed[i + c]!);
            }
          handoff.push({ transparent, meanDifference: delta / pixels / 3 });
        } finally {
          settled.dispose();
        }
      }
      return {
        backend: view.metrics.backend,
        modelPixels: count,
        redPixels: redCount,
        handoff,
        colors: [...new Map([...resources.instances.values()].map((i) => [i.color.id, i.color])).values()],
        meanDifference: difference / count / 3,
        redLuminanceDifference: Math.abs(actualRed - expectedRed) / redCount,
        actualRedLuminance: actualRed / redCount,
        expectedRedLuminance: expectedRed / redCount,
        modelBounds: { left, top, width: right - left + 1, height: bottom - top + 1 },
        actualPng,
        expectedPng,
      };
    } finally {
      view.dispose();
    }
  },
  async playback(count: number, preferWebGPU: boolean) {
    const request = snapshot(repeated(count)),
      controller = new AbortController(),
      resources = await prepareAnimation(request, controller.signal);
    const timeline = makeTimeline(request, resources, { durationSeconds: 30 }),
      view = await createBuildAnimationView(timeline, resources.instances, resources.colors, {
        width: 1280,
        height: 720,
        preferWebGPU,
      });
    Object.assign(view.canvas.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      zIndex: '9999',
      width: '1280px',
      height: '720px',
    });
    document.body.append(view.canvas);
    const samples: number[] = [],
      cpu: number[] = [];
    try {
      for (let i = 0; i < 30; i++) {
        await new Promise(requestAnimationFrame);
        view.render(timeline.totalDuration * (0.2 + i * 0.002));
      }
      let previous = performance.now();
      for (let i = 0; i < 180; i++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        samples.push(now - previous);
        previous = now;
        view.render(timeline.totalDuration * (0.3 + (i / 180) * 0.5));
        cpu.push(view.metrics.renderMs);
      }
      return {
        count,
        requested: preferWebGPU ? 'webgpu' : 'webgl2',
        backend: view.metrics.backend,
        meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
        p95Ms: [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)]!,
        cpuMs: cpu.reduce((a, b) => a + b, 0) / cpu.length,
        frames: samples.length,
      };
    } finally {
      view.canvas.remove();
      view.dispose();
    }
  },
  async export(settings: VideoSettings, durationSeconds: number, verify = false) {
    const controller = new AbortController();
    exporting = controller;
    const request = snapshot(),
      resources = await prepareAnimation(request, controller.signal),
      timeline = makeTimeline(request, resources, { durationSeconds: 30 });
    const choice = await chooseAnimationEncoder(settings),
      ticket = await window.brickloop.animationChoose('庭院村舍', choice.format);
    if (!ticket) throw new Error('Missing save ticket');
    const started = performance.now();
    let uiTicks = 0;
    const timer = setInterval(() => uiTicks++, 10);
    try {
      const encoded = await encodeAnimation({
        timeline,
        resources,
        view: {},
        settings,
        choice,
        title: '庭院村舍',
        overlay: true,
        signal: controller.signal,
        onProgress: () => {},
        durationSeconds,
      });
      await window.brickloop.animationSave(ticket.id, encoded.bytes);
      const elapsedMs = performance.now() - started;
      const references: number[][] = [];
      if (verify) {
        const view = await createBuildAnimationView(timeline, resources.instances, resources.colors, {
          width: (settings.height * 16) / 9,
          height: settings.height,
        });
        const canvas = document.createElement('canvas');
        canvas.width = (settings.height * 16) / 9;
        canvas.height = settings.height;
        const small = document.createElement('canvas');
        small.width = 160;
        small.height = 90;
        const ctx = small.getContext('2d')!;
        try {
          for (const index of [0, 45, 89]) {
            const time = (index / settings.fps / durationSeconds) * timeline.totalDuration;
            view.render(time);
            compositeAnimation(canvas, view.canvas, timeline, time, '庭院村舍', true, false);
            ctx.drawImage(canvas, 0, 0, 160, 90);
            references.push(Array.from(ctx.getImageData(0, 0, 160, 90).data));
          }
        } finally {
          view.dispose();
        }
      }
      return { choice, frames: encoded.frames, backend: encoded.backend, elapsedMs, uiTicks, references };
    } finally {
      clearInterval(timer);
      exporting = null;
      await window.brickloop.animationCancel(ticket.id);
    }
  },
  async decode(
    bytes: number[],
    samples: { timestamp: number; duration: number; key: boolean; data: number[] }[],
    description: number[],
    codec: string,
    lastFrame = false,
  ) {
    const pixels: number[][] = [],
      canvas = document.createElement('canvas');
    canvas.width = lastFrame ? 1920 : 160;
    canvas.height = lastFrame ? 1080 : 90;
    const ctx = canvas.getContext('2d')!;
    let index = 0,
      error: Error | undefined;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (lastFrame ? index === samples.length - 1 : [0, 45, 89].includes(index)) {
          ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          if (!lastFrame) pixels.push(Array.from(ctx.getImageData(0, 0, 160, 90).data));
        }
        index++;
        frame.close();
      },
      error: (e) => {
        error = e;
      },
    });
    try {
      decoder.configure({ codec, description: new Uint8Array(description) });
      for (const sample of samples)
        decoder.decode(
          new EncodedVideoChunk({
            type: sample.key ? 'key' : 'delta',
            timestamp: sample.timestamp,
            duration: sample.duration,
            data: new Uint8Array(sample.data),
          }),
        );
      await decoder.flush();
      if (error) throw error;
      return { pixels, frames: index, bytes: bytes.length, png: lastFrame ? canvas.toDataURL('image/png') : undefined };
    } finally {
      decoder.close();
    }
  },
};
