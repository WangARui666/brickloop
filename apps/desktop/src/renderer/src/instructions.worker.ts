import { renderInstructionsPdf } from '@brickloop/instructions';
import type { InstructionPlan, InstructionHost } from '@brickloop/instructions';

const pending = new Map<number, { resolve(bytes: Uint8Array): void; reject(error: Error): void }>();
let serial = 0;
function render(kind: 'step' | 'part', request: unknown): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    postMessage({ type: kind, id, request });
  });
}
self.onmessage = (
  event: MessageEvent<
    | { type: 'start'; plan: InstructionPlan; fonts: InstructionHost['fonts'] }
    | { type: 'image'; id: number; bytes?: Uint8Array; error?: string }
  >,
) => {
  const data = event.data;
  if (data.type === 'image') {
    const task = pending.get(data.id);
    pending.delete(data.id);
    if (data.bytes) task?.resolve(data.bytes);
    else task?.reject(new Error(data.error ?? 'Rendering failed'));
    return;
  }
  void renderInstructionsPdf(data.plan, {
    fonts: data.fonts,
    renderStep: (request) => render('step', request),
    renderPart: (request) => render('part', request),
    onProgress: (progress) => postMessage({ type: 'progress', ...progress }),
  })
    .then((bytes) => postMessage({ type: 'done', bytes }, { transfer: [bytes.buffer] }))
    .catch((error: unknown) =>
      postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
};
