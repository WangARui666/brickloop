import { WebGPURenderer } from 'three/webgpu';
import { buildPartMesh, createMemorySource, LibraryResolver } from '@brickloop/ldraw';
import { createViewport } from '../src/index';
import type { Viewport } from '../src/index';
import type { PartInstance } from '../src/parts';

const host = document.querySelector<HTMLElement>('#host')!;
let viewport: Viewport;
let renderer: WebGPURenderer;
let parts: PartInstance[];
let files: Record<string, string>;
let loading: Promise<void>;
let release: (() => void) | undefined;
let waiting = false;
let injected = 0;
const init = WebGPURenderer.prototype.init;
WebGPURenderer.prototype.init = async function () {
  // eslint-disable-next-line @typescript-eslint/no-this-alias -- Retain the real renderer only for one-shot fault injection.
  renderer = this;
  return init.call(this);
};
const frames = () => Number(host.querySelector<HTMLElement>('.brickloop-viewport')?.dataset.renderCount ?? 0);
function resize(width = 700, height = 420) {
  const before = frames();
  Object.assign(host.style, { width: `${width}px`, height: `${height}px` });
  return before;
}
async function loadParts() {
  const mesh = await buildPartMesh('3001.dat', new LibraryResolver({ library: createMemorySource('fixture', files) }));
  parts = Array.from({ length: 400 }, (_, i) => ({
    partId: 'ld:3001',
    mesh,
    color: {
      id: 'c:red',
      legoName: 'Red',
      legoColorId: 21,
      nameZh: '红',
      ldrawCode: 4,
      rgb: '#ff0000',
      edgeRgb: '#220000',
      finish: 'solid',
      alpha: 1,
    },
    transform: [((i % 20) - 10) * 100, 0, 6000 + Math.floor(i / 20) * 100, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  }));
  viewport.setParts(parts);
  // The document host calls this after mesh arrival (M11-6 / A-96).
  viewport.refreshCameraClipping();
}

const api = {
  async create(input: { webgl: boolean; files: Record<string, string>; resizeAtCreation?: boolean }) {
    files = input.files;
    viewport = await createViewport(host, { preferWebGPU: !input.webgl });
    // Same microtask as createViewport's resolution, before another frame or ResizeObserver callback.
    const before = input.resizeAtCreation ? resize() : frames();
    await loadParts();
    viewport.fitAll();
    return before;
  },
  resize,
  frames,
  request: () => viewport.requestRender(),
  async capture() {
    return Array.from(await viewport.capture({ hideGrid: true }));
  },
  hidden(value: boolean) {
    const before = frames();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: value ? 'hidden' : 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
    return before;
  },
  dropFrame() {
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      window.requestAnimationFrame = original;
      injected++;
      // A real handle, canceled before dispatch: the consumer never receives its callback.
      const handle = original(callback);
      cancelAnimationFrame(handle);
      return handle;
    };
    viewport.requestRender();
  },
  failNext(method: 'render' | 'setSize') {
    if (method === 'render') {
      const original = renderer.render;
      renderer.render = function () {
        renderer.render = original;
        injected++;
        throw new Error('UI-05 injected render failure');
      };
    } else {
      const original = renderer.setSize;
      renderer.setSize = function () {
        renderer.setSize = original;
        injected++;
        throw new Error('UI-05 injected setSize failure');
      };
    }
  },
  injected: () => injected,
  holdLoad(mode?: 'perspective' | 'ortho') {
    viewport.setParts([]);
    if (mode)
      viewport.restoreCamera(
        {
          mode,
          position: [0, -2000, 0],
          target: [0, -12, 7450],
          up: [0, -1, 0],
          fov: 35,
        },
        3000,
      );
    loading = (async () => {
      waiting = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await loadParts();
      waiting = false;
    })();
  },
  waiting: () => waiting,
  releaseLoad: () => release?.(),
  loaded: () => loading,
  setPartCount: (count: number) => viewport.setParts(parts.slice(0, count)),
  dispose: () => viewport.dispose(),
};
Object.assign(window, { resizeTest: api });
export type ResizeTestApi = typeof api;
