import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import type { BuildTimeline } from '@brickloop/animation';
import { createBuildAnimationView } from '@brickloop/viewport';
import type { BuildAnimationViewOptions } from '@brickloop/viewport';
import type { AnimationResources } from './animation-host';
import { compositeAnimation } from './animation-host';
import { i18n } from './store';

export interface VideoSettings {
  height: 720 | 1080 | 1440;
  fps: 30 | 60;
  white: boolean;
}
export interface EncoderChoice {
  format: 'mp4' | 'webm';
  config: VideoEncoderConfig;
  h2641080: boolean;
  h264Selected: boolean;
}
export interface VideoProgress {
  completed: number;
  total: number;
  remaining: number;
  phase: 'encoding' | 'saving';
}
const width = (height: number) => (height * 16) / 9;
export async function chooseAnimationEncoder(settings: VideoSettings): Promise<EncoderChoice> {
  if (typeof VideoEncoder === 'undefined') throw new Error(i18n.t('animationUi.noEncoder'));
  const config = (height: number, fps: number): VideoEncoderConfig => ({
    codec: height > 1080 || fps === 60 ? 'avc1.640033' : 'avc1.640028',
    width: width(height),
    height,
    framerate: fps,
    bitrate: Math.round(10_000_000 * (height / 1080) ** 2 * (fps / 30)),
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
    avc: { format: 'avc' },
  });
  const supported = async (c: VideoEncoderConfig) => {
    try {
      return (await VideoEncoder.isConfigSupported(c)).supported === true;
    } catch {
      return false;
    }
  };
  // Probe the specified High Profile 1080p baseline even when exporting another size.
  const baseline = config(1080, 30);
  const h2641080 =
    (await supported(baseline)) || (await supported({ ...baseline, hardwareAcceleration: 'no-preference' }));
  let selected = config(settings.height, settings.fps);
  let h264Selected = await supported(selected);
  if (!h264Selected) {
    selected = { ...selected, hardwareAcceleration: 'no-preference' };
    h264Selected = await supported(selected);
  }
  if (h2641080 && h264Selected) return { format: 'mp4', config: selected, h2641080, h264Selected };
  const vp9: VideoEncoderConfig = {
    codec: settings.height > 1080 ? 'vp09.00.50.08' : settings.fps === 60 ? 'vp09.00.41.08' : 'vp09.00.40.08',
    width: width(settings.height),
    height: settings.height,
    framerate: settings.fps,
    bitrate: selected.bitrate!,
    // VP9 is commonly supplied by Chromium's software encoder on Windows.
    hardwareAcceleration: 'no-preference',
    latencyMode: 'quality',
  };
  if (!(await supported(vp9))) throw new Error(i18n.t('animationUi.noEncoder'));
  return { format: 'webm', config: vp9, h2641080, h264Selected };
}
const yieldUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Fixed timestamps, bounded encoder queue and an independently sized detached renderer. */
export async function encodeAnimation(options: {
  timeline: BuildTimeline;
  resources: AnimationResources;
  view: Omit<BuildAnimationViewOptions, 'width' | 'height'>;
  settings: VideoSettings;
  choice: EncoderChoice;
  title: string;
  overlay: boolean;
  signal: AbortSignal;
  onProgress(progress: VideoProgress): void;
  /** Test/preview tools can export a short, time-scaled version through the same production encoder. */
  durationSeconds?: number;
}) {
  const { timeline, settings, choice, signal } = options;
  signal.throwIfAborted();
  const duration = options.durationSeconds ?? timeline.totalDuration,
    total = Math.round(duration * settings.fps);
  const view = await createBuildAnimationView(timeline, options.resources.instances, options.resources.colors, {
    ...options.view,
    overlay: options.overlay,
    width: width(settings.height),
    height: settings.height,
    ...(settings.white ? { background: '#ffffff' } : {}),
  });
  let encoder: VideoEncoder | undefined;
  try {
    signal.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = width(settings.height);
    canvas.height = settings.height;
    const target = choice.format === 'mp4' ? new Mp4Target() : new WebmTarget();
    const muxer =
      choice.format === 'mp4'
        ? new Mp4Muxer({
            target: target as Mp4Target,
            video: { codec: 'avc', width: canvas.width, height: canvas.height },
            fastStart: 'in-memory',
            firstTimestampBehavior: 'strict',
          })
        : new WebmMuxer({
            target: target as WebmTarget,
            video: { codec: 'V_VP9', width: canvas.width, height: canvas.height, frameRate: settings.fps },
            firstTimestampBehavior: 'strict',
          });
    let failure: Error | undefined;
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta);
        } catch (e) {
          failure = e instanceof Error ? e : new Error(String(e));
        }
      },
      error: (error) => {
        failure = error;
      },
    });
    encoder.configure(choice.config);
    // Warm compilation is included in elapsed time but never encoded as a frame.
    view.render(0);
    const started = performance.now();
    for (let i = 0; i < total; i++) {
      signal.throwIfAborted();
      if (failure) throw failure;
      while (encoder.encodeQueueSize > 4) {
        await yieldUi();
        signal.throwIfAborted();
        if (failure) throw failure;
      }
      const time = (i / settings.fps / duration) * timeline.totalDuration;
      view.render(time);
      compositeAnimation(canvas, view.canvas, timeline, time, options.title, options.overlay, settings.white);
      const timestamp = Math.round((i * 1_000_000) / settings.fps),
        next = Math.round(((i + 1) * 1_000_000) / settings.fps);
      // Canvas color metadata is carried into the encoder's 8-bit AVC output.
      const frame = new VideoFrame(canvas, { timestamp, duration: next - timestamp, alpha: 'discard' });
      try {
        encoder.encode(frame, { keyFrame: i % (settings.fps * 2) === 0 });
      } finally {
        frame.close();
      }
      if (i % 3 === 0 || i === total - 1) {
        options.onProgress({
          completed: i + 1,
          total,
          remaining: ((performance.now() - started) / 1000 / (i + 1)) * (total - i - 1),
          phase: 'encoding',
        });
        await yieldUi();
      }
    }
    await encoder.flush();
    if (failure) throw failure;
    signal.throwIfAborted();
    muxer.finalize();
    return {
      bytes: new Uint8Array(target.buffer),
      frames: total,
      backend: view.metrics.backend,
      encodingMs: performance.now() - started,
    };
  } finally {
    if (encoder?.state !== 'closed') encoder?.close();
    view.dispose();
  }
}
