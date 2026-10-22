import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { BRIDGE_VERSION, DEFAULT_TIMEOUT_MS, MAX_CONNECTIONS, MAX_PENDING_CALLS, resolvePipeName } from './config.js';
import { listenLocal, type LocalListener } from './local-transport.js';
import {
  FramedPeer,
  toolResultSchema,
  type ActivityEvent,
  type BridgeMessage,
  type BridgeRequest,
  type ClientIdentity,
} from './protocol.js';
import { createMcpTools, failure, type McpEditorHost } from './tools.js';
import type { ToolResult } from '@brickloop/ai';

export interface McpCallContext {
  connectionId: string;
  requestId: string;
  client: ClientIdentity;
  signal: AbortSignal;
}
const callContext = new AsyncLocalStorage<McpCallContext>();
export function getMcpCallContext(): McpCallContext | undefined {
  return callContext.getStore();
}

export interface McpHostOptions {
  pipeName?: string;
  host: McpEditorHost;
  approve(client: ClientIdentity): Promise<boolean>;
  onEvent?(event: ActivityEvent): void;
  handshakeTimeoutMs?: number;
}
export interface McpHostServer {
  readonly pipeName: string;
  start(): Promise<void>;
  disconnectAll(): void;
  close(): Promise<void>;
  connections(): { connectionId: string; client: ClientIdentity }[];
  activity(): ActivityEvent[];
}
interface Connection {
  id: string;
  peer: FramedPeer;
  state: 'new' | 'approving' | 'ready' | 'closed';
  client?: ClientIdentity;
  pending: Map<string, AbortController>;
}

/** Inert until start(); the desktop owns the enable setting and approval UI. */
export function createMcpHostServer(options: McpHostOptions): McpHostServer {
  const pipeName = resolvePipeName(options.pipeName);
  const tools = new Map(createMcpTools().map((tool) => [tool.name, tool]));
  const connections = new Set<Connection>();
  const activities: ActivityEvent[] = [];
  let listener: LocalListener | undefined;
  let starting: Promise<void> | undefined;
  let closing = false;
  let faulted = false;
  let queue = Promise.resolve();
  let pendingCalls = 0;

  function emit(event: Omit<ActivityEvent, 'timestamp'>): void {
    const value: ActivityEvent = { ...event, timestamp: new Date().toISOString() };
    activities.push(value);
    if (activities.length > 500) activities.shift();
    try {
      options.onEvent?.({ ...value });
    } catch {
      /* Logging must not alter editing. */
    }
    for (const connection of connections) {
      if (connection.state === 'ready') send(connection, { jsonrpc: '2.0', method: 'event', params: value });
    }
  }
  function send(connection: Connection, message: BridgeMessage): void {
    try {
      connection.peer.send(message);
    } catch {
      connection.peer.close();
    }
  }
  function error(connection: Connection, id: string, code: number, message: string): void {
    send(connection, { jsonrpc: '2.0', id, error: { code, message } });
  }
  function disconnect(connection: Connection): void {
    if (connection.state === 'closed') return;
    const approved = connection.state === 'ready';
    connection.state = 'closed';
    connections.delete(connection);
    for (const controller of connection.pending.values()) controller.abort('cancelled');
    connection.peer.close();
    if (approved) emit({ type: 'disconnected', connectionId: connection.id });
  }
  async function hello(connection: Connection, request: Extract<BridgeRequest, { method: 'hello' }>): Promise<void> {
    if (connection.state !== 'new') {
      error(connection, request.id, -32600, 'Hello was already received.');
      return;
    }
    connection.state = 'approving';
    if (!request.params.versions.includes(BRIDGE_VERSION)) {
      error(connection, request.id, -32001, 'No compatible Brickloop bridge version.');
      return;
    }
    const client = request.params.client;
    let approved = false;
    try {
      approved = await options.approve({ ...client });
    } catch {
      /* Fail closed. */
    }
    if (connection.state !== 'approving') return;
    if (!approved) {
      emit({ type: 'rejected', connectionId: connection.id });
      error(connection, request.id, -32002, 'Connection rejected by Brickloop.');
      return;
    }
    connection.client = client;
    connection.state = 'ready';
    send(connection, {
      jsonrpc: '2.0',
      id: request.id,
      result: { kind: 'hello', version: BRIDGE_VERSION, connectionId: connection.id },
    });
    emit({ type: 'connected', connectionId: connection.id });
  }
  function call(connection: Connection, request: Extract<BridgeRequest, { method: 'call' }>): void {
    if (connection.state !== 'ready' || !connection.client) {
      error(connection, request.id, -32003, 'Complete an approved hello before calling tools.');
      return;
    }
    if (connection.pending.has(request.id)) {
      error(connection, request.id, -32600, 'Duplicate request ID.');
      return;
    }
    const result = (value: ToolResult) =>
      send(connection, { jsonrpc: '2.0', id: request.id, result: { kind: 'result', value } });
    const tool = tools.get(request.params.tool);
    if (!tool) {
      result(failure('UNKNOWN_TOOL', 'Unknown Brickloop tool.'));
      return;
    }
    // Validate before opening a transaction, even for direct/untrusted bridge clients.
    if (!tool.schema.safeParse(request.params.arguments).success) {
      result(failure('INVALID_ARGUMENTS', 'Tool arguments do not match the schema.'));
      return;
    }
    if (pendingCalls >= MAX_PENDING_CALLS) {
      result(failure('BUSY', 'Too many pending Brickloop calls.'));
      return;
    }
    const controller = new AbortController();
    const signal = controller.signal;
    const context: McpCallContext = {
      connectionId: connection.id,
      requestId: request.id,
      client: connection.client,
      signal,
    };
    connection.pending.set(request.id, controller);
    pendingCalls++;
    const started = Date.now();
    let responded = false;
    const finish = (value: ToolResult) => {
      if (responded) return;
      responded = true;
      result(value);
    };
    const timeout = setTimeout(() => controller.abort('timeout'), request.params.timeoutMs);
    signal.addEventListener(
      'abort',
      () =>
        finish(
          failure(
            signal.reason === 'timeout' ? 'TIMEOUT' : 'CANCELLED',
            signal.reason === 'timeout' ? 'Brickloop tool call timed out.' : 'Operation cancelled.',
          ),
        ),
      { once: true },
    );
    emit({ type: 'started', connectionId: connection.id, tool: tool.name });
    // Keep the lock until the actual host operation and transaction settle, even
    // if cancellation/timeout has already answered the client.
    queue = queue.then(async () => {
      let value = failure('CANCELLED', 'Operation cancelled.');
      try {
        if (signal.aborted) return;
        if (faulted) {
          value = failure('HOST_UNAVAILABLE', 'Brickloop transaction recovery is required.');
          return;
        }
        value = await callContext.run(context, async () => {
          let began = false;
          let output: ToolResult = failure('CANCELLED', 'Operation cancelled.');
          try {
            if (tool.mutating) {
              await options.host.beginTransaction(`外部智能体：${tool.name}`);
              began = true;
            }
            if (!signal.aborted) {
              const parsed = toolResultSchema.safeParse(await tool.execute(options.host, request.params.arguments));
              output = parsed.success
                ? parsed.data
                : failure('HOST_ERROR', 'The editor returned an invalid tool result.');
            }
          } finally {
            if (began) {
              try {
                await options.host.commitTransaction();
              } catch {
                faulted = true;
                output = failure('HOST_ERROR', 'Brickloop transaction recovery is required.');
              }
            }
          }
          return output;
        });
      } catch {
        value = failure('HOST_ERROR', 'The editor could not complete the operation.');
      } finally {
        clearTimeout(timeout);
        connection.pending.delete(request.id);
        pendingCalls--;
        finish(value);
        emit({
          type: 'finished',
          connectionId: connection.id,
          tool: tool.name,
          outcome: signal.aborted ? (signal.reason === 'timeout' ? 'timeout' : 'cancelled') : value.ok ? 'ok' : 'error',
          durationMs: Date.now() - started,
        });
      }
    });
  }
  function accept(stream: Duplex): void {
    if (closing || connections.size >= MAX_CONNECTIONS) {
      stream.destroy();
      return;
    }
    const connection: Connection = { id: randomUUID(), peer: new FramedPeer(stream), state: 'new', pending: new Map() };
    connections.add(connection);
    const timer = setTimeout(() => {
      if (connection.state !== 'ready') disconnect(connection);
    }, options.handshakeTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    connection.peer.onclose = () => {
      clearTimeout(timer);
      disconnect(connection);
    };
    connection.peer.onmessage = (message) => {
      if (!('method' in message)) {
        disconnect(connection);
        return;
      }
      switch (message.method) {
        case 'hello':
          void hello(connection, message);
          break;
        case 'call':
          call(connection, message);
          break;
        case 'notifications/cancelled':
          connection.pending.get(message.params.requestId)?.abort('cancelled');
          break;
        case 'bye':
          disconnect(connection);
          break;
        default:
          disconnect(connection);
      }
    };
  }
  const server: McpHostServer = {
    pipeName,
    start() {
      if (closing) return Promise.reject(new Error('MCP host is closed.'));
      if (listener) return Promise.resolve();
      starting ??= listenLocal(pipeName, accept)
        .then((value) => {
          listener = value;
        })
        .finally(() => {
          starting = undefined;
        });
      return starting;
    },
    disconnectAll() {
      for (const connection of [...connections]) {
        send(connection, { jsonrpc: '2.0', method: 'bye', params: { reason: 'disconnected' } });
        disconnect(connection);
      }
    },
    async close() {
      closing = true;
      await starting;
      server.disconnectAll();
      const current = listener;
      listener = undefined;
      await current?.close();
      await queue;
    },
    connections: () =>
      [...connections].flatMap((connection) =>
        connection.state === 'ready' && connection.client
          ? [{ connectionId: connection.id, client: { ...connection.client } }]
          : [],
      ),
    activity: () => activities.map((event) => ({ ...event })),
  };
  return server;
}
