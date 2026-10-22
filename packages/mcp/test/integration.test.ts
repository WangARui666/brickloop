import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorTools } from '@brickloop/ai';
import { createMcpHostServer, getMcpCallContext, type McpHostServer } from '../src/host.js';
import { BridgeClient } from '../src/bridge-client.js';
import { endpoint, fakeHost, ok, stdioClient, unpack, deferred } from './helpers.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function setup(approve = vi.fn(async () => true)) {
  const host = fakeHost();
  const server = createMcpHostServer({ pipeName: endpoint(), host, approve });
  cleanup.push(() => server.close());
  return { host, server, approve };
}
async function client(server: McpHostServer, timeoutMs?: number) {
  const connection = await stdioClient(server.pipeName, timeoutMs);
  cleanup.push(connection.close);
  return connection;
}
function bridge(server: McpHostServer) {
  const value = new BridgeClient({ pipeName: server.pipeName, client: { name: 'bridge-test', version: '1' } });
  cleanup.push(() => value.close());
  return value;
}

describe('stdio MCP with real local bridge and fake editor', () => {
  // Each of the first six tests starts the development MCP launcher; tsx retranspiles without caching.
  // Takes ~4.5 s alone and has exceeded 20 s at full-suite startup.
  // The timeout only detects hangs.
  it('lists exactly the shared definitions, queries, modifies once, handles images and documents', async () => {
    const { host, server, approve } = setup();
    await server.start();
    const { client: sdk, stderr } = await client(server);
    const listed = await sdk.listTools();
    const definitions = createEditorTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [...definitions.map((tool) => tool.name), 'list_documents', 'open_document', 'set_active_document'].sort(),
    );
    expect(listed.tools).toHaveLength(41);
    for (const definition of definitions) {
      expect(listed.tools.find((tool) => tool.name === definition.name)).toMatchObject({
        description: definition.description,
        inputSchema: definition.parameters,
      });
    }
    expect(sdk.getInstructions()).toContain('1 level = 8 LDU');
    expect(unpack(await sdk.callTool({ name: 'get_model_summary', arguments: {} })).ok).toBe(true);
    expect(approve).toHaveBeenCalledExactlyOnceWith({ name: 'offline-test-agent', version: '1.0' });
    expect(host.beginTransaction).not.toHaveBeenCalled();
    const pose = { kind: 'grid', x: 1, z: 0.5, level: 3 };
    expect(
      unpack(await sdk.callTool({ name: 'place_part', arguments: { partId: '3001', colorId: 'S031', pose } })).ok,
    ).toBe(true);
    expect(host.place_part).toHaveBeenCalledExactlyOnceWith({
      partId: '3001',
      colorId: 'S031',
      pose: { ...pose, rotY: 0 },
    });
    expect(host.beginTransaction).toHaveBeenCalledExactlyOnceWith('外部智能体：place_part');
    expect(host.commitTransaction).toHaveBeenCalledTimes(1);
    for (const [name, args] of [
      ['list_documents', {}],
      ['open_document', { path: 'E:\\Models\\house.brkl' }],
      ['set_active_document', { documentId: 'doc-1' }],
    ] as const) {
      expect(unpack(await sdk.callTool({ name, arguments: args })).ok).toBe(true);
    }
    vi.mocked(host.render_views).mockResolvedValue({
      ok: true,
      data: { images: [{ type: 'image', mime: 'image/png', base64: 'aGVsbG8=' }] },
      introducedIssues: [],
      warnings: [],
    });
    expect(await sdk.callTool({ name: 'render_views', arguments: { views: ['front'] } })).toMatchObject({
      content: [{ type: 'text' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
    });
    expect(stderr()).toBe('');
    expect(server.connections()).toHaveLength(1);
  }, 60_000);

  it('does not listen by default and reports the exact absent-host message', async () => {
    const { server } = setup();
    const { client: sdk } = await client(server);
    const response = await sdk.callTool({ name: 'get_selection', arguments: {} });
    expect(response.isError).toBe(true);
    expect(unpack(response)).toEqual({ ok: false, code: 'NOT_RUNNING', message: 'Brickloop is not running' });
    // Starting the application later works without restarting an unused shim.
    await server.start();
    expect(unpack(await sdk.callTool({ name: 'get_selection', arguments: {} })).ok).toBe(true);
  }, 60_000);

  it('rejects approval, remains rejected, and never enters editor code', async () => {
    const { server, host, approve } = setup(vi.fn(async () => false));
    await server.start();
    const { client: sdk } = await client(server);
    for (let i = 0; i < 2; i++)
      expect(unpack(await sdk.callTool({ name: 'get_selection', arguments: {} }))).toMatchObject({
        ok: false,
        code: 'CONNECTION_REJECTED',
      });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(host.get_selection).not.toHaveBeenCalled();
  }, 60_000);

  it('validates both MCP and bridge arguments before opening transactions; batch is one transaction', async () => {
    const { server, host } = setup();
    await server.start();
    const { client: sdk } = await client(server);
    expect(unpack(await sdk.callTool({ name: 'place_part', arguments: { partId: 'bad' } }))).toMatchObject({
      code: 'INVALID_ARGUMENTS',
    });
    expect(await bridge(server).call('place_part', { partId: 'bad' })).toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(host.beginTransaction).not.toHaveBeenCalled();
    await sdk.callTool({
      name: 'batch',
      arguments: {
        operations: [
          { tool: 'delete', arguments: { instanceIds: ['one'] } },
          { tool: 'delete', arguments: { instanceIds: ['two'] } },
        ],
      },
    });
    expect(host.beginTransaction).toHaveBeenCalledExactlyOnceWith('外部智能体：batch');
    expect(host.commitTransaction).toHaveBeenCalledTimes(1);
    expect(host.batch).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('cancels a running SDK call, preserves its single transaction, and cancels queued work', async () => {
    const { host, server } = setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    vi.mocked(host.delete).mockImplementation(async () => {
      signal = getMcpCallContext()?.signal;
      entered.resolve();
      await release.promise;
      return ok();
    });
    await server.start();
    const { client: sdk } = await client(server);
    const abort = new AbortController();
    const running = sdk.callTool({ name: 'delete', arguments: { instanceIds: ['one'] } }, undefined, {
      signal: abort.signal,
    });
    const rejected = expect(running).rejects.toBeDefined();
    await entered.promise;
    const queued = bridge(server).call('delete', { instanceIds: ['two'] }, { timeoutMs: 50 });
    await expect(queued).rejects.toMatchObject({ code: 'TIMEOUT' });
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(host.commitTransaction).not.toHaveBeenCalled();
    release.resolve();
    await vi.waitFor(() => expect(host.commitTransaction).toHaveBeenCalledTimes(1));
    expect(host.delete).toHaveBeenCalledTimes(1);
    expect(host.beginTransaction).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('returns tool timeout through stdio and allows state inspection after the host settles', async () => {
    const { host, server } = setup();
    const entered = deferred<void>();
    vi.mocked(host.get_selection).mockImplementation(async () => {
      const signal = getMcpCallContext()!.signal;
      entered.resolve();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return ok();
    });
    await server.start();
    const { client: sdk } = await client(server, 500);
    const response = sdk.callTool({ name: 'get_selection', arguments: {} });
    await entered.promise;
    expect(unpack(await response)).toMatchObject({ ok: false, code: 'TIMEOUT' });
    expect(unpack(await sdk.callTool({ name: 'get_model_summary', arguments: {} })).ok).toBe(true);
  }, 60_000);

  it('disconnects all clients without silently reconnecting and only logs allowlisted metadata', async () => {
    const { server, host } = setup();
    await server.start();
    const first = bridge(server);
    const second = bridge(server);
    await first.call('create_group', { name: 'Bearer sensitive-secret', instanceIds: ['sk-sensitive-path'] });
    await second.call('get_selection', {});
    expect(server.connections()).toHaveLength(2);
    expect(JSON.stringify(server.activity())).not.toMatch(/sensitive|Bearer|sk-|arguments|client/);
    server.disconnectAll();
    await vi.waitFor(() => expect(server.connections()).toHaveLength(0));
    await expect(first.call('get_selection', {})).rejects.toMatchObject({ code: 'DISCONNECTED' });
    await expect(second.call('get_selection', {})).rejects.toMatchObject({ code: 'DISCONNECTED' });
    expect(host.get_selection).toHaveBeenCalledTimes(1);
  });

  it('serializes document switches and transactions, commits host failures, blocks after failed commit', async () => {
    const { server, host } = setup();
    await server.start();
    const first = bridge(server);
    const second = bridge(server);
    const order: string[] = [];
    vi.mocked(host.beginTransaction).mockImplementation(async () => {
      order.push('begin');
    });
    vi.mocked(host.delete).mockImplementation(async () => {
      order.push('delete');
      throw new Error('secret');
    });
    vi.mocked(host.commitTransaction).mockImplementation(async () => {
      order.push('commit');
    });
    vi.mocked(host.set_active_document).mockImplementation(async () => {
      order.push('switch');
      return ok();
    });
    await first.call('get_selection', {});
    await second.call('get_selection', {});
    const failed = first.call('delete', { instanceIds: ['one'] });
    const switched = second.call('set_active_document', { documentId: 'two' });
    expect(await failed).toMatchObject({ ok: false, code: 'HOST_ERROR' });
    await switched;
    expect(order.join(',')).toMatch(/begin,delete,commit/);
    vi.mocked(host.commitTransaction).mockRejectedValue(new Error('secret'));
    await first.call('delete', { instanceIds: ['one'] });
    expect(await first.call('get_selection', {})).toMatchObject({ code: 'HOST_UNAVAILABLE' });
  });
});
