import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderScheduler } from '../src/render-scheduler';

describe('on-demand frame recovery (A-97)', () => {
  let serial: number;
  let frames: Map<number, FrameRequestCallback>;
  let visible: boolean;
  const render = vi.fn();
  const settle = vi.fn();
  const report = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    serial = 0;
    frames = new Map();
    visible = true;
    vi.clearAllMocks();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.set(++serial, callback);
        return serial;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => frames.delete(id)),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const make = () => createRenderScheduler({ render, settle, visible: () => visible, report });
  function frame() {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  }

  it('coalesces requests, clears all timers after a frame, and does no idle work', () => {
    const scheduler = make();
    for (let i = 0; i < 100; i++) scheduler.request();
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    frame();
    expect(render).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(render).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    scheduler.dispose();
  });
  it('requests an immediate frame and only one trailing redraw after a resize burst', () => {
    const scheduler = make();
    for (let i = 0; i < 40; i++) {
      scheduler.resized();
      frame();
      vi.advanceTimersByTime(8);
    }
    expect(settle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(91);
    expect(settle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settle).toHaveBeenCalledTimes(1);
    frame();
    expect(render).toHaveBeenCalledTimes(41);
    expect(vi.getTimerCount()).toBe(0);
    scheduler.dispose();
  });
  it('replaces a stalled frame after one second and ignores its late callback', () => {
    const scheduler = make();
    scheduler.request();
    const lost = frames.get(serial)!;
    vi.advanceTimersByTime(999);
    expect(serial).toBe(1);
    vi.advanceTimersByTime(1);
    expect(serial).toBe(2);
    lost(1000);
    expect(render).not.toHaveBeenCalled();
    frame();
    expect(render).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    scheduler.dispose();
  });
  it('does not poll a hidden page; becoming visible replaces a possibly lost frame', () => {
    const scheduler = make();
    scheduler.request();
    visible = false;
    scheduler.visibilityChanged();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(serial).toBe(1);
    visible = true;
    scheduler.visibilityChanged();
    expect(serial).toBe(2);
    frame();
    expect(render).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    scheduler.dispose();
  });
  it('logs a thrown frame and allows a subsequent request, including a request made during rendering', () => {
    const scheduler = make();
    const failure = new Error('render failure');
    render.mockImplementationOnce(() => {
      scheduler.request();
      throw failure;
    });
    scheduler.request();
    frame();
    expect(report).toHaveBeenCalledWith(failure);
    expect(frames.size).toBe(1);
    frame();
    expect(render).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    scheduler.request();
    frame();
    expect(render).toHaveBeenCalledTimes(3);
    scheduler.dispose();
  });
  it('disposal cancels a pending frame, watchdog and settle, and rejects further requests', () => {
    const scheduler = make();
    scheduler.resized();
    const late = frames.get(serial)!;
    scheduler.dispose();
    scheduler.resized();
    scheduler.request();
    scheduler.visibilityChanged();
    late(1);
    vi.advanceTimersByTime(5000);
    expect(render).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
