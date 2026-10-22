import type { ToolResult } from '@brickloop/ai';
import { engineUnavailable } from '../../../../packages/buildscript/src/errors';
import { BuildScriptFailure } from './buildscript-document';

/** A structured tool result survives IPC without collapsing into EDITOR_OPERATION_FAILED. */
export function editorError(error: unknown, method: string): ToolResult & { ok: false } {
  if (error instanceof BuildScriptFailure)
    return {
      ok: false,
      code: error.code,
      message: error.message,
      details: JSON.parse(JSON.stringify(error.details)) as NonNullable<(ToolResult & { ok: false })['details']>,
    };
  if (method === 'run_build_script' && /wasm|webassembly|worker|quickjs|ENGINE_UNAVAILABLE/i.test(String(error)))
    return engineUnavailable(error);
  return { ok: false, code: 'EDITOR_OPERATION_FAILED', message: 'The editor could not complete the operation.' };
}
