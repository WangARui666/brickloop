import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { finishPageErrorGuards, guardPageErrors } from '../e2e/page-errors';

function application() {
  const page = new EventEmitter();
  const emitter = new EventEmitter();
  const close = vi.fn(async () => {
    emitter.emit('close');
  });
  const app = Object.assign(emitter, { windows: () => [page], close }) as unknown as ElectronApplication;
  return { app, page, close, emitter };
}
const info = { attach: vi.fn<TestInfo['attach']>(async () => {}) };
beforeEach(() => {
  vi.useFakeTimers();
  info.attach.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('M12-29 page-error guard', () => {
  it('rejects uncaught errors from existing and later windows, with six stack lines', async () => {
    const { app, page, close, emitter } = application();
    const guard = guardPageErrors(app);
    const error = new Error('first window');
    error.stack = Array.from({ length: 9 }, (_, i) => `stack-${i}`).join('\n');
    page.emit('pageerror', error);
    const later = new EventEmitter();
    emitter.emit('window', later as unknown as Page);
    emitter.emit('window', later as unknown as Page);
    later.emit('pageerror', new Error('later window'));
    const rejected = expect(app.close()).rejects.toThrow(/Uncaught page errors \(2\)/);
    await vi.runAllTimersAsync();
    await rejected;
    expect(close).toHaveBeenCalledTimes(1);
    await expect(guard.finish(info)).rejects.toThrow('later window');
    const body = info.attach.mock.calls[0]![1]!.body as string;
    expect(body).toContain('stack-5');
    expect(body).not.toContain('stack-6');
    expect(page.listenerCount('pageerror')).toBe(0);
    expect(later.listenerCount('pageerror')).toBe(0);
  });

  it('allows only matching declared errors and records the reason, including repeated global matches', async () => {
    const { app, page } = application();
    const guard = guardPageErrors(app, [{ pattern: /^deliberate$/g, reason: 'Intentional test exception' }]);
    page.emit('pageerror', new Error('deliberate'));
    page.emit('pageerror', new Error('deliberate'));
    const finished = guard.finish(info);
    await vi.runAllTimersAsync();
    await finished;
    expect(info.attach).toHaveBeenCalledWith(
      'page-errors',
      expect.objectContaining({
        body: expect.stringContaining('Intentional test exception'),
      }),
    );
  });

  it.each(['', ' \n\t '])('rejects an empty reason %j before installing listeners', (reason) => {
    const { app, emitter } = application();
    expect(() => guardPageErrors(app, [{ pattern: /expected/, reason }])).toThrow('non-empty reason');
    expect(emitter.listenerCount('window')).toBe(0);
  });

  it('catches an error arriving 900 ms after close resolves', async () => {
    const { app, page } = application();
    guardPageErrors(app);
    const rejected = expect(app.close()).rejects.toThrow('late close error');
    setTimeout(() => page.emit('pageerror', new Error('late close error')), 900);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
  });

  it('teardown checks unexpected exits without close and still closes other forgotten apps', async () => {
    const first = application(),
      second = application();
    const guards = [guardPageErrors(first.app), guardPageErrors(second.app)];
    first.emitter.emit('close');
    first.page.emit('pageerror', new Error('unexpected exit error'));
    const rejected = expect(finishPageErrorGuards(guards, info)).rejects.toThrow('unexpected exit error');
    await vi.runAllTimersAsync();
    await rejected;
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(info.attach).toHaveBeenCalledTimes(1);
  });

  it('rechecks errors received after an earlier successful close and does not swallow close failures', async () => {
    const { app, page } = application();
    const guard = guardPageErrors(app);
    const closed = app.close();
    await vi.runAllTimersAsync();
    await closed;
    page.emit('pageerror', new Error('after close'));
    await expect(guard.finish(info)).rejects.toThrow('after close');
    const failed = application();
    failed.close.mockRejectedValue(new Error('close failed'));
    guardPageErrors(failed.app);
    const rejected = expect(failed.app.close()).rejects.toThrow('close failed');
    await vi.runAllTimersAsync();
    await rejected;
  });
});
