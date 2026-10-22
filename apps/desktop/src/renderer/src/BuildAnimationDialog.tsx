import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, InputNumber, Modal, Progress, Select, Slider, Spin, Tooltip } from 'antd';
import { Download, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { animationGroupAt } from '@brickloop/animation';
import type { AnimationMotion, AnimationOrder } from '@brickloop/animation';
import { createBuildAnimationView } from '@brickloop/viewport';
import type { BuildAnimationView } from '@brickloop/viewport';
import { useTranslation } from './store';
import { displayDocumentTitle, useDocumentStore } from './document-store';
import {
  animationPlayer,
  animationCaptions,
  hasAnimationParts,
  makeTimeline,
  openBuildAnimation,
  prepareAnimation,
  useAnimationStore,
} from './animation-host';
import type { AnimationRequest, AnimationResources } from './animation-host';
import { chooseAnimationEncoder, encodeAnimation } from './animation-export';
import type { EncoderChoice, VideoProgress, VideoSettings } from './animation-export';

export function AnimationButton({
  modelId,
  order = 'layers',
  preview = false,
}: {
  modelId?: string;
  order?: AnimationOrder;
  preview?: boolean;
}) {
  const t = useTranslation(),
    doc = useDocumentStore((s) => s.document),
    id = modelId ?? doc.rootModelId;
  const enabled = hasAnimationParts(doc, id);
  return (
    <Tooltip title={enabled ? undefined : t('animationUi.empty')}>
      <span>
        <Button icon={<Play size={14} />} disabled={!enabled} onClick={() => openBuildAnimation(id, order)}>
          {t(preview ? 'animationUi.preview' : 'animationUi.playEntry')}
        </Button>
      </span>
    </Tooltip>
  );
}
export function BuildAnimationDialog() {
  const request = useAnimationStore((s) => s.request);
  return request ? <AnimationSession request={request} /> : null;
}
function AnimationSession({ request }: { request: AnimationRequest }) {
  const t = useTranslation();
  const [resources, setResources] = useState<AnimationResources | null>(null),
    [error, setError] = useState('');
  const [order, setOrder] = useState(request.order),
    [motion, setMotion] = useState<AnimationMotion>('drop');
  const [camera, setCamera] = useState<'orbit' | 'fixed'>('orbit'),
    [duration, setDuration] = useState<number | null>(null);
  const [timing, setTiming] = useState<'target' | 'perGroup'>('target'),
    [perGroup, setPerGroup] = useState(1.2);
  const [dim, setDim] = useState(false),
    [overlay, setOverlay] = useState(true),
    [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(true),
    [time, setTime] = useState(0),
    [ready, setReady] = useState(false);
  const [exportOpen, setExportOpen] = useState(false),
    [settings, setSettings] = useState<VideoSettings>({ height: 1080, fps: 30, white: false });
  const [choice, setChoice] = useState<EncoderChoice | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [progress, setProgress] = useState<VideoProgress>({ completed: 0, total: 0, remaining: 0, phase: 'encoding' });
  const abort = useRef<AbortController | null>(null),
    saveId = useRef<string | null>(null);
  const surface = useRef<HTMLDivElement>(null),
    view = useRef<BuildAnimationView | null>(null);
  const initiallyFocused = useRef(false);
  const clock = useRef({ time: 0, playing: true, speed: 1 });
  clock.current.playing = playing;
  clock.current.speed = speed;
  const documentTitle = useDocumentStore(
    (state) => state.tabs.find((tab) => tab.id === request.document.documentId)?.title ?? request.document.meta.title,
  );
  const title =
    (request.modelId === request.document.rootModelId
      ? displayDocumentTitle(documentTitle)
      : request.document.models[request.modelId]?.name) || t('animationUi.untitled');
  useEffect(() => {
    const controller = new AbortController();
    void prepareAnimation(request, controller.signal)
      .then(setResources)
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    return () => controller.abort();
  }, [request]);
  const timeline = useMemo(
    () =>
      resources
        ? makeTimeline(request, resources, {
            order,
            motion,
            ...(timing === 'perGroup'
              ? { secondsPerGroup: perGroup }
              : duration === null
                ? {}
                : { durationSeconds: duration }),
          })
        : null,
    [request, resources, order, motion, timing, perGroup, duration],
  );
  const viewOptions = useMemo(
    () => ({ cameraMode: camera, dimCompleted: dim, overlay, ...(request.camera ? { camera: request.camera } : {}) }),
    [camera, dim, overlay, request.camera],
  );
  const currentViewOptions = useRef(viewOptions);
  currentViewOptions.current = viewOptions;
  useEffect(() => {
    view.current?.setOptions(viewOptions);
    view.current?.render(clock.current.time);
  }, [viewOptions]);
  useEffect(() => {
    if (!timeline || !resources || !surface.current) return;
    const host = surface.current;
    let closed = false,
      frame = 0,
      instance: BuildAnimationView | undefined;
    setReady(false);
    clock.current.time = 0;
    setTime(0);
    void (async () => {
      instance = await createBuildAnimationView(timeline, resources.instances, resources.colors, {
        ...currentViewOptions.current,
        width: 1280,
        height: 720,
      });
      if (closed) {
        instance.dispose();
        return;
      }
      host.replaceChildren(instance.canvas);
      view.current = instance;
      instance.setOptions(currentViewOptions.current);
      instance.canvas.setAttribute('aria-label', t('animationUi.title'));
      instance.render(0);
      setReady(true);
      if (!initiallyFocused.current) {
        initiallyFocused.current = true;
        // Focus the shortcut container, leaving the stage's native focus-visible
        // style for users who reach it through keyboard navigation.
        host.closest<HTMLElement>('.animation-session')?.focus({ preventScroll: true });
      }
      let previous = performance.now(),
        lastUi = 0;
      const tick = (now: number) => {
        if (closed) return;
        const elapsed = (now - previous) / 1000;
        previous = now;
        if (clock.current.playing) {
          clock.current.time = Math.min(
            timeline.totalDuration,
            clock.current.time + Math.min(elapsed, 0.1) * clock.current.speed,
          );
          instance!.render(clock.current.time);
          if (now - lastUi > 75) {
            setTime(clock.current.time);
            lastUi = now;
          }
          if (clock.current.time >= timeline.totalDuration) {
            setPlaying(false);
            setTime(timeline.totalDuration);
          }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    })().catch((e: unknown) => {
      if (!closed) setError(String(e));
    });
    return () => {
      closed = true;
      cancelAnimationFrame(frame);
      instance?.dispose();
      view.current = null;
    };
  }, [timeline, resources]);
  const seek = (value: number) => {
    if (!timeline) return;
    const next = Math.max(0, Math.min(timeline.totalDuration, value));
    clock.current.time = next;
    view.current?.render(next);
    setTime(next);
  };
  const toggle = () => {
    if (timeline && clock.current.time >= timeline.totalDuration) seek(0);
    setPlaying((v) => !v);
  };
  const step = (direction: number) => {
    if (!timeline) return;
    clock.current.playing = false;
    setPlaying(false);
    const index = animationGroupAt(timeline, clock.current.time);
    const previous = timeline.ticks[index]?.time ?? 0;
    const destination = direction < 0 && clock.current.time > previous + 0.15 ? index : index + direction;
    seek(
      destination < 0
        ? 0
        : destination >= timeline.ticks.length
          ? timeline.totalDuration
          : timeline.ticks[destination]!.time + 0.001,
    );
  };
  useEffect(() => {
    animationPlayer.current = {
      seek: (value) => {
        clock.current.playing = false;
        setPlaying(false);
        seek(value);
      },
      state: () => ({
        time: clock.current.time,
        playing: clock.current.playing,
        duration: timeline?.totalDuration ?? 0,
        visible: timeline ? animationCaptions(timeline, clock.current.time, title).visible : 0,
        backend: view.current?.metrics.backend ?? '',
        moving: view.current?.metrics.moving ?? 0,
      }),
    };
    return () => {
      animationPlayer.current = null;
    };
  });
  useEffect(() => {
    if (!exportOpen) return;
    let canceled = false;
    setChoice(null);
    void chooseAnimationEncoder(settings)
      .then((value) => {
        if (!canceled) setChoice(value);
      })
      .catch((e: unknown) => {
        if (!canceled) setError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [exportOpen, settings]);
  useEffect(
    () => () => {
      abort.current?.abort();
      if (saveId.current) void window.brickloop.animationCancel(saveId.current);
    },
    [],
  );
  const cancelExport = () => {
    abort.current?.abort();
    if (saveId.current) void window.brickloop.animationCancel(saveId.current);
  };
  async function exportVideo() {
    if (!timeline || !resources || !choice) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    setPlaying(false);
    clock.current.playing = false;
    setProgress({
      completed: 0,
      total: Math.round(timeline.totalDuration * settings.fps),
      remaining: 0,
      phase: 'encoding',
    });
    try {
      const ticket = await window.brickloop.animationChoose(title, choice.format);
      if (!ticket) {
        setBusy(false);
        return;
      }
      saveId.current = ticket.id;
      controller.signal.throwIfAborted();
      const encoded = await encodeAnimation({
        timeline,
        resources,
        view: viewOptions,
        settings,
        choice,
        title,
        overlay,
        signal: controller.signal,
        onProgress: setProgress,
      });
      controller.signal.throwIfAborted();
      setProgress((p) => ({ ...p, phase: 'saving' }));
      const path = await window.brickloop.animationSave(ticket.id, encoded.bytes);
      setNotice(t('animationUi.saved', { path }));
    } catch (e) {
      if (controller.signal.aborted) setNotice(t('animationUi.cancelled'));
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (saveId.current) await window.brickloop.animationCancel(saveId.current);
      saveId.current = null;
      abort.current = null;
      setBusy(false);
    }
  }
  const captions = timeline ? animationCaptions(timeline, time, title) : null;
  const options = (keys: string[]) => keys.map((value) => ({ value, label: t(`animationUi.${value}`) }));
  const close = () => {
    if (busy) cancelExport();
    else useAnimationStore.setState({ request: null });
  };
  return (
    <Modal
      open
      width="min(1440px, 96vw)"
      className="build-animation-dialog"
      title={t('animationUi.title')}
      footer={null}
      styles={{ body: { padding: 0 } }}
      style={{ top: 28 }}
      mask={{ closable: false }}
      onCancel={close}
      destroyOnHidden
    >
      <div
        className="animation-session"
        data-ready={ready}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (
            exportOpen ||
            (event.target instanceof HTMLElement && event.target.closest('input,textarea,[role=combobox],.ant-select'))
          )
            return;
          if (event.code === 'Space') {
            event.preventDefault();
            event.stopPropagation();
            toggle();
          }
          if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            step(event.code === 'ArrowLeft' ? -1 : 1);
          }
        }}
      >
        {error && (
          <Alert
            type="error"
            title={t('animationUi.failed', { reason: error })}
            closable
            onClose={() => setError('')}
          />
        )}
        <div className="animation-layout">
          <div className="animation-stage" tabIndex={0} aria-label={t('animationUi.title')}>
            <div className="animation-surface" ref={surface} />
            {!ready && (
              <div className="animation-loading">
                <Spin />
                <span>{t('animationUi.loading')}</span>
              </div>
            )}
            {overlay && captions && (
              <div className="animation-caption">
                <strong>{captions.title}</strong>
                <span data-testid="animation-group">{captions.group}</span>
                <small>{captions.count}</small>
              </div>
            )}
          </div>
          <aside className="animation-settings" aria-label={t('animationUi.options')}>
            <label>
              {t('animationUi.order')}
              <Select
                aria-label={t('animationUi.order')}
                value={order}
                options={options(['layers', 'steps'])}
                onChange={setOrder}
              />
            </label>
            <label>
              {t('animationUi.motion')}
              <Select
                aria-label={t('animationUi.motion')}
                value={motion}
                options={options(['drop', 'fly', 'appear'])}
                onChange={setMotion}
              />
            </label>
            <label>
              {t('animationUi.camera')}
              <Select
                aria-label={t('animationUi.camera')}
                value={camera}
                options={options(['orbit', 'fixed'])}
                onChange={setCamera}
              />
            </label>
            <label>
              {t('animationUi.timing')}
              <Select
                aria-label={t('animationUi.timing')}
                value={timing}
                options={options(['target', 'perGroup'])}
                onChange={setTiming}
              />
            </label>
            <label>
              {t('animationUi.duration')}
              <InputNumber
                aria-label={t('animationUi.duration')}
                min={timing === 'target' ? 5 : 0.6}
                max={timing === 'target' ? 120 : 120}
                step={timing === 'target' ? 1 : 0.1}
                value={timing === 'target' ? (duration ?? timeline?.totalDuration ?? 11) : perGroup}
                onChange={(value) => {
                  if (value !== null) {
                    if (timing === 'target') setDuration(value);
                    else setPerGroup(value);
                  }
                }}
              />
            </label>
            <Checkbox checked={dim} onChange={(e) => setDim(e.target.checked)}>
              {t('animationUi.dim')}
            </Checkbox>
            <Checkbox checked={overlay} onChange={(e) => setOverlay(e.target.checked)}>
              {t('animationUi.overlay')}
            </Checkbox>
            {timeline?.coarseSteps && <Alert type="info" title={t('animationUi.coarse')} />}
            {!!resources?.missingCount && (
              <Alert type="warning" title={t('animationUi.missingGeometry', { count: resources.missingCount })} />
            )}
          </aside>
        </div>
        <div className="animation-controls">
          <Slider
            aria-label={t('animationUi.seek')}
            min={0}
            max={timeline?.totalDuration ?? 1}
            step={0.01}
            value={time}
            disabled={!ready}
            marks={Object.fromEntries((timeline?.ticks ?? []).map((tick) => [tick.time, { label: '', style: {} }]))}
            onChange={(value) => {
              clock.current.playing = false;
              setPlaying(false);
              seek(value);
            }}
            tooltip={{ formatter: (value) => t('animationUi.seconds', { value: value?.toFixed(1) }) }}
          />
          <div className="animation-transport">
            <Button
              aria-label={t('animationUi.previous')}
              icon={<SkipBack size={17} />}
              onClick={() => step(-1)}
              disabled={!ready}
            />
            <Button
              type="primary"
              aria-label={t(playing ? 'animationUi.pause' : 'animationUi.play')}
              icon={playing ? <Pause size={18} /> : <Play size={18} />}
              onClick={toggle}
              disabled={!ready}
            />
            <Button
              aria-label={t('animationUi.next')}
              icon={<SkipForward size={17} />}
              onClick={() => step(1)}
              disabled={!ready}
            />
            <span className="animation-time">
              {t('animationUi.seconds', { value: `${time.toFixed(1)} / ${(timeline?.totalDuration ?? 0).toFixed(1)}` })}
            </span>
            <Select
              aria-label={t('animationUi.speed')}
              value={speed}
              onChange={setSpeed}
              options={[0.5, 1, 2, 4].map((value) => ({ value, label: `${value}×` }))}
            />
            <span className="animation-shortcuts">{t('animationUi.hint')}</span>
            <Button
              icon={<Download size={16} />}
              onClick={() => {
                clock.current.playing = false;
                setPlaying(false);
                setExportOpen(true);
              }}
              disabled={!ready}
            >
              {t('animationUi.export')}
            </Button>
          </div>
        </div>
      </div>
      <Modal
        open={exportOpen}
        title={t('animationUi.exportTitle')}
        width={520}
        mask={{ closable: false }}
        closable={!busy}
        onCancel={() => (busy ? cancelExport() : setExportOpen(false))}
        footer={
          busy ? (
            <Button onClick={cancelExport}>{t('files.cancel')}</Button>
          ) : (
            <>
              <Button onClick={() => setExportOpen(false)}>{t('aiUi.close')}</Button>
              <Button type="primary" disabled={!choice} onClick={() => void exportVideo()}>
                {t('animationUi.startExport')}
              </Button>
            </>
          )
        }
      >
        <div className="animation-export-options">
          {notice && <Alert type="success" title={notice} />}
          {error && <Alert type="error" title={t('animationUi.failed', { reason: error })} />}
          {choice?.format === 'webm' && <Alert type="warning" title={t('animationUi.fallback')} />}
          {busy ? (
            <div role="status" data-testid="animation-export-progress">
              <strong>{t(`animationUi.${progress.phase}`)}</strong>
              <Progress percent={Math.round((progress.completed / Math.max(1, progress.total)) * 100)} />
              <p>{t('animationUi.frames', { ...progress })}</p>
              <p>{t('animationUi.remaining', { seconds: Math.ceil(progress.remaining) })}</p>
            </div>
          ) : (
            <>
              <label>
                {t('animationUi.resolution')}
                <Select
                  aria-label={t('animationUi.resolution')}
                  value={settings.height}
                  onChange={(height) => setSettings((s) => ({ ...s, height }))}
                  options={([720, 1080, 1440] as const).map((height) => ({
                    value: height,
                    label: t('animationUi.quality', { height }),
                  }))}
                />
              </label>
              <label>
                {t('animationUi.fps')}
                <Select
                  aria-label={t('animationUi.fps')}
                  value={settings.fps}
                  onChange={(fps) => setSettings((s) => ({ ...s, fps }))}
                  options={([30, 60] as const).map((fps) => ({
                    value: fps,
                    label: t('animationUi.fpsValue', { fps }),
                  }))}
                />
              </label>
              <Checkbox
                checked={settings.white}
                onChange={(e) => setSettings((s) => ({ ...s, white: e.target.checked }))}
              >
                {t('animationUi.white')}
              </Checkbox>
              <p>
                {choice ? t(`animationUi.${choice.format}`) : t('animationUi.checking')} · {t('animationUi.noAudio')}
              </p>
            </>
          )}
        </div>
      </Modal>
    </Modal>
  );
}
