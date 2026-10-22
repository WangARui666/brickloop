import type { Duplex } from 'node:stream';
import type { ToolResult } from '@brickloop/ai';
import { z } from 'zod';
import { MAX_FRAME_BYTES, MAX_TIMEOUT_MS } from './config.js';

const id = z.string().min(1).max(128);
export const clientIdentitySchema = z.strictObject({
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
});
export type ClientIdentity = z.infer<typeof clientIdentitySchema>;
export const toolResultSchema = z
  .union([
    z.strictObject({
      ok: z.literal(true),
      data: z.json(),
      introducedIssues: z.array(z.object({ kind: z.string() }).catchall(z.json())),
      warnings: z.array(z.string()),
    }),
    z.strictObject({ ok: z.literal(false), code: z.string(), message: z.string(), details: z.json().optional() }),
  ])
  .transform((value): ToolResult =>
    value.ok
      ? value
      : {
          ok: false,
          code: value.code,
          message: value.message,
          ...(value.details === undefined ? {} : { details: value.details }),
        },
  );
export const activitySchema = z.strictObject({
  type: z.enum(['connected', 'rejected', 'disconnected', 'started', 'finished']),
  connectionId: id,
  timestamp: z.string(),
  tool: z.string().optional(),
  outcome: z.enum(['ok', 'error', 'cancelled', 'timeout']).optional(),
  durationMs: z.number().nonnegative().optional(),
});
export type ActivityEvent = z.infer<typeof activitySchema>;
export const bridgeMessageSchema = z.union([
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    id,
    method: z.literal('hello'),
    params: z.strictObject({ versions: z.array(z.number().int()).min(1).max(8), client: clientIdentitySchema }),
  }),
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    id,
    method: z.literal('call'),
    params: z.strictObject({
      tool: z.string().min(1).max(128),
      arguments: z.json(),
      timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS),
    }),
  }),
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    method: z.literal('notifications/cancelled'),
    params: z.strictObject({ requestId: id }),
  }),
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    method: z.literal('bye'),
    params: z.strictObject({ reason: z.enum(['closed', 'disconnected', 'shutdown']) }),
  }),
  z.strictObject({ jsonrpc: z.literal('2.0'), method: z.literal('event'), params: activitySchema }),
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    id,
    result: z.union([
      z.strictObject({ kind: z.literal('hello'), version: z.number().int(), connectionId: id }),
      z.strictObject({ kind: z.literal('result'), value: toolResultSchema }),
    ]),
  }),
  z.strictObject({
    jsonrpc: z.literal('2.0'),
    id,
    error: z.strictObject({ code: z.number().int(), message: z.string() }),
  }),
]);
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;
export type BridgeRequest = Extract<BridgeMessage, { method: 'hello' | 'call' }>;
export type BridgeResponse = Extract<BridgeMessage, { result: unknown } | { error: unknown }>;

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Four-byte unsigned big-endian byte length followed by UTF-8 JSON. */
export function encodeFrame(message: BridgeMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new BridgeError('FRAME_TOO_LARGE', 'Bridge message exceeds the size limit.');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private header = Buffer.alloc(4);
  private headerOffset = 0;
  private body: Buffer | undefined;
  private offset = 0;
  push(chunk: Buffer, receive: (message: BridgeMessage) => void): void {
    let cursor = 0;
    while (cursor < chunk.length) {
      if (!this.body) {
        const length = Math.min(4 - this.headerOffset, chunk.length - cursor);
        chunk.copy(this.header, this.headerOffset, cursor, cursor + length);
        cursor += length;
        this.headerOffset += length;
        if (this.headerOffset < 4) continue;
        const size = this.header.readUInt32BE();
        if (size === 0 || size > MAX_FRAME_BYTES) throw new Error('Invalid bridge frame length.');
        this.body = Buffer.allocUnsafe(size);
        this.offset = 0;
        this.headerOffset = 0;
      }
      const length = Math.min(this.body.length - this.offset, chunk.length - cursor);
      chunk.copy(this.body, this.offset, cursor, cursor + length);
      cursor += length;
      this.offset += length;
      if (this.offset === this.body.length) {
        const body = this.body;
        this.body = undefined;
        const json: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        receive(bridgeMessageSchema.parse(json));
      }
    }
  }
}

export class FramedPeer {
  private decoder = new FrameDecoder();
  onmessage: (message: BridgeMessage) => void = () => {};
  onclose: () => void = () => {};
  constructor(readonly stream: Duplex) {
    stream.on('data', (chunk: Buffer) => {
      try {
        this.decoder.push(chunk, (message) => this.onmessage(message));
      } catch {
        this.close();
      }
    });
    stream.on('error', () => this.close());
    stream.once('close', () => this.onclose());
    stream.once('end', () => this.close());
  }
  send(message: BridgeMessage): void {
    if (this.stream.destroyed) return;
    const frame = encodeFrame(message);
    if (this.stream.writableLength + frame.length > MAX_FRAME_BYTES * 2) {
      this.close();
      throw new BridgeError('BACKPRESSURE', 'Bridge connection is not consuming messages.');
    }
    this.stream.write(frame);
  }
  close(): void {
    this.stream.destroy();
  }
}
