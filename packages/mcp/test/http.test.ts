import { afterEach, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { startMcpHttpServer, generateAccessToken } from '../src/http.js';
import { createMcpHostServer } from '../src/host.js';
import { endpoint, fakeHost, unpack } from './helpers.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('requires Bearer on every request, rejects hostile Origin/Host, and serves SDK sessions on loopback', async () => {
  const host = fakeHost();
  const approve = vi.fn(async () => true);
  const bridge = createMcpHostServer({ pipeName: endpoint(), host, approve });
  cleanup.push(() => bridge.close());
  await bridge.start();
  const token = generateAccessToken();
  const http = await startMcpHttpServer({ pipeName: bridge.pipeName, token });
  cleanup.push(() => http.close());
  expect(new URL(http.url).hostname).toBe('127.0.0.1');
  for (const method of ['GET', 'POST', 'DELETE']) {
    expect((await fetch(http.url, { method })).status).toBe(401);
    expect((await fetch(http.url, { method, headers: { authorization: 'Bearer invalid' } })).status).toBe(401);
  }
  expect((await fetch(`${http.url}?token=${token}`)).status).toBe(401);
  const authorization = `Bearer ${token}`;
  expect((await fetch(http.url, { headers: { authorization, origin: 'https://untrusted.invalid' } })).status).toBe(403);
  const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(http.url, { headers: { authorization, host: 'untrusted.invalid' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  expect(hostileHostStatus).toBe(403);
  const transport = new StreamableHTTPClientTransport(new URL(http.url), {
    requestInit: { headers: { authorization } },
  });
  const sdk = new Client({ name: 'HTTP-test', version: '1' });
  cleanup.push(() => sdk.close());
  // SDK optional accessors include undefined, unlike its exact-optional Transport interface.
  await sdk.connect(transport as Transport);
  expect((await sdk.listTools()).tools).toHaveLength(41);
  expect(unpack(await sdk.callTool({ name: 'delete', arguments: { instanceIds: ['one'] } })).ok).toBe(true);
  expect(approve).toHaveBeenCalledExactlyOnceWith({ name: 'HTTP-test', version: '1' });
  expect(host.beginTransaction).toHaveBeenCalledExactlyOnceWith('外部智能体：delete');
  expect(host.commitTransaction).toHaveBeenCalledTimes(1);
  expect((await fetch(http.url, { headers: { 'mcp-session-id': transport.sessionId! } })).status).toBe(401);
  await http.disconnectAll();
  expect((await fetch(http.url, { headers: { authorization, 'mcp-session-id': transport.sessionId! } })).status).toBe(
    404,
  );
  expect(JSON.stringify(bridge.activity())).not.toContain(token);
}, 15_000);

it('requires a strong host-supplied token before opening a listener', async () => {
  await expect(startMcpHttpServer({ token: '' })).rejects.toThrow('host-generated');
  await expect(startMcpHttpServer({ token: 'short' })).rejects.toThrow('host-generated');
});
