import type { BuildOptions, BuildResult, BuildError } from '../../shared/buildscript-catalog';
import { engineUnavailable } from '../../../../../packages/buildscript/src/errors';
import workerUrl from './buildscript.worker?worker&url';
import { createModuleWorker } from './module-worker';

/** Each job has its own Worker: concurrent AI task copies never share a QuickJS runtime. */
export function runBuildScriptWorker(code: string, options: BuildOptions): Promise<BuildResult | BuildError> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = createModuleWorker(workerUrl);
    } catch (error) {
      resolve(engineUnavailable(error));
      return;
    }
    const finish = (result: BuildResult | BuildError) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    // Backstop includes WASM startup; QuickJS enforces the ten-second computation budget itself.
    const timer = setTimeout(() => finish(engineUnavailable('Build worker timed out')), 30_000);
    worker.onmessage = (event: MessageEvent<BuildResult | BuildError>) => finish(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      finish(engineUnavailable(event.message));
    };
    worker.onmessageerror = () => finish(engineUnavailable('Worker message failed'));
    try {
      worker.postMessage({ code, options });
    } catch (error) {
      finish(engineUnavailable(error));
    }
  });
}
