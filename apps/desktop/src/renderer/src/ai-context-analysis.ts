import type { BrkDocument } from '@brickloop/core';
import type { Issue } from '@brickloop/collide';
import type { AssemblySnapshot } from './assembly-engine';
import type { CheckOptions } from '@brickloop/collide';
import { loadAssemblyPart } from './assembly-store';
import { createModuleWorker } from './module-worker';
import workerUrl from './ai-check.worker?worker&url';

/** Use the request's exact analysis algorithm without queuing behind (or ahead of)
 * real AI tools. An obsolete estimate can terminate its own Worker safely. */
export async function analyzeContext(doc: BrkDocument, signal: AbortSignal) {
  const parts = await Promise.all(
    [
      ...new Set(
        Object.values(doc.models).flatMap((model) =>
          Object.values(model.instances).flatMap((instance) =>
            instance.ref.kind === 'part' ? [instance.ref.partId] : [],
          ),
        ),
      ),
    ].map(async (id): Promise<AssemblySnapshot['parts'][number]> => [id, await loadAssemblyPart(id)]),
  );
  signal.throwIfAborted();
  const catalog = await window.brickloop.assemblyCatalog();
  signal.throwIfAborted();
  const snapshot: AssemblySnapshot = { doc, parts, collision: true, hidden: [], catalog };
  const options: CheckOptions = {
    collisionEnabled: true,
    collisionBudgetMs: 5000,
    groundIsFixed: true,
    visibleOnly: false,
    grid: false,
    kinds: [
      'collision',
      'collisionUnknown',
      'floating',
      'nonFactoryPart',
      'nonFactoryColor',
      'unavailableColor',
      'duplicate',
      'missingGeometry',
    ],
  };
  const worker = createModuleWorker(workerUrl);
  return new Promise<{ summary: Record<string, unknown>; issues: Issue[] }>((resolve, reject) => {
    const dispose = () => {
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      dispose();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<{ result: { summary: Record<string, unknown>; issues: Issue[] }; error?: string }>,
    ) => {
      dispose();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.result);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      dispose();
      reject(new Error('CONTEXT_ANALYSIS_FAILED'));
    };
    worker.postMessage({ id: 0, summary: true, snapshot, options });
  });
}
