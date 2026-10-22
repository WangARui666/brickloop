import { afterEach, expect, it, vi } from 'vitest';
import { createDocument, createWorkspace, identity } from '@brickloop/core';
import { solvePreview } from '../src/renderer/src/assembly-store';
import { assemblyReady, refreshChecks, updateAssembly, useAssemblyStore } from '../src/renderer/src/assembly-store';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('opens with checking pending, coalesces manual/automatic checks, and checks the committed revision', async () => {
  vi.useFakeTimers();
  const checks: (() => void)[] = [];
  let checkCount = 0;
  class FakeWorker {
    onmessage: ((event: MessageEvent<{ id: number; result: unknown }>) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage(job: { id: number; kind: string }) {
      const reply = (result: unknown) =>
        this.onmessage?.({ data: { id: job.id, result } } as MessageEvent<{ id: number; result: unknown }>);
      if (job.kind === 'sync') queueMicrotask(() => reply({ markers: [], edges: [], components: [] }));
      if (job.kind === 'check') {
        checkCount++;
        checks.push(() =>
          reply({
            issues: [],
            durationMs: 1,
            collision: { status: 'none', pairs: [], unknownPaths: [], reasons: [], testedPairs: 0 },
          }),
        );
      }
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('location', { href: 'http://127.0.0.1/' });
  vi.stubGlobal('window', { brickloop: { assemblyCatalog: async () => ({ parts: [], colors: [] }) } });
  const doc = createDocument(),
    workspace = createWorkspace();
  updateAssembly(doc, workspace, null);
  expect(useAssemblyStore.getState()).toMatchObject({ ready: false, checking: true });
  const fallback = Array.from(identity());
  fallback[12] = 20;
  const preview = await solvePreview({
    selection: [{ path: ['$preview'], partId: 'ld:3001', matrix: fallback, fallback }],
    primaryPath: ['$preview'],
    enabled: true,
    collision: true,
    continuous: false,
  });
  expect(preview.transforms[0]?.transform[12]).toBe(20);
  expect(preview.collision.status).toBe('unknown');
  await assemblyReady();
  const first = refreshChecks();
  await vi.advanceTimersByTimeAsync(300);
  const second = refreshChecks();
  await vi.advanceTimersByTimeAsync(300);
  expect(checkCount).toBe(1);
  checks.shift()!();
  await Promise.all([first, second]);
  expect(useAssemblyStore.getState().checking).toBe(false);
  const committed = { ...doc, revision: 1 };
  updateAssembly(committed, workspace, null);
  expect(useAssemblyStore.getState().checking).toBe(true);
  await assemblyReady();
  const next = refreshChecks();
  await vi.advanceTimersByTimeAsync(300);
  expect(checkCount).toBe(2);
  checks.shift()!();
  await next;
  expect(useAssemblyStore.getState().lastChecks[doc.documentId]?.revision).toBe(1);
  expect(useAssemblyStore.getState().checking).toBe(false);
  useAssemblyStore.setState({ scope: 'selection' });
  updateAssembly(committed, { ...workspace, selection: [['selected']] }, null);
  expect(useAssemblyStore.getState().checking).toBe(true);
  await vi.advanceTimersByTimeAsync(300);
  expect(checkCount).toBe(3);
  checks.shift()!();
  await vi.advanceTimersByTimeAsync(0);
  expect(useAssemblyStore.getState().checking).toBe(false);
});
