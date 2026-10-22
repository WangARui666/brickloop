import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBuildScriptWorker } from '../src/renderer/src/buildscript-client';
import { workflowProgress } from '../src/renderer/src/workflow-progress';
import { editorError } from '../src/shared/editor-error';
import { BuildScriptFailure } from '../src/shared/buildscript-document';
import { engineUnavailable } from '../../../packages/buildscript/src/errors';
import type { WorkflowState } from '@brickloop/ai';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => vi.stubGlobal('location', { href: 'http://127.0.0.1/' }));

describe('build failures across the editor boundary', () => {
  it('retains a script error code, location, and explanation', () => {
    expect(
      editorError(new BuildScriptFailure('SYNTAX', 'unexpected token', { line: 4, column: 8 }), 'run_build_script'),
    ).toEqual({ ok: false, code: 'SYNTAX', message: 'unexpected token', details: { line: 4, column: 8 } });
  });
  it.each([
    'WebAssembly.instantiate(): unsafe-eval Content Security Policy',
    'fetch wasm failed: https://user:secret@host?token=secret',
    'Worker crashed',
  ])('reports safe engine diagnostics: %s', (message) => {
    const result = editorError(new Error(message), 'run_build_script');
    expect(result.code).toBe('ENGINE_UNAVAILABLE');
    expect(result.message).not.toContain('secret');
    expect(result.message).toBe(engineUnavailable(new Error(message)).message);
  });
  it('does not misclassify an unrelated closed task as an engine failure', () => {
    expect(editorError(new Error('TASK_CLOSED'), 'run_build_script').code).toBe('EDITOR_OPERATION_FAILED');
  });
  it('classifies Worker construction failures', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('Worker startup failed');
        }
      },
    );
    expect(await runBuildScriptWorker('', { catalog: { parts: [], colors: [] }, scope: 'all' })).toMatchObject({
      ok: false,
      code: 'ENGINE_UNAVAILABLE',
    });
  });
  it('classifies a crashed or unresponsive Worker and terminates it', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    let crash: (() => void) | undefined;
    vi.stubGlobal(
      'Worker',
      class {
        onerror?: (event: { preventDefault(): void; message: string }) => void;
        terminate = terminate;
        postMessage() {
          crash = () => this.onerror?.({ preventDefault() {}, message: 'Worker crashed' });
        }
      },
    );
    const options = { catalog: { parts: [], colors: [] }, scope: 'all' as const };
    const result = runBuildScriptWorker('', options);
    crash!();
    expect(await result).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    const unresponsive = runBuildScriptWorker('', options);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await unresponsive).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    expect(terminate).toHaveBeenCalledTimes(2);
  });
});

it('coalesces progress bursts per task without losing the newest state or receive time', () => {
  vi.useFakeTimers();
  const publish = vi.fn(),
    progress = workflowProgress(publish);
  const state: WorkflowState = {
    phase: 'understanding',
    paused: false,
    awaitingConfirmation: false,
    documentLocked: false,
    componentId: null,
    componentIndex: 0,
    round: 0,
    toolCalls: 0,
    elapsedMs: 0,
  };
  for (let i = 0; i < 1000; i++) progress.push('a', { ...state, elapsedMs: i });
  progress.push('b', { ...state, paused: true });
  const receivedAt = Date.now();
  expect(publish).not.toHaveBeenCalled();
  vi.advanceTimersByTime(16);
  expect(publish.mock.calls).toEqual([
    ['a', { ...state, elapsedMs: 999 }, receivedAt],
    ['b', { ...state, paused: true }, receivedAt],
  ]);
  progress.push('a', { ...state, phase: 'finished' });
  progress.flush();
  vi.advanceTimersByTime(16);
  expect(publish).toHaveBeenCalledTimes(3);
});
