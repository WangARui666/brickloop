import { vi } from 'vitest';
import { createEditorTools, type EditorHost, type ToolResult } from '../src/tools/index.js';
import type { ChatRequest, ImageBlock, JsonValue } from '../src/types.js';
export const image: ImageBlock = { type: 'image', mime: 'image/png', base64: 'aGVsbG8=' };
export const ok = (data: JsonValue = {}): ToolResult => ({ ok: true, data, introducedIssues: [], warnings: [] });
export function fakeHost(): EditorHost {
  const methods = Object.fromEntries(createEditorTools().map((t) => [t.name, vi.fn().mockResolvedValue(ok())]));
  // Every schema name is generated above; the dynamic object cannot express the mapped host type.
  return {
    ...methods,
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commitTransaction: vi.fn().mockResolvedValue(undefined),
  } as unknown as EditorHost;
}
export const request = (): ChatRequest => ({
  model: 'test-model',
  system: 'Stable system',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Build it' }, image] }],
  tools: createEditorTools(),
});
export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}
export function sse(events: unknown[], named = false): Response {
  const text = events
    .map(
      (event) =>
        `${named && typeof event === 'object' && event !== null && 'type' in event ? `event: ${String(event.type)}\n` : ''}data: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}
export function recordingFetch(responses: (() => Response)[]) {
  const bodies: Record<string, unknown>[] = [];
  const headers: Headers[] = [];
  const urls: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    urls.push(String(input));
    headers.push(new Headers(init?.headers));
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    const response = responses.shift();
    if (!response) throw new Error('Unexpected mocked request');
    return response();
  });
  return { fetcher, bodies, headers, urls };
}
