import { randomUUID } from 'node:crypto';
import type { ToolResult } from '@brickloop/ai';
import { BRIDGE_VERSION, DEFAULT_TIMEOUT_MS, MAX_PENDING_CALLS, MAX_TIMEOUT_MS, resolvePipeName } from './config.js';
import { connectLocal } from './local-transport.js';
import {
  BridgeError,
  FramedPeer,
  bridgeMessageSchema,
  type ActivityEvent,
  type BridgeRequest,
  type BridgeResponse,
  type ClientIdentity,
} from './protocol.js';

export interface BridgeClientOptions {
  pipeName?: string;
  client: ClientIdentity;
  timeoutMs?: number;
  onEvent?(event: ActivityEvent): void;
}
export class BridgeClient {
  private peer: FramedPeer | undefined;
  private connecting: Promise<void> | undefined;
  private lifetime = new AbortController();
  private terminal: BridgeError | undefined;
  private pending = new Map<string, { resolve(value: BridgeResponse): void; reject(error: Error): void }>();
  readonly pipeName: string;
  constructor(private readonly options: BridgeClientOptions) {
    this.pipeName = resolvePipeName(options.pipeName);
  }
  private async connect(): Promise<void> {
    if (this.terminal) throw this.terminal;
    if (this.connecting) return this.connecting;
    if (this.peer) return;
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.connecting = (async () => {
      const stream = await connectLocal(this.pipeName, AbortSignal.any([timeout, this.lifetime.signal]));
      const peer = new FramedPeer(stream);
      this.peer = peer;
      peer.onclose = () => {
        if (this.peer !== peer) return;
        this.peer = undefined;
        this.terminal ??= new BridgeError(
          'DISCONNECTED',
          'Disconnected from Brickloop. Restart the MCP client to reconnect.',
        );
        for (const pending of this.pending.values()) pending.reject(this.terminal);
        this.pending.clear();
      };
      peer.onmessage = (message) => {
        if ('method' in message) {
          if (message.method === 'event') {
            try {
              this.options.onEvent?.(message.params);
            } catch {
              /* Observer only. */
            }
          } else if (message.method === 'bye') {
            this.terminal = new BridgeError(
              'DISCONNECTED',
              'Disconnected by Brickloop. Restart the MCP client to reconnect.',
            );
            peer.close();
          } else peer.close();
        } else {
          this.pending.get(message.id)?.resolve(message);
        }
      };
      const response = await this.request(
        {
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'hello',
          params: { versions: [BRIDGE_VERSION], client: this.options.client },
        },
        timeout,
      );
      if ('error' in response) {
        this.terminal = new BridgeError(
          response.error.code === -32002 ? 'CONNECTION_REJECTED' : 'PROTOCOL_ERROR',
          response.error.message,
        );
        peer.close();
        throw this.terminal;
      }
      if (response.result.kind !== 'hello' || response.result.version !== BRIDGE_VERSION) {
        peer.close();
        throw new BridgeError('PROTOCOL_ERROR', 'Incompatible Brickloop bridge version.');
      }
    })().finally(() => {
      this.connecting = undefined;
    });
    try {
      await this.connecting;
    } catch (error) {
      this.closePeer();
      throw error;
    }
  }
  private closePeer(): void {
    this.peer?.close();
  }
  private request(message: BridgeRequest, signal: AbortSignal): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new BridgeError('CANCELLED', 'Operation cancelled.'));
        return;
      }
      if (!this.peer) {
        reject(new BridgeError('DISCONNECTED', 'Disconnected from Brickloop.'));
        return;
      }
      if (this.pending.size >= MAX_PENDING_CALLS) {
        reject(new BridgeError('BUSY', 'Too many pending Brickloop calls.'));
        return;
      }
      const peer = this.peer;
      const cleanup = () => {
        this.pending.delete(message.id);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        try {
          peer.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: message.id } });
        } catch {
          peer.close();
        }
        reject(new BridgeError('CANCELLED', 'Operation cancelled.'));
      };
      this.pending.set(message.id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal.addEventListener('abort', abort, { once: true });
      try {
        peer.send(message);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
  async call(
    tool: string,
    args: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ToolResult> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
      throw new BridgeError('INVALID_ARGUMENTS', 'Invalid call timeout.');
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([timeout, this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    try {
      // A cancelled waiter must not cancel a shared approval/connect for other calls.
      await waitFor(this.connect(), signal);
      const message = bridgeMessageSchema.parse({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'call',
        params: { tool, arguments: args, timeoutMs },
      });
      const response = await this.request(message as Extract<BridgeRequest, { method: 'call' }>, signal);
      if ('error' in response) throw new BridgeError('PROTOCOL_ERROR', response.error.message);
      if (response.result.kind !== 'result')
        throw new BridgeError('PROTOCOL_ERROR', 'Unexpected Brickloop bridge response.');
      return response.result.value;
    } catch (error) {
      if (timeout.aborted) throw new BridgeError('TIMEOUT', 'Brickloop tool call timed out.');
      if (signal.aborted) throw new BridgeError('CANCELLED', 'Operation cancelled.');
      throw error;
    }
  }
  close(): void {
    this.terminal = new BridgeError('DISCONNECTED', 'Disconnected from Brickloop.');
    this.lifetime.abort();
    try {
      this.peer?.send({ jsonrpc: '2.0', method: 'bye', params: { reason: 'closed' } });
    } catch {
      /* Closing. */
    }
    this.peer?.close();
  }
}
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new BridgeError('CANCELLED', 'Operation cancelled.'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
