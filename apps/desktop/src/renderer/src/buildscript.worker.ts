import { runBuildScript } from '../../../../../packages/buildscript/src/sandbox';
import type { BuildOptions } from '../../shared/buildscript-catalog';
import { engineUnavailable } from '../../../../../packages/buildscript/src/errors';

self.onmessage = async (event: MessageEvent<{ code: string; options: BuildOptions }>) => {
  try {
    self.postMessage(await runBuildScript(event.data.code, event.data.options));
  } catch (error) {
    self.postMessage(engineUnavailable(error));
  }
};
