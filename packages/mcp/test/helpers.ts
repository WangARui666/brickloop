import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpTools, type McpEditorHost } from '../src/tools.js';
import { toolResultSchema } from '../src/protocol.js';
import type { JsonValue, ToolResult } from '@brickloop/ai';

export function endpoint(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\brickloop-mcp-test-${randomUUID()}`
    : join(tmpdir(), `bl-${randomUUID()}`, 'host.sock');
}
export const ok = (data: JsonValue = {}): ToolResult => ({ ok: true, data, introducedIssues: [], warnings: [] });
export function fakeHost(): McpEditorHost {
  const methods = Object.fromEntries(createMcpTools().map((tool) => [tool.name, vi.fn().mockResolvedValue(ok())]));
  // All required methods are generated from the public tool definitions.
  return {
    ...methods,
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
  } as unknown as McpEditorHost;
}
export async function stdioClient(pipeName: string, timeoutMs = 5_000) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('packages/mcp/bin/brickloop-mcp.mjs'), '--pipe', pipeName, '--timeout-ms', String(timeoutMs)],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: 'offline-test-agent', version: '1.0' });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}
export function unpack(result: Awaited<ReturnType<Client['callTool']>>): ToolResult {
  if (!('content' in result) || !Array.isArray(result.content)) throw new Error('Expected MCP content.');
  const text = result.content.find((block) => block.type === 'text');
  if (!text || typeof text.text !== 'string') throw new Error('Expected text result.');
  const value: unknown = JSON.parse(text.text);
  return toolResultSchema.parse(value);
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
