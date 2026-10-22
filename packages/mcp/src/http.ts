import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MAX_CONNECTIONS, MAX_FRAME_BYTES } from './config.js';
import { createMcpServer, type McpServerOptions } from './server.js';

export interface McpHttpOptions extends McpServerOptions {
  /** Generated and retained by the desktop host; never accepted from URL parameters. */
  token: string;
  port?: number;
}
export interface McpHttpServer {
  readonly url: string;
  disconnectAll(): Promise<void>;
  close(): Promise<void>;
}
export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Explicit opt-in; always binds IPv4 loopback. Every HTTP request requires Bearer auth. */
export async function startMcpHttpServer(options: McpHttpOptions): Promise<McpHttpServer> {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.token))
    throw new Error('A host-generated access token of at least 32 characters is required.');
  const expected = createHash('sha256').update(`Bearer ${options.token}`).digest();
  const sessions = new Set<{
    transport: StreamableHTTPServerTransport;
    server: ReturnType<typeof createMcpServer>;
    lastUsed: number;
  }>();
  let url = '';
  const respond = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(message);
  };
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.socket.remoteAddress !== '127.0.0.1') {
      respond(res, 403, 'Local connections only.');
      return;
    }
    const actual = createHash('sha256')
      .update(req.headers.authorization ?? '')
      .digest();
    if (!timingSafeEqual(expected, actual)) {
      res.setHeader('www-authenticate', 'Bearer');
      respond(res, 401, 'A valid Bearer token is required.');
      return;
    }
    const origin = new URL(url).origin;
    if (req.headers.host !== new URL(url).host || (req.headers.origin && req.headers.origin !== origin)) {
      respond(res, 403, 'Invalid Host or Origin.');
      return;
    }
    if (req.url !== '/mcp') {
      respond(res, 404, 'Not found.');
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    let session = [...sessions].find(
      (entry) => entry.transport.sessionId === sessionId && typeof sessionId === 'string',
    );
    if (!session) {
      if (sessionId !== undefined) {
        respond(res, 404, 'Unknown MCP session.');
        return;
      }
      if (req.method !== 'POST') {
        respond(res, 400, 'Initialize an MCP session first.');
        return;
      }
      if (sessions.size >= MAX_CONNECTIONS) {
        respond(res, 503, 'Too many MCP sessions.');
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        maxRequestBodySize: MAX_FRAME_BYTES,
      });
      const server = createMcpServer(options);
      session = { transport, server, lastUsed: Date.now() };
      sessions.add(session);
      // SDK accessors permit undefined; its Transport optional properties do not
      // model that under exactOptionalPropertyTypes. Runtime contract is identical.
      await server.connect(transport as Transport);
      const current = session;
      const onclose = transport.onclose;
      transport.onclose = () => {
        sessions.delete(current);
        onclose?.();
      };
    }
    session.lastUsed = Date.now();
    try {
      await session.transport.handleRequest(req, res);
    } finally {
      if (!session.transport.sessionId) {
        sessions.delete(session);
        await session.server.close();
      }
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) respond(res, 500, 'MCP request failed.');
      else res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine MCP HTTP address.');
  url = `http://127.0.0.1:${address.port}/mcp`;
  const cleanup = setInterval(() => {
    for (const session of sessions)
      if (Date.now() - session.lastUsed > 30 * 60_000) {
        sessions.delete(session);
        void session.server.close().catch(() => {});
      }
  }, 60_000);
  cleanup.unref();
  const api: McpHttpServer = {
    url,
    async disconnectAll() {
      const current = [...sessions];
      sessions.clear();
      await Promise.all(current.map((session) => session.server.close()));
    },
    async close() {
      clearInterval(cleanup);
      await api.disconnectAll();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
  return api;
}
