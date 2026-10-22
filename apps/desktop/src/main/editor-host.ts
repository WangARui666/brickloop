import { randomUUID } from 'node:crypto';
import { toolSchemas } from '@brickloop/ai';
import type { EditorHost } from '@brickloop/ai';
import type { DocumentsHost } from '@brickloop/mcp';
import type { HostRequest, HostReply } from '../shared/ai-api';

export type EditorRpc = (method: string, input: unknown, owner: 'ai' | 'mcp', taskId?: string) => Promise<unknown>;
export function createEditorHost(call: EditorRpc, owner: 'ai' | 'mcp', taskId?: string): EditorHost & DocumentsHost {
  // The keys originate from the single public tool schema; results are validated in the renderer adapter.
  return Object.fromEntries(
    [
      ...Object.keys(toolSchemas),
      'list_documents',
      'open_document',
      'set_active_document',
      'beginTransaction',
      'commitTransaction',
    ].map((method) => [method, (input: unknown = {}) => call(method, input, owner, taskId)]),
  ) as EditorHost & DocumentsHost;
}
export function createEditorRpc(send: (request: HostRequest) => void) {
  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  const call: EditorRpc = (method, input, owner, taskId) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('EDITOR_TIMEOUT'));
      }, 600_000);
      pending.set(id, { resolve, reject, timer });
      try {
        send({ id, method, input, owner, ...(taskId ? { taskId } : {}) });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('EDITOR_UNAVAILABLE'));
      }
    });
  return {
    call,
    reply(reply: HostReply) {
      const item = pending.get(reply.id);
      if (!item) return;
      pending.delete(reply.id);
      clearTimeout(item.timer);
      if (reply.error) item.reject(new Error(reply.error));
      else item.resolve(reply.value);
    },
    close() {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('EDITOR_CLOSED'));
      }
      pending.clear();
    },
  };
}
