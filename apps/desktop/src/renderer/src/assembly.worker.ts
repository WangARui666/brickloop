import { AssemblyEngine } from './assembly-engine';
import type { AssemblySnapshot, PreviewRequest } from './assembly-engine';
import type { CheckOptions } from '@brickloop/collide';
const engine = new AssemblyEngine();
type Request = { id: number } & (
  | { kind: 'sync'; value: AssemblySnapshot }
  | { kind: 'preview'; value: PreviewRequest }
  | { kind: 'check'; value: CheckOptions }
);
self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    const result =
      request.kind === 'sync'
        ? engine.sync(request.value)
        : request.kind === 'preview'
          ? engine.preview(request.value)
          : engine.check(request.value);
    self.postMessage({ id: request.id, result });
  } catch (error) {
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
