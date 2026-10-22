import {
  DirectionalLight,
  HemisphereLight,
  MOUSE,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
  ACESFilmicToneMapping,
  Box3,
  Frustum,
  Matrix4,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
} from 'three/webgpu';
import type { CoordinateSystem } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLdrawRoot } from './coordinates';
import { boundsCorners, fitBounds, perspectiveDistance, perspectiveSpan, presetFrame } from './framing';
import type { Frame, ViewPreset } from './framing';
import { defaultGrid } from './grid';
import type { GridOptions } from './grid';
import { addPlaceholder, createContentLayer, createGrid, disposeObjects, visibleContentBounds } from './scene-content';
import { createAxisIndicator } from './axis-indicator';
import { themeColor, viewportColors } from './theme';
import { createPartInstances } from './parts';
import type { PartInstance } from './parts';
import type { ColorDef } from '@brickloop/catalog';
import { createEditorViewport } from './editor-viewport';
import type { EditorViewport } from './editor-viewport';
import type { Workspace } from '@brickloop/core';
import { createRenderScheduler } from './render-scheduler';
export type {
  EditorViewport,
  EditorEvents,
  EditorSettings,
  PlacementPreview,
  PointerModifiers,
} from './editor-viewport';
export {
  horizontalAxes,
  keyboardDelta,
  snap,
  fromPositionLdu,
  toPositionLdu,
  eulerDegrees,
  withEulerDegrees,
} from './editing-math';
export type { PositionUnit } from './editing-math';
export { createPartInstances, partMaterial } from './parts';
export type { PartInstance } from './parts';
export { connectorStyle } from './connector-layer';
export type { ConnectorMarker } from './connector-layer';
export { createThumbnailRenderer } from './thumbnail';
export { themeColor } from './theme';
export { createBuildAnimationView } from './build-animation';
export type { BuildAnimationView, BuildAnimationViewOptions } from './build-animation';

export type { ViewPreset } from './framing';
export type { EdgeMode } from './document-projection';
export type { ReviewOverlay } from './review-layer';
export type { TaskPreview } from './task-preview-layer';
export interface ViewportOptions {
  preferWebGPU?: boolean;
}
export interface Viewport extends EditorViewport {
  readonly backend: 'webgpu' | 'webgl2';
  setGrid(options: GridOptions): void;
  fitAll(): void;
  setPreset(preset: ViewPreset): void;
  setProjection(mode: 'perspective' | 'ortho'): void;
  addPlaceholderBrick(): void;
  setParts(instances: readonly PartInstance[], colors?: readonly ColorDef[]): void;
  requestRender(): void;
  getCamera(): Workspace['camera'] & { span: number };
  restoreCamera(value: Workspace['camera'], span?: number): void;
  /** User gestures and explicit view commands; workspace restoration does not fire this. */
  onCameraInteraction(listener: () => void): () => void;
  refreshCameraClipping(): void;
  contentVisibility(): ReturnType<typeof cameraBoundsVisibility> | null;
  captureLatest(): Uint8Array | undefined;
  capture(options?: {
    width?: number;
    height?: number;
    scale?: number;
    transparent?: boolean;
    hideGrid?: boolean;
  }): Promise<Uint8Array>;
  dispose(): void;
}

/** World-space content bounds against a view-projection matrix, without changing either input. */
export function cameraBoundsVisibility(
  bounds: Box3,
  viewProjection: Matrix4,
  coordinateSystem: CoordinateSystem = WebGLCoordinateSystem,
) {
  const points = boundsCorners(bounds).map((point) => point.applyMatrix4(viewProjection));
  return {
    intersects: new Frustum().setFromProjectionMatrix(viewProjection, coordinateSystem).intersectsBox(bounds),
    contained: points.every(
      (point) =>
        Math.abs(point.x) <= 1 &&
        Math.abs(point.y) <= 1 &&
        point.z >= (coordinateSystem === WebGPUCoordinateSystem ? 0 : -1) &&
        point.z <= 1,
    ),
    width: (Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x))) / 2,
    height: (Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y))) / 2,
  };
}

export async function createViewport(container: HTMLElement, options: ViewportOptions = {}): Promise<Viewport> {
  const renderer = new WebGPURenderer({ antialias: true, alpha: true, forceWebGL: options.preferWebGPU === false });
  // WebGPURenderer initializes WebGL2 itself when no usable WebGPU adapter is available.
  // Nothing is attached to the document until initialization succeeds.
  await renderer.init();
  renderer.toneMapping = ACESFilmicToneMapping;
  const backend = 'isWebGPUBackend' in renderer.backend && renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
  renderer.setClearColor(0, 0);
  const surface = document.createElement('div');
  surface.className = 'brickloop-viewport';
  surface.dataset.backend = backend;
  surface.dataset.projection = 'perspective';
  Object.assign(surface.style, {
    position: 'relative',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    background: `linear-gradient(var(--bl-viewport-top, ${viewportColors['viewport-top']}), var(--bl-viewport-bottom, ${viewportColors['viewport-bottom']}))`,
  });
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.touchAction = 'none';
  const axes = createAxisIndicator();
  surface.append(canvas, axes.element);
  container.append(surface);
  const scene = new Scene();
  const ldrawRoot = createLdrawRoot();
  const content = createContentLayer();
  const legacyPreview = createContentLayer();
  content.add(legacyPreview);
  let grid = createGrid(defaultGrid, container);
  ldrawRoot.add(content, grid);
  scene.add(ldrawRoot);
  scene.add(new HemisphereLight(themeColor(container, 'light-sky'), themeColor(container, 'light-ground'), 2));
  const keyLight = new DirectionalLight(themeColor(container, 'light-key'), 3.5);
  keyLight.position.set(-150, 250, 200);
  const fillLight = new DirectionalLight(themeColor(container, 'light-fill'), 1);
  fillLight.position.set(200, 80, -150);
  scene.add(keyLight, fillLight);

  const fov = 35;
  let width = Math.max(1, container.clientWidth);
  let height = Math.max(1, container.clientHeight);
  let camera: PerspectiveCamera | OrthographicCamera = new PerspectiveCamera(fov, width / height, 0.1, 10000);
  camera.position.set(160, 140, 160);
  let disposed = false;
  let observedWidth = -1,
    observedHeight = -1,
    observedRatio = 0;
  let sizedWidth = -1,
    sizedHeight = -1,
    sizedRatio = 0;
  const scheduler = createRenderScheduler({
    render: renderFrame,
    settle: applySize,
    visible: () => document.visibilityState === 'visible',
    report: (error) => console.error('Viewport frame failed', error),
  });
  let renderedFrames = 0;
  let cameraGesture: { x: number; y: number } | undefined;
  const cameraInteractions = new Set<() => void>();
  const cameraInteraction = () => cameraInteractions.forEach((listener) => listener());
  // Convert before OrbitControls handles a camera gesture. Keep the same controls object
  // so pointer capture and an in-progress gesture survive the camera replacement.
  function beginCameraGesture(event: PointerEvent): void {
    if (
      camera instanceof OrthographicCamera &&
      (event.button === 1 || event.button === 2 || (event.button === 0 && event.altKey))
    )
      cameraGesture = { x: event.clientX, y: event.clientY };
  }
  function moveCameraGesture(event: PointerEvent): void {
    if (cameraGesture && Math.hypot(event.clientX - cameraGesture.x, event.clientY - cameraGesture.y) >= 4) {
      cameraGesture = undefined;
      changeProjection('perspective', true);
    }
  }
  function endCameraGesture(): void {
    cameraGesture = undefined;
  }
  canvas.addEventListener('pointerdown', beginCameraGesture, true);
  canvas.addEventListener('pointermove', moveCameraGesture, true);
  canvas.addEventListener('pointerup', endCameraGesture, true);
  canvas.addEventListener('pointercancel', endCameraGesture, true);
  let controls = makeControls();
  const editor = createEditorViewport({
    canvas,
    surface,
    content,
    scene,
    renderer,
    camera: () => camera,
    controls: () => controls,
    requestRender,
    fitBounds: (bounds) =>
      applyFrame(
        fitBounds({
          bounds,
          fov,
          aspect: width / height,
          direction: camera.position.clone().sub(controls.target),
          up: camera.up,
        }),
      ),
  });

  const recentFrame = document.createElement('canvas');
  recentFrame.width = recentFrame.height = 512;
  let recentAt = -Infinity;
  let recentDocument = '';
  function requestRender(): void {
    scheduler.request();
  }
  function renderFrame(): void {
    if (disposed || container.clientWidth === 0 || container.clientHeight === 0) return;
    editor.render();
    {
      const ctx = recentFrame.getContext('2d');
      if (ctx) {
        ctx.fillStyle = themeColor(container, 'viewport-bottom');
        ctx.fillRect(0, 0, 512, 512);
        ctx.drawImage(canvas, 0, 0, 512, 512);
        recentAt = performance.now();
      }
    }
    axes.update(camera);
    surface.dataset.renderCount = String(++renderedFrames);
  }

  function makeControls(target = new Vector3()): OrbitControls {
    const next = new OrbitControls(camera, canvas);
    next.target.copy(target);
    next.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.PAN };
    next.zoomToCursor = true;
    next.enableDamping = false;
    next.minDistance = 1;
    next.maxDistance = 100000;
    next.minZoom = 0.001;
    next.maxZoom = 1000;
    next.addEventListener('change', onCameraChange);
    next.addEventListener('start', cameraInteraction);
    next.update();
    return next;
  }

  function onCameraChange(): void {
    const started = performance.now();
    // Extend clipping as zoom changes; include the ground as well as model content.
    const bounds = visibleContentBounds(content);
    const radius = bounds.getSize(new Vector3()).length() + 1280;
    const distance = camera.position.distanceTo(bounds.getCenter(new Vector3()));
    camera.near = Math.max(0.01, (distance - radius) / 100);
    camera.far = Math.max(2000, distance + radius * 2);
    camera.updateProjectionMatrix();
    surface.dataset.cameraUpdateMs = String(performance.now() - started);
    requestRender();
  }

  function resetControls(target: Vector3): void {
    controls.removeEventListener('change', onCameraChange);
    controls.removeEventListener('start', cameraInteraction);
    controls.dispose();
    controls = makeControls(target);
  }

  function setOrthoSpan(span: number): void {
    if (!(camera instanceof OrthographicCamera)) return;
    camera.zoom = 1;
    camera.top = span / 2;
    camera.bottom = -span / 2;
    camera.right = (span * width) / height / 2;
    camera.left = -camera.right;
  }

  function changeProjection(mode: 'perspective' | 'ortho', preserveGesture = false): void {
    if (disposed || (mode === 'perspective') === camera instanceof PerspectiveCamera) return;
    const previous = camera;
    const target = controls.target.clone();
    if (mode === 'ortho') {
      const span = perspectiveSpan(previous.position.distanceTo(target), fov);
      camera = new OrthographicCamera();
      setOrthoSpan(span);
      camera.position.copy(previous.position);
    } else {
      const ortho = previous as OrthographicCamera;
      const distance = perspectiveDistance((ortho.top - ortho.bottom) / ortho.zoom, fov);
      camera = new PerspectiveCamera(fov, width / height);
      camera.position.copy(previous.position).sub(target).normalize().multiplyScalar(distance).add(target);
      delete surface.dataset.preset;
    }
    camera.up.copy(previous.up);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    if (preserveGesture) {
      controls.object = camera;
      controls.update();
    } else resetControls(target);
    surface.dataset.projection = mode;
    onCameraChange();
  }

  function applyFrame(frame: Frame): void {
    camera.position.copy(frame.position);
    camera.up.copy(frame.up);
    camera.near = frame.near;
    camera.far = frame.far;
    setOrthoSpan(frame.orthoHeight);
    camera.lookAt(frame.target);
    camera.updateProjectionMatrix();
    resetControls(frame.target);
    onCameraChange();
  }

  function applySize(): void {
    if (disposed) return;
    const nextWidth = container.clientWidth,
      nextHeight = container.clientHeight;
    const ratio = Math.min(window.devicePixelRatio, 2);
    if (!nextWidth || !nextHeight) return;
    if (nextWidth === sizedWidth && nextHeight === sizedHeight && ratio === sizedRatio) return;
    try {
      if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
      renderer.setSize(nextWidth, nextHeight);
      width = nextWidth;
      height = nextHeight;
      if (camera instanceof PerspectiveCamera) camera.aspect = width / height;
      else {
        const span = (camera.top - camera.bottom) / camera.zoom;
        setOrthoSpan(span);
      }
      camera.updateProjectionMatrix();
      // Commit only after success, so the settle pass can retry a transient failure.
      sizedWidth = width;
      sizedHeight = height;
      sizedRatio = ratio;
    } catch (error) {
      console.error('Viewport resize failed', error);
    }
  }
  function resize(): void {
    if (disposed) return;
    const nextWidth = container.clientWidth,
      nextHeight = container.clientHeight;
    const ratio = Math.min(window.devicePixelRatio, 2);
    const changed = nextWidth !== observedWidth || nextHeight !== observedHeight || ratio !== observedRatio;
    observedWidth = nextWidth;
    observedHeight = nextHeight;
    observedRatio = ratio;
    if (!changed && sizedWidth === nextWidth && sizedHeight === nextHeight && sizedRatio === ratio) return;
    applySize();
    scheduler.resized();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', scheduler.visibilityChanged);
  window.addEventListener('focus', requestRender);
  resize();

  return {
    ...editor.api,
    syncDocument(doc, workspace, colors) {
      if (recentDocument !== doc.documentId) {
        recentDocument = doc.documentId;
        recentAt = -Infinity;
      }
      editor.api.syncDocument(doc, workspace, colors);
    },
    backend,
    onCameraInteraction(listener) {
      cameraInteractions.add(listener);
      return () => {
        cameraInteractions.delete(listener);
      };
    },
    refreshCameraClipping: onCameraChange,
    contentVisibility() {
      // Unlike visibleContentBounds, selectionBounds has no synthetic fallback for an empty scene.
      const bounds = editor.api.selectionBounds();
      if (!bounds) return null;
      const worldBounds = new Box3(
        new Vector3(bounds[0], -bounds[4], -bounds[5]),
        new Vector3(bounds[3], -bounds[1], -bounds[2]),
      );
      camera.updateMatrixWorld();
      return cameraBoundsVisibility(
        worldBounds,
        new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        camera.coordinateSystem,
      );
    },
    fitSelection(paths) {
      cameraInteraction();
      editor.api.fitSelection(paths);
    },
    getCamera() {
      return {
        mode: camera instanceof PerspectiveCamera ? 'perspective' : 'ortho',
        position: [camera.position.x, -camera.position.y, -camera.position.z],
        target: [controls.target.x, -controls.target.y, -controls.target.z],
        up: [camera.up.x, -camera.up.y, -camera.up.z],
        fov: camera instanceof PerspectiveCamera ? camera.fov : fov,
        span:
          camera instanceof OrthographicCamera
            ? (camera.top - camera.bottom) / camera.zoom
            : perspectiveSpan(camera.position.distanceTo(controls.target), fov),
      };
    },
    restoreCamera(value, span = 300) {
      camera =
        value.mode === 'ortho'
          ? new OrthographicCamera()
          : new PerspectiveCamera(value.fov, width / height, 0.1, 10000);
      setOrthoSpan(span);
      camera.position.set(value.position[0], -value.position[1], -value.position[2]);
      camera.up.set(value.up[0], -value.up[1], -value.up[2]);
      const target = new Vector3(value.target[0], -value.target[1], -value.target[2]);
      camera.lookAt(target);
      resetControls(target);
      surface.dataset.projection = value.mode;
      onCameraChange();
    },
    captureLatest() {
      if (recentAt === -Infinity) return undefined;
      const data = atob(recentFrame.toDataURL('image/png').split(',')[1]!);
      return Uint8Array.from(data, (letter) => letter.charCodeAt(0));
    },
    async capture(options = {}) {
      const w = options.width ?? Math.round(width * (options.scale ?? 1));
      const h = options.height ?? Math.round(height * (options.scale ?? 1));
      const ratio = renderer.getPixelRatio(),
        gridVisible = grid.visible;
      const output = document.createElement('canvas');
      output.width = w;
      output.height = h;
      const ctx = output.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      try {
        renderer.setPixelRatio(1);
        renderer.setSize(w, h, false);
        if (camera instanceof PerspectiveCamera) camera.aspect = w / h;
        else {
          camera.right = (camera.top * w) / h;
          camera.left = -camera.right;
        }
        camera.updateProjectionMatrix();
        if (options.hideGrid) grid.visible = false;
        editor.capture();
        if (!options.transparent) {
          const gradient = ctx.createLinearGradient(0, 0, 0, h);
          gradient.addColorStop(0, themeColor(container, 'viewport-top'));
          gradient.addColorStop(1, themeColor(container, 'viewport-bottom'));
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(canvas, 0, 0, w, h);
        const data = atob(output.toDataURL('image/png').split(',')[1]!);
        return Uint8Array.from(data, (letter) => letter.charCodeAt(0));
      } finally {
        grid.visible = gridVisible;
        renderer.setPixelRatio(ratio);
        sizedWidth = -1; // capture() temporarily resized the renderer outside applySize().
        resize();
      }
    },
    setGrid(options) {
      if (disposed) return;
      const next = createGrid(options, container);
      next.position.y = grid.position.y;
      ldrawRoot.remove(grid);
      disposeObjects(grid);
      grid = next;
      ldrawRoot.add(grid);
      requestRender();
    },
    fitAll() {
      if (disposed) return;
      cameraInteraction();
      applyFrame(
        fitBounds({
          bounds: visibleContentBounds(content),
          fov,
          aspect: width / height,
          direction: camera.position.clone().sub(controls.target),
          up: camera.up,
        }),
      );
    },
    setPreset(preset) {
      if (disposed) return;
      cameraInteraction();
      changeProjection(preset === 'iso' ? 'perspective' : 'ortho');
      // A restored workspace may use another FOV (the default is 45). Presets use
      // the viewport's 35-degree framing, just as they do on initial creation.
      if (camera instanceof PerspectiveCamera) camera.fov = fov;
      applyFrame(presetFrame(visibleContentBounds(content), fov, width / height, preset));
      surface.dataset.preset = preset;
    },
    setProjection(mode) {
      cameraInteraction();
      changeProjection(mode);
    },
    addPlaceholderBrick() {
      if (disposed) return;
      addPlaceholder(legacyPreview);
      requestRender();
    },
    setParts(instances, colors = []) {
      if (disposed) return;
      disposeObjects(legacyPreview);
      legacyPreview.add(createPartInstances(instances, colors));
      grid.position.y = instances.length ? Math.max(0, -visibleContentBounds(content).min.y) : 0;
      surface.dataset.partCount = String(instances.length);
      requestRender();
    },
    requestRender,
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduler.dispose();
      observer.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', scheduler.visibilityChanged);
      window.removeEventListener('focus', requestRender);
      canvas.removeEventListener('pointerdown', beginCameraGesture, true);
      canvas.removeEventListener('pointermove', moveCameraGesture, true);
      canvas.removeEventListener('pointerup', endCameraGesture, true);
      canvas.removeEventListener('pointercancel', endCameraGesture, true);
      controls.removeEventListener('change', onCameraChange);
      controls.removeEventListener('start', cameraInteraction);
      cameraInteractions.clear();
      controls.dispose();
      editor.dispose();
      disposeObjects(ldrawRoot);
      scene.clear();
      void renderer.dispose().catch((error) => console.error('Viewport disposal failed', error));
      surface.remove();
    },
  };
}
export { renderOffscreen } from './offscreen';
