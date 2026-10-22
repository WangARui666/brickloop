import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createI18n } from '@brickloop/i18n';
import { ModelLiveness, formatActivityChars } from '../src/renderer/src/ModelLiveness';
import {
  useAiStore,
  receiveAiEvent,
  clearModelLiveness,
  flushAiStream,
  type ModelLiveness as Value,
} from '../src/renderer/src/ai-store';

vi.mock('../src/renderer/src/store', () => ({ useTranslation: () => createI18n({ language: 'zh-CN' }).t }));
vi.mock('../src/renderer/src/document-store', () => ({ documentLocked: () => false }));
const value = (): Value => ({
  startedAt: 0,
  receivedAt: 1000,
  phase: 'thinking',
  noticeMs: 60_000,
  counts: { type: 'activity', reasoningChars: 1200, contentChars: 0, toolChars: 0 },
});
const render = (v: Value | undefined, now: number, paused = false) =>
  renderToStaticMarkup(createElement(ModelLiveness, { value: v, now, paused }));
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16));
  vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
});
afterEach(() => {
  clearModelLiveness('test');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('formats 999, 1.2K and 1.2M characters', () => {
  expect([999, 1200, 1200000].map(formatActivityChars)).toEqual(['999', '1.2K', '1.2M']);
});
it('shows activity, silence and immediate recovery; only the static warning is live', () => {
  const normal = render(value(), 60999);
  expect(normal).toContain('模型正在思考 · 已生成约 1.2K 字 · 59 秒前有数据');
  expect(normal).toContain('title="模型正在思考 · 已生成约 1.2K 字 · 59 秒前有数据"');
  expect(normal).not.toContain('is-warning');
  const warning = render(value(), 61000);
  expect(warning).toContain('is-warning');
  expect(warning).toContain('已 60 秒没有收到数据');
  expect(warning).toContain('title="已 60 秒没有收到数据，仍在等待服务商响应，可以点击停止"');
  expect(warning).toContain('role="status" aria-live="off"');
  expect(warning).toContain('aria-live="polite" aria-atomic="true">长时间没有收到数据');
  expect(render({ ...value(), receivedAt: 61000 }, 61000)).not.toContain('is-warning');
  // Buffered SDK content must not disguise a connection that stopped receiving bytes.
  expect(render({ ...value(), bytesAt: 1000, receivedAt: 61000 }, 61000)).toContain('is-warning');
});
it('shows waiting before the first event, and hides during pause or after completion', () => {
  expect(render({ ...value(), receivedAt: null }, 3000)).toContain('正在等待服务商响应 · 已 3 秒');
  expect(render({ ...value(), receivedAt: null }, 3000)).toContain('title="正在等待服务商响应 · 已 3 秒"');
  expect(render({ ...value(), receivedAt: null }, 60000)).toContain('已 60 秒没有收到数据');
  expect(render(value(), 3000, true)).toBe('');
  expect(render(undefined, 3000)).toBe('');
});
it('folds the retry countdown into the same titled status line without stale activity or a warning', () => {
  const retry = render({ ...value(), retryUntil: 900000, retryAttempt: 2 }, 60000);
  expect(retry).toContain('class="ai-liveness" role="status" aria-live="off"');
  expect(retry).toContain('title="840 秒后第 2 次重试（最多 10 次）"');
  expect(retry).toContain('<span aria-live="off">840 秒后第 2 次重试（最多 10 次）</span>');
  expect(retry).toContain('aria-live="polite" aria-atomic="true"></span>');
  expect(retry).not.toMatch(/is-warning|模型正在思考|已生成约|没有收到数据/);
  expect(render({ ...value(), retryUntil: 9000 }, 3000)).toContain('6 秒后第 1 次重试（最多 10 次）');
  expect(render({ ...value(), retryUntil: 9000 }, 10000)).toContain('0 秒后第 1 次重试（最多 10 次）');
  expect(render({ ...value(), retryUntil: 9000 }, 3000, true)).toBe('');
});
it('coalesces activity snapshots, tracks the latest increasing category, resets requests and never saves activity', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  useAiStore.setState({ turns: [{ id: 'test', user: '', images: [], text: '', events: [] }] });
  receiveAiEvent('test', { type: 'request_started' });
  receiveAiEvent('test', { type: 'activity', reasoningChars: 10, contentChars: 0, toolChars: 0 });
  flushAiStream('test');
  vi.setSystemTime(100);
  receiveAiEvent('test', { type: 'activity', reasoningChars: 10, contentChars: 20, toolChars: 0 });
  receiveAiEvent('test', { type: 'activity', reasoningChars: 10, contentChars: 20, toolChars: 30 });
  expect(useAiStore.getState().liveness.test?.counts.reasoningChars).toBe(10);
  expect(useAiStore.getState().liveness.test?.phase).toBe('thinking');
  await vi.advanceTimersByTimeAsync(1000);
  expect(useAiStore.getState().liveness.test).toMatchObject({ phase: 'script', receivedAt: 100 });
  expect(useAiStore.getState().turns[0]!.events).toEqual([]);
  receiveAiEvent('test', { type: 'request_started' });
  expect(useAiStore.getState().liveness.test?.receivedAt).toBeNull();
  receiveAiEvent('test', { type: 'activity', reasoningChars: 1, contentChars: 0, toolChars: 0 });
  receiveAiEvent('test', { type: 'done', reason: 'stop' });
  expect(useAiStore.getState().liveness.test).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it('distinguishes content, keep-alive bytes, and no bytes, including a return to content', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  useAiStore.setState({ turns: [{ id: 'test', user: '', images: [], text: '', events: [] }] });
  receiveAiEvent('test', { type: 'request_started' });
  vi.setSystemTime(60000);
  expect(render(useAiStore.getState().liveness.test, 60000)).toContain('is-warning');
  receiveAiEvent('test', { type: 'transport_activity', receivedAt: 60000, bytes: 14 });
  flushAiStream('test');
  const keepAlive = render(useAiStore.getState().liveness.test, 60000);
  expect(keepAlive).toContain('服务商正在排队或处理，连接正常');
  expect(keepAlive).toContain('title="服务商正在排队或处理，连接正常"');
  expect(keepAlive).toContain('role="status" aria-live="off"');
  expect(keepAlive).toContain('aria-live="polite" aria-atomic="true"></span>');
  expect(keepAlive).not.toContain('is-warning');
  expect(useAiStore.getState().liveness.test?.receivedAt).toBeNull();
  expect(useAiStore.getState().liveness.test?.counts.reasoningChars).toBe(0);
  receiveAiEvent('test', { type: 'activity', reasoningChars: 20, contentChars: 0, toolChars: 0 });
  flushAiStream('test');
  expect(render(useAiStore.getState().liveness.test, 60000)).toContain('已生成约 20 字');
  vi.setSystemTime(120000);
  receiveAiEvent('test', { type: 'transport_activity', receivedAt: 120000, bytes: 2 });
  flushAiStream('test');
  expect(render(useAiStore.getState().liveness.test, 120000)).toContain('连接正常');
  expect(render(useAiStore.getState().liveness.test, 180000)).toContain('is-warning');
  expect(useAiStore.getState().turns[0]!.events).toEqual([]);
  receiveAiEvent('test', { type: 'retry', attempt: 2, delayMs: 900000, error: { category: 'server' } });
  expect(useAiStore.getState().liveness.test).toMatchObject({ retryAttempt: 2, retryUntil: 1020000 });
  expect(useAiStore.getState().liveness.test?.bytesAt).toBeUndefined();
  receiveAiEvent('test', { type: 'request_started' });
  expect(useAiStore.getState().liveness.test?.retryAttempt).toBeUndefined();
});
