import type { BrkDocument } from '@brickloop/core';
import type { Issue } from '@brickloop/collide';
import { loadAssemblyPart } from './assembly-store';
import workerUrl from './ai-check.worker?worker&url';
import { createModuleWorker } from './module-worker';
let worker: Worker | undefined,
  sequence = 0;
interface CheckResult {
  issues: Issue[];
  summary: Record<string, unknown>;
}
const pending = new Map<number, { resolve(value: CheckResult): void; reject(error: Error): void }>();
/** Separate worker from the interactive assembly worker: AI checks cannot starve dragging. */
async function analyze(doc: BrkDocument, modelPath: string[] | undefined, summary: boolean): Promise<CheckResult> {
  const parts = await Promise.all(
    [
      ...new Set(
        Object.values(doc.models).flatMap((model) =>
          Object.values(model.instances).flatMap((instance) =>
            instance.ref.kind === 'part' ? [instance.ref.partId] : [],
          ),
        ),
      ),
    ].map(async (id) => [id, await loadAssemblyPart(id)] as const),
  );
  const catalog = await window.brickloop.assemblyCatalog();
  if (!worker) {
    worker = createModuleWorker(workerUrl);
    worker.onmessage = (event: MessageEvent<{ id: number; result: CheckResult; error?: string }>) => {
      const task = pending.get(event.data.id);
      pending.delete(event.data.id);
      if (event.data.error) task?.reject(new Error(event.data.error));
      else task?.resolve(event.data.result);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      for (const task of pending.values()) task.reject(new Error('ENGINE_UNAVAILABLE: collision Worker stopped'));
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    worker!.postMessage({
      id,
      summary,
      snapshot: { doc, parts, collision: true, hidden: [], catalog },
      options: {
        collisionEnabled: true,
        // Offline AI validation runs in its own worker; interactive checks keep their 100 ms cap.
        collisionBudgetMs: 5000,
        groundIsFixed: true,
        visibleOnly: false,
        grid: false,
        ...(modelPath ? { scope: 'currentModel', activeModelPath: modelPath } : {}),
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
      },
    });
  });
}
export const checkAiDocument = async (doc: BrkDocument, modelPath?: string[]) =>
  (await analyze(doc, modelPath, false)).issues;
export const summarizeAiDocument = (doc: BrkDocument, modelPath?: string[]) => analyze(doc, modelPath, true);
