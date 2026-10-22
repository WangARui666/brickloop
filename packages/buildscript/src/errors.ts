import type { BuildError } from './types.js';

/** Host diagnostics never echo exception text, URLs, credentials or script contents. */
export function engineUnavailable(error: unknown): BuildError {
  const message = error instanceof Error ? error.message : String(error);
  const reason = /content security policy|unsafe-eval|wasm-unsafe-eval/i.test(message)
    ? 'WebAssembly was blocked by the application security policy.'
    : /wasm|webassembly|fetch|instantiate|compile/i.test(message)
      ? 'The WebAssembly module could not be loaded or initialized.'
      : /timed? ?out/i.test(message)
        ? 'The build worker did not respond.'
        : 'The build worker could not start or stopped unexpectedly.';
  return { ok: false, code: 'ENGINE_UNAVAILABLE', message: reason };
}
