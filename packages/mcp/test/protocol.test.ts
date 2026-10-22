import { afterEach, expect, it, vi } from 'vitest';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { FrameDecoder, encodeFrame, FramedPeer, type BridgeMessage } from '../src/protocol.js';
import { MAX_FRAME_BYTES, resolvePipeName } from '../src/config.js';
import { createMcpHostServer } from '../src/host.js';
import { endpoint, fakeHost, deferred } from './helpers.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const hello: BridgeMessage = {
  jsonrpc: '2.0',
  id: '1',
  method: 'hello',
  params: { versions: [1], client: { name: '测试 client', version: '1' } },
};

it('decodes split UTF-8 frames and multiple coalesced messages; rejects oversize/malformed payloads', () => {
  const frame = encodeFrame(hello);
  const messages: BridgeMessage[] = [];
  const decoder = new FrameDecoder();
  for (const byte of frame) decoder.push(Buffer.from([byte]), (message) => messages.push(message));
  decoder.push(Buffer.concat([frame, frame]), (message) => messages.push(message));
  expect(messages).toEqual([hello, hello, hello]);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
  expect(() => new FrameDecoder().push(oversized, () => {})).toThrow('length');
  expect(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 1, 0xff]), () => {})).toThrow();
  expect(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 2, 123, 125]), () => {})).toThrow();
});

it('requires an approved versioned hello and closes malformed connections without executing tools', async () => {
  const host = fakeHost();
  const approve = vi.fn(async () => true);
  const server = createMcpHostServer({ host, pipeName: endpoint(), approve });
  cleanup.push(() => server.close());
  await server.start();
  const socket = createConnection(server.pipeName);
  cleanup.push(() => {
    socket.destroy();
  });
  await once(socket, 'connect');
  const peer = new FramedPeer(socket);
  const first = deferred<BridgeMessage>();
  peer.onmessage = first.resolve;
  peer.send({
    jsonrpc: '2.0',
    id: 'early',
    method: 'call',
    params: { tool: 'get_selection', arguments: {}, timeoutMs: 1000 },
  });
  expect(await first.promise).toMatchObject({ id: 'early', error: { code: -32003 } });
  const second = deferred<BridgeMessage>();
  peer.onmessage = second.resolve;
  peer.send({ ...hello, params: { versions: [999], client: { name: 'test', version: '1' } } });
  expect(await second.promise).toMatchObject({ error: { code: -32001 } });
  expect(approve).not.toHaveBeenCalled();
  expect(host.get_selection).not.toHaveBeenCalled();
  const closed = once(socket, 'close');
  socket.write(Buffer.from([0, 0, 0, 2, 123, 125]));
  await closed;
});

it('enforces local endpoint names and excludes remote Windows pipes', () => {
  if (process.platform === 'win32') {
    expect(() => resolvePipeName('\\\\remote\\pipe\\brickloop-mcp-other')).toThrow();
    expect(() => resolvePipeName('\\\\.\\pipe\\unrelated')).toThrow();
  } else expect(() => resolvePipeName('relative.sock')).toThrow();
  expect(resolvePipeName(endpoint())).toBeTruthy();
});

it('times out silent or unapproved handshakes and prevents duplicate host listeners', async () => {
  const server = createMcpHostServer({
    host: fakeHost(),
    pipeName: endpoint(),
    approve: async () => true,
    handshakeTimeoutMs: 100,
  });
  cleanup.push(() => server.close());
  await server.start();
  const duplicate = createMcpHostServer({ host: fakeHost(), pipeName: server.pipeName, approve: async () => true });
  cleanup.push(() => duplicate.close());
  await expect(duplicate.start()).rejects.toThrow();
  const socket = createConnection(server.pipeName);
  cleanup.push(() => {
    socket.destroy();
  });
  const closed = once(socket, 'close');
  await closed;
  expect(server.connections()).toHaveLength(0);
});
