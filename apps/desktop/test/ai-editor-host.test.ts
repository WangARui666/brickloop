import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createDocument, DocumentSession, expandInstances, serializeDocument } from '@brickloop/core';
import { compareImages, createEditorTools, gridToLdu, lduToGrid, runAgentTurn, DailyCostLedger } from '@brickloop/ai';
import type { ModelProvider } from '@brickloop/ai';
import type { RgbaImage } from '@brickloop/mosaic';
import type { ToolName, ToolResult, ImageBlock } from '@brickloop/ai';
import { parseConnectorFile } from '@brickloop/connect';
import { parseColliderOverride } from '@brickloop/collide';
import { createEditorHost, createEditorRpc } from '../src/main/editor-host';
import { RendererEditorHost, success } from '../src/renderer/src/ai-editor-host';
import type { EditorHostServices, HostDocument } from '../src/renderer/src/ai-editor-host';
import { AssemblyEngine } from '../src/renderer/src/assembly-engine';
import type { AssemblyPart } from '../src/shared/assembly-api';
import type { LibraryPart, LibraryColor } from '../src/shared/library-api';
import { contextModelSummary } from '../src/renderer/src/ai-context';
import { conversationPrompt } from '../src/shared/ai-context-prompt';

const connectors = parseConnectorFile(readFileSync('library/connectors/3001.json', 'utf8')).file!;
const override = parseColliderOverride(JSON.parse(readFileSync('library/colliders/ld%3A3001.collider.json', 'utf8')));
const part: AssemblyPart = {
  connectors,
  overrideVersion: override.version,
  collider: {
    schema: 1,
    partId: 'ld:3001',
    generatorVersion: 'test',
    source: 'manual',
    approximate: false,
    shapes: override.shapes,
    bounds: [-40, -4, -20, 40, 24, 20],
    diagnostics: [],
  },
};
const color: LibraryColor = {
  id: 'c:red',
  nameZh: '亮红',
  legoName: 'Red',
  legoColorId: 4,
  ldrawCode: 4,
  rgb: '#C91A09',
  edgeRgb: '#333333',
  finish: 'solid',
  alpha: 1,
  factoryCode: 'S031',
};
const catalogPart: LibraryPart = {
  id: 'ld:3001',
  nameZh: '砖 2×4',
  nameEn: 'Brick 2 x 4',
  factoryNo: 'B1',
  legoNo: '3001',
  ldrawFile: '3001.dat',
  categoryId: 'brick',
  keywords: [],
  bboxLdu: [-40, -4, -20, 40, 24, 20],
  geometry: { source: 'ldraw', ref: '3001.dat', hash: '' },
  connectorsRef: null,
};
const image: ImageBlock = { type: 'image', base64: 'AQID', mime: 'image/png' };
const rgba = { width: 32, height: 32, data: new Uint8Array(32 * 32 * 4) };
for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) rgba.data.set([200, 30, 10, 255], (y * 32 + x) * 4);
const pose = { kind: 'grid' as const, x: 0, z: 0, level: 3, rotY: 0 as const };
function setup() {
  const session = new DocumentSession(createDocument());
  const tab: HostDocument = { session, assets: {}, readOnly: false };
  const catalog = {
    parts: [
      { id: 'ld:3001', factory: true, colors: ['c:red', 'c:blue'] },
      { id: 'ld:3070b', factory: true, colors: ['c:red'] },
    ],
    colors: ['c:red', 'c:blue'],
  };
  const services: EditorHostServices = {
    active: () => tab,
    lock: vi.fn(),
    changed: vi.fn(),
    library: {
      catalogSearch: vi.fn(async () => [catalogPart]),
      catalogPart: vi.fn(async (id) =>
        id === 'ld:3001' ? catalogPart : id === 'ld:3070b' ? { ...catalogPart, id, nameEn: 'Tile 1 x 1' } : null,
      ),
      catalogColors: vi.fn(async () => ({
        factory: [color, { ...color, id: 'c:blue' as const }],
        all: [color, { ...color, id: 'c:blue' as const }],
      })),
    },
    assemblyPart: vi.fn(async () => part),
    catalog: async () => catalog,
    async check(doc, modelPath) {
      const engine = new AssemblyEngine();
      engine.sync({ doc, collision: true, parts: [['ld:3001', part]], catalog });
      return engine.check({
        collisionEnabled: true,
        groundIsFixed: true,
        grid: false,
        kinds: ['collision', 'floating', 'nonFactoryPart', 'nonFactoryColor', 'unavailableColor'],
        ...(modelPath ? { scope: 'currentModel', activeModelPath: modelPath } : {}),
      }).issues;
    },
    render: vi.fn(async () => ({ images: [image], rgba: [rgba] })),
    decode: async () => rgba,
    encode: () => image,
    bom: vi.fn(async (doc) => ({ total: expandInstances(doc).length })),
    exportIo: vi.fn(async () => ({ path: 'fixture.io' })),
    documents: vi.fn(async () => success({ documentId: session.document.documentId })),
  };
  const renderer = new RendererEditorHost(services);
  const rpc = createEditorRpc((request) => {
    void renderer.request(request.method, request.input, request.owner).then(
      (value) => rpc.reply({ id: request.id, value }),
      () => rpc.reply({ id: request.id, error: 'REJECTED' }),
    );
  });
  const host = createEditorHost(rpc.call, 'ai');
  const tool = async (name: ToolName, args: unknown = {}) =>
    createEditorTools()
      .find((t) => t.name === name)!
      .execute(host, args);
  const data = async (name: ToolName, args: unknown = {}) => {
    const result = await tool(name, args);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return (result as Extract<ToolResult, { ok: true }>).data as Record<string, unknown>;
  };
  return { session, tab, services, renderer, rpc, host, tool, data };
}
describe('EditorHost over fake IPC and real core documents', () => {
  it.each([false, true])('preserves all comparison metrics exactly (empty: %s)', async (empty) => {
    const s = setup();
    const rendered = { ...rgba, data: new Uint8Array(rgba.data.length) };
    if (!empty)
      for (let y = 9; y < 25; y++)
        for (let x = 10; x < 26; x++) rendered.data.set([180, 50, 20, 255], (y * 32 + x) * 4);
    vi.mocked(s.services.render).mockResolvedValue({ images: [image], rgba: [rendered] });
    await s.host.beginTransaction('fixed comparison');
    const ref = await s.data('add_reference_image', { image, name: 'fixed RGBA', view: 'front' });
    const result = await s.data('compare_to_reference', { referenceId: ref.referenceId, view: 'front' });
    const { images, comparisonImage, ...metrics } = result;
    expect(images).toHaveLength(2);
    expect(comparisonImage).toBeDefined();
    expect(metrics).toMatchSnapshot();
  });

  it('prepares reference copies through the browser codec without changing project assets', async () => {
    const s = setup();
    const prepared: ImageBlock = { ...image, base64: 'c2NhbGVk' };
    s.services.prepareReferenceImage = vi.fn(async () => prepared);
    const request = { image, policy: { longEdge: 2048, shortEdge: 768 } };
    await expect(s.renderer.request('image.prepare', request, 'ai')).rejects.toThrow('DOCUMENT_BUSY');
    await s.renderer.request('reserve', {}, 'ai');
    expect(await s.renderer.request('image.prepare', request, 'ai')).toEqual(prepared);
    expect(s.services.prepareReferenceImage).toHaveBeenCalledExactlyOnceWith(image, request.policy);
    expect(s.tab.assets).toEqual({});
    await s.renderer.request('release', {}, 'ai');
  });
  it('checks each part number once per recolour, including repeated leaves in a submodel', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.session.dispatch({ type: 'part.add', partId: 'ld:3001', colorId: 'c:red' });
    const paths = expandInstances(s.session.document).map((row) => row.path);
    await s.host.beginTransaction('colours');
    await s.data('create_submodel', { name: 'shared', instanceIds: paths.map((path) => path.at(-1)!) });
    const modelInstance = Object.values(s.session.document.models[s.session.document.rootModelId]!.instances)[0]!;
    vi.mocked(s.services.library.catalogPart).mockClear();
    await s.data('set_color', { instanceIds: [modelInstance.id], colorId: 'c:blue' });
    expect(s.services.library.catalogPart).toHaveBeenCalledTimes(1);
    vi.mocked(s.services.library.catalogPart).mockClear();
    await s.data('replace_color', { fromColorId: 'c:red', toColorId: 'c:blue' });
    expect(s.services.library.catalogPart).toHaveBeenCalledTimes(1);
    // No long-lived validation cache: the next request still checks restrictions.
    expect(await s.tool('set_color', { instanceIds: [modelInstance.id], colorId: 'c:missing' })).toMatchObject({
      ok: false,
      code: 'UNAVAILABLE_COLOR',
    });
    expect(expandInstances(s.session.document).every((row) => row.colorId === 'c:blue')).toBe(true);
    await s.host.commitTransaction();
  });
  it('CTX-04 projects the same system prompt in the estimate Worker and the request host', async () => {
    const s = setup();
    s.session.dispatch({ type: 'part.add', partId: 'ld:3001', colorId: 'c:red' });
    s.session.setContext({
      activeModelPath: [],
      selection: expandInstances(s.session.document).map((row) => row.path),
    });
    const analysis = {
      summary: { partCount: 10000, colors: { 'c:red': 10000 } },
      issues: (['collision', 'nonFactoryPart', 'nonFactoryColor', 'unavailableColor'] as const).map((kind) => ({
        kind,
        severity: 'warning' as const,
        paths: [['part']],
        messageKey: `check.${kind}` as const,
        data: { count: 1, optional: undefined },
      })),
    };
    s.services.summarize = async () => analysis;
    const actual = await s.data('get_model_summary');
    expect(actual.selection).not.toEqual([]);
    for (const modelContext of [true, false])
      expect(
        conversationPrompt(contextModelSummary(analysis, s.session.context.activeModelPath), modelContext),
      ).toEqual(conversationPrompt(actual, modelContext));
  });
  it('CTX-02 returns compact search rows and filter guidance for 500 catalog matches', async () => {
    const s = setup();
    vi.mocked(s.services.library.catalogSearch).mockResolvedValue(Array.from({ length: 500 }, () => catalogPart));
    const result = await s.data('search_parts', { query: '砖' });
    expect(result).toMatchObject({ total: 500, truncated: true });
    const parts = result.parts as Record<string, unknown>[];
    expect(parts).toHaveLength(20);
    expect(parts[0]).toEqual({
      id: catalogPart.id,
      nameZh: catalogPart.nameZh,
      nameEn: catalogPart.nameEn,
      bboxLdu: catalogPart.bboxLdu,
      categoryId: catalogPart.categoryId,
    });
    expect(result.pagination).toContain('用不同的过滤条件缩小范围');
    expect(await s.data('search_parts', { query: '砖', dimensions: { x: 999, z: 999, level: 999 } })).toMatchObject({
      total: 0,
      parts: [],
    });
  });
  it('paginates compact instance rows with stable IDs and keeps details available via get_instance', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.session.dispatch({ type: 'part.add', partId: 'ld:3001', colorId: 'c:red' });
    const first = await s.data('list_instances', { limit: 2 });
    const second = await s.data('list_instances', { offset: 2, limit: 2 });
    const last = await s.data('list_instances', { offset: 4, limit: 2 });
    expect(first).toMatchObject({ total: 5, offset: 0, nextOffset: 2 });
    expect(second).toMatchObject({ total: 5, offset: 2, nextOffset: 4 });
    expect(last).toMatchObject({ total: 5, offset: 4, nextOffset: null });
    const rows = [first, second, last].flatMap((p) => p.instances as Record<string, unknown>[]);
    expect(new Set(rows.map((r) => r.instanceId)).size).toBe(5);
    expect(rows.every((r) => r.matrix_ldu === undefined)).toBe(true);
    expect(await s.data('get_instance', { instanceId: rows[0]!.instanceId })).toHaveProperty('matrix_ldu');
  });
  it('bounds selection context at 200 parts, retains grid positions, and loads each part shape only once', async () => {
    const s = setup();
    for (let x = 0; x < 201; x++) s.session.dispatch({ type: 'part.add', partId: 'ld:3001', colorId: 'c:red' });
    const paths = expandInstances(s.session.document).map((r) => r.path);
    s.session.setContext({ activeModelPath: [], selection: paths });
    const large = (await s.renderer.request('selection.context', {}, 'ai')) as Record<string, unknown>;
    expect(large).toMatchObject({ count: 201, partCount: 201, colors: { 'c:red': 201 } });
    expect(large.instances).toBeUndefined();
    expect(large.paths).toBeUndefined();
    expect(large.bounds).toBeTruthy();
    expect(s.services.assemblyPart).toHaveBeenCalledTimes(1);
    s.session.setContext({ activeModelPath: [], selection: paths.slice(0, 1) });
    expect(await s.renderer.request('selection.context', {}, 'ai')).toMatchObject({
      count: 1,
      instances: [{ id: paths[0]!.at(-1), partId: 'ld:3001', colorId: 'c:red', position: { x: 0, z: 0, level: 0 } }],
      model: { id: s.session.document.rootModelId },
    });
  });
  it('enforces selection scope per tool and batch, preserves earlier edits, and leaves MCP unrestricted', async () => {
    const s = setup();
    for (let x = 0; x < 3; x++)
      s.session.dispatch({
        type: 'part.add',
        partId: 'ld:3001',
        colorId: 'c:red',
        transform: [x * 100, -24, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      });
    const ids = expandInstances(s.session.document).map((r) => r.path.at(-1)!);
    s.session.dispatch({ type: 'group.create', paths: ids.slice(0, 2).map((id) => [id]), name: 'mixed' });
    const scoped = new RendererEditorHost(s.services, { base: s.session.document, paths: [[ids[0]!]] });
    const call = (name: string, args: unknown = {}) => scoped.request(name, args, 'ai');
    await call('beginTransaction', 'scoped');
    for (const [name, args] of [
      ['move', { instanceIds: [ids[1]], delta: { x: 1, z: 0, level: 0 } }],
      ['rotate', { instanceIds: [ids[1]], axis: 'y', degrees: 90 }],
      ['set_transform', { instanceIds: [ids[1]], pose }],
      ['set_color', { instanceIds: [ids[1]], colorId: 'c:blue' }],
      ['delete', { instanceIds: [ids[1]] }],
      ['create_group', { instanceIds: [ids[1]], name: 'g' }],
      ['create_submodel', { instanceIds: [ids[1]], name: 's' }],
      ['make_unique', { instanceId: ids[1] }],
      ['ungroup', { groupIds: Object.keys(s.session.document.groups) }],
      ['replace_color', { fromColorId: 'c:red', toColorId: 'c:blue' }],
    ] as const)
      expect(await call(name, args), name).toMatchObject({ ok: false, code: 'OUT_OF_SCOPE' });
    expect(await call('set_color', { instanceIds: [ids[0]], colorId: 'c:blue' })).toMatchObject({ ok: true });
    expect(
      await call('batch', {
        operations: [
          { tool: 'delete', arguments: { instanceIds: [ids[0]] } },
          { tool: 'delete', arguments: { instanceIds: [ids[1]] } },
        ],
        atomic: true,
      }),
    ).toMatchObject({ ok: true, data: { rolledBack: true, results: [{ ok: true }, { code: 'OUT_OF_SCOPE' }] } });
    expect(expandInstances(s.session.document)[0]?.colorId).toBe('c:blue');
    const added = (await call('place_part', {
      partId: 'ld:3001',
      colorId: 'c:red',
      pose: { ...pose, x: 30 },
    })) as Extract<ToolResult, { ok: true }>;
    const addedId = (added.data as { created: string[] }).created[0];
    expect(await call('delete', { instanceIds: [addedId] })).toMatchObject({ ok: true });
    expect(await call('get_instance', { instanceId: ids[1] })).toMatchObject({ ok: true });
    await call('commitTransaction');
    await scoped.request('beginTransaction', 'MCP', 'mcp');
    expect(await scoped.request('delete', { instanceIds: [ids[1]] }, 'mcp')).toMatchObject({ ok: true });
    await scoped.request('commitTransaction', {}, 'mcp');
  });
  it('permits selected submodel descendants across regrouping and requires uniqueness for shared contents', async () => {
    const s = setup();
    await s.host.beginTransaction('seed');
    const placed = await s.data('place_part', { partId: 'ld:3001', colorId: 'c:red', pose });
    const sub = await s.data('create_submodel', { instanceIds: placed.created, name: '车身' });
    await s.host.commitTransaction();
    let scoped = new RendererEditorHost(s.services, { base: s.session.document, paths: [sub.modelPath as string[]] });
    await scoped.request('beginTransaction', 'child', 'ai');
    expect(await scoped.request('set_color', { instanceIds: placed.created, colorId: 'c:blue' }, 'ai')).toMatchObject({
      ok: true,
    });
    expect(
      await scoped.request('create_submodel', { instanceIds: placed.created, name: 'nested' }, 'ai'),
    ).toMatchObject({ ok: true });
    expect(
      await scoped.request('move', { instanceIds: placed.created, delta: { x: 1, z: 0, level: 0 } }, 'ai'),
    ).toMatchObject({ ok: true });
    await scoped.request('commitTransaction', {}, 'ai');
    await s.host.beginTransaction('share');
    await s.data('instantiate_submodel', { submodelId: sub.submodelId, pose: { ...pose, x: 20 } });
    await s.host.commitTransaction();
    s.session.setContext({ activeModelPath: sub.modelPath as string[], selection: [] });
    scoped = new RendererEditorHost(s.services, { base: s.session.document, paths: [sub.modelPath as string[]] });
    await scoped.request('beginTransaction', 'shared child', 'ai');
    // The path resolver itself rejects an ambiguous nested ID before any mutation.
    expect(await scoped.request('replace_color', { fromColorId: 'c:blue', toColorId: 'c:red' }, 'ai')).toMatchObject({
      ok: false,
      code: 'OUT_OF_SCOPE',
    });
    await scoped.request('commitTransaction', {}, 'ai');
  });
  it('distinguishes an empty model from a reference without a subject', async () => {
    const s = setup();
    await s.host.beginTransaction('reference');
    const ref = await s.data('add_reference_image', { image, name: '正面', view: 'front' });
    const blank = { width: rgba.width, height: rgba.height, data: new Uint8Array(rgba.data.length) };
    vi.mocked(s.services.render).mockResolvedValue({ images: [image], rgba: [blank] });
    expect(await s.data('compare_to_reference', { referenceId: ref.referenceId, view: 'front' })).toMatchObject({
      iou: 0,
      emptyModel: true,
      colorDifference: null,
      images: [image, image],
    });
    s.services.decode = async () => blank;
    expect(await s.tool('compare_to_reference', { referenceId: ref.referenceId, view: 'front' })).toMatchObject({
      ok: false,
      code: 'REFERENCE_EMPTY',
    });
    await s.host.commitTransaction();
  });
  it('stops before a second paid request when accrued usage reaches the daily limit and commits completed edits', async () => {
    const s = setup();
    s.session.dispatch({ type: 'part.add', partId: 'ld:3001', colorId: 'c:red' });
    const id = expandInstances(s.session.document)[0]!.path.at(-1)!;
    let requests = 0;
    const provider: ModelProvider = {
      id: 'offline',
      billing: 'api',
      endpoint: 'http://127.0.0.1',
      listModels: async () => [],
      capabilities: () => ({ vision: false, tools: true, reasoning: false, maxContext: 128000, contextWindow: 128000 }),
      async *stream() {
        requests++;
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 0, cacheReadInputTokens: 0 } };
        yield {
          type: 'tool_call',
          call: {
            type: 'tool_call',
            id: 'move',
            name: 'move',
            arguments: { instanceIds: [id], delta: { x: 0.5, z: 0, level: 0 } },
          },
        };
        yield { type: 'done', reason: 'tool_calls' };
      },
    };
    const ledger = new DailyCostLedger();
    const turn = runAgentTurn({
      host: s.host,
      provider,
      model: 'fixture',
      system: 'test',
      history: [],
      userMessage: { role: 'user', content: [{ type: 'text', text: '移动' }] },
      tools: createEditorTools(),
      budget: { dailyCostLimit: 0.000005 },
      ledger,
      prices: { currency: 'USD', providers: { offline: { fixture: { input: 1, output: 1, cacheRead: 0 } } } },
    });
    for await (const event of turn.events) void event;
    expect((await turn.result).reason).toBe('daily_cost_limit');
    expect(requests).toBe(1);
    expect(ledger.spent()).toBe(0.000005);
    expect(s.session.history.at(-1)?.source).toBe('ai');
    expect(expandInstances(s.session.document)[0]!.worldMatrix[12]).toBe(10);
    s.session.undo();
    expect(expandInstances(s.session.document)[0]!.worldMatrix[12]).toBe(0);
  });
  it('rejects deletion of the active occurrence without discarding previous successful edits', async () => {
    const s = setup();
    await s.host.beginTransaction('prepare');
    const placed = await s.data('place_part', { partId: 'ld:3001', colorId: 'c:red', pose });
    const sub = await s.data('create_submodel', { instanceIds: placed.created, name: '车身' });
    await s.host.commitTransaction();
    s.session.setContext({ activeModelPath: sub.modelPath as string[], selection: [] });
    await s.host.beginTransaction('edit child');
    await s.data('place_part', { partId: 'ld:3001', colorId: 'c:red', pose: { ...pose, x: 10 } });
    expect(await s.tool('delete', { instanceIds: [sub.instanceId] })).toMatchObject({
      ok: false,
      code: 'INVALID_CONTEXT',
    });
    expect(expandInstances(s.session.document)).toHaveLength(2);
    await s.host.commitTransaction();
    expect(s.session.history).toHaveLength(2);
    s.session.undo();
    expect(expandInstances(s.session.document)).toHaveLength(1);
  });
  it('queries the real document and catalog, converts coordinates, and commits all edits once', async () => {
    const s = setup();
    await s.host.beginTransaction('AI：修改');
    const first = await s.data('place_part', { partId: 'ld:3001', colorId: 'c:red', pose });
    const id = (first.created as string[])[0]!;
    expect(await s.data('get_instance', { instanceId: id })).toMatchObject({ position: { x: 0, z: 0, level: 3 } });
    expect(await s.data('get_model_summary')).toMatchObject({ partCount: 1, colorCount: 1 });
    expect(await s.data('list_instances', { colorId: 'c:red' })).toMatchObject({ total: 1 });
    expect(await s.data('get_selection')).toMatchObject({ paths: [] });
    expect(await s.data('search_parts', { query: '砖' })).toMatchObject({ parts: [{ id: 'ld:3001' }] });
    expect(await s.data('get_part_info', { partId: 'ld:3001' })).toMatchObject({
      footprint: { x: 4, z: 2 },
      colors: ['c:red', 'c:blue'],
    });
    expect((await s.data('list_colors')).colors).toHaveLength(2);
    expect(
      (await s.data('find_connection_candidates', { partId: 'ld:3001', targetInstanceId: id })).candidates,
    ).not.toHaveLength(0);
    await s.data('move', { instanceIds: [id], delta: { x: 0.5, z: 1, level: 1 } });
    expect(await s.data('get_instance', { instanceId: id })).toMatchObject({ position: { x: 0.5, z: 1, level: 4 } });
    await s.data('rotate', { instanceIds: [id], axis: 'y', degrees: 90 });
    await s.data('set_transform', { instanceIds: [id], pose });
    await s.data('set_color', { instanceIds: [id], colorId: 'c:blue' });
    await s.data('replace_color', { fromColorId: 'c:blue', toColorId: 'c:red' });
    expect(await s.data('get_bom')).toMatchObject({ total: 1 });
    expect((await s.data('suggest_factory_substitutes', { partId: 'ld:3001' })).parts).toHaveLength(1);
    expect(await s.data('validate')).toEqual({ issues: [] });
    await s.data('render_views', { views: ['front', 'top'] });
    expect(s.services.render).toHaveBeenCalledWith(s.session.document, {
      views: ['front', 'top'],
      width: 768,
      height: 768,
      transparent: false,
    });
    await s.data('export_io');
    await s.host.commitTransaction();
    expect(s.session.history).toHaveLength(1);
    expect(s.session.history[0]!.source).toBe('ai');
    s.session.undo();
    expect(expandInstances(s.session.document)).toHaveLength(0);
  });
  it('preserves earlier edits when an atomic batch fails, and returns per-operation results', async () => {
    const s = setup();
    await s.host.beginTransaction('batch');
    await s.data('place_part', { partId: 'ld:3001', colorId: 'c:red', pose });
    const before = serializeDocument(s.session.document);
    const result = await s.data('batch', {
      operations: [
        { tool: 'place_part', arguments: { partId: 'ld:3001', colorId: 'c:red', pose } },
        { tool: 'place_part', arguments: { partId: 'ld:missing', colorId: 'c:red', pose } },
      ],
      atomic: true,
    });
    expect(result.rolledBack).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(serializeDocument(s.session.document)).toEqual(before);
    const nonAtomic = await s.data('batch', {
      operations: [
        { tool: 'place_part', arguments: { partId: 'ld:3001', colorId: 'c:red', pose } },
        { tool: 'place_part', arguments: { partId: 'ld:missing', colorId: 'c:red', pose } },
      ],
      atomic: false,
    });
    expect(nonAtomic.rolledBack).toBe(false);
    expect(expandInstances(s.session.document)).toHaveLength(2);
    await s.host.commitTransaction();
    expect(s.session.history).toHaveLength(1);
  });
  it.each([true, false])('keeps batch rollback, skipped results and one undo point (atomic=%s)', async (atomic) => {
    const s = setup();
    await s.host.beginTransaction('batch boundaries');
    const first = await s.data('place_part', { partId: 'ld:3001', colorId: 'c:red', pose });
    const id = (first.created as string[])[0]!;
    const before = serializeDocument(s.session.document);
    vi.mocked(s.services.changed).mockClear();
    const result = await s.data('batch', {
      atomic,
      operations: [
        { tool: 'set_color', arguments: { instanceIds: [id], colorId: 'c:blue' } },
        { tool: 'place_part', arguments: { partId: 'ld:missing', colorId: 'c:red', pose } },
        { tool: 'move', arguments: { instanceIds: [id], delta: { x: 1, z: 0, level: 0 } } },
      ],
    });
    expect(result.rolledBack).toBe(atomic);
    expect(result.results).toMatchObject([
      { ok: true, data: { changed: 1 } },
      { ok: false, code: 'PART_NOT_FOUND', message: 'PART_NOT_FOUND' },
      atomic ? { ok: false, code: 'BATCH_SKIPPED', message: 'BATCH_SKIPPED' } : { ok: true, data: { changed: 1 } },
    ]);
    expect(s.services.changed).toHaveBeenCalledTimes(1);
    expect(s.session.history).toHaveLength(0);
    if (atomic) expect(serializeDocument(s.session.document)).toBe(before);
    else {
      const row = expandInstances(s.session.document)[0]!;
      expect(row.colorId).toBe('c:blue');
      expect(row.worldMatrix[12]).toBe(20);
    }
    const successful = serializeDocument(s.session.document);
    expect(await s.tool('delete', { instanceIds: ['missing'] })).toMatchObject({ ok: false });
    expect(serializeDocument(s.session.document)).toBe(successful);
    await s.host.commitTransaction();
    expect(s.session.history).toHaveLength(1);
    expect(s.session.history[0]!.source).toBe('ai');
    expect(s.session.undo().ok).toBe(true);
    expect(expandInstances(s.session.document)).toEqual([]);
    expect(s.session.redo().ok).toBe(true);
    expect(expandInstances(s.session.document)).toHaveLength(1);
  });
  it('stages only new primitives while retaining immutable earlier snapshots', async () => {
    const s = setup();
    await s.host.beginTransaction('incremental');
    const first = await s.data('place_part', { partId: 'ld:3001', colorId: 'c:red', pose });
    const id = (first.created as string[])[0]!;
    await s.data('set_color', { instanceIds: [id], colorId: 'c:blue' });
    const snapshot = s.session.document;
    const instance = snapshot.models[snapshot.rootModelId]!.instances[id];
    await s.data('place_part', { partId: 'ld:3001', colorId: 'c:red', pose: { ...pose, x: 10 } });
    // Replaying the earlier color primitive would replace this unchanged instance.
    expect(s.session.document.models[snapshot.rootModelId]!.instances[id]).toBe(instance);
    expect(expandInstances(snapshot)).toHaveLength(1);
    await s.host.commitTransaction();
    expect(s.session.history).toHaveLength(1);
    expect(s.session.undo().ok).toBe(true);
    expect(expandInstances(s.session.document)).toEqual([]);
  });
  it('keeps each MCP call as a separate undo point after a batched call', async () => {
    const s = setup();
    await s.renderer.request('beginTransaction', 'external batch', 'mcp');
    const batch = (await s.renderer.request(
      'batch',
      {
        atomic: true,
        operations: [
          { tool: 'place_part', arguments: { partId: 'ld:3001', colorId: 'c:red', pose } },
          { tool: 'place_part', arguments: { partId: 'ld:3001', colorId: 'c:blue', pose: { ...pose, x: 10 } } },
        ],
      },
      'mcp',
    )) as ToolResult;
    expect(batch).toMatchObject({ ok: true, data: { rolledBack: false } });
    await s.renderer.request('commitTransaction', null, 'mcp');
    const id = expandInstances(s.session.document)[0]!.path.at(-1)!;
    await s.renderer.request('beginTransaction', 'external colour', 'mcp');
    expect(await s.renderer.request('set_color', { instanceIds: [id], colorId: 'c:blue' }, 'mcp')).toMatchObject({
      ok: true,
    });
    await s.renderer.request('commitTransaction', null, 'mcp');
    expect(s.session.history.map((entry) => entry.source)).toEqual(['mcp', 'mcp']);
    expect(s.session.undo().ok).toBe(true);
    expect(expandInstances(s.session.document).map((row) => row.colorId)).toEqual(['c:red', 'c:blue']);
    expect(s.session.undo().ok).toBe(true);
    expect(expandInstances(s.session.document)).toEqual([]);
  });
  it('groups, creates/instantiates submodels, makes unique, ungroups and deletes through commands', async () => {
    const s = setup();
    await s.host.beginTransaction('structure');
    const first = await s.data('place_part', { partId: 'ld:3001', colorId: 'c:red', pose });
    const id = (first.created as string[])[0]!;
    const group = await s.data('create_group', { instanceIds: [id], name: '砖块' });
    await s.data('ungroup', { groupIds: [group.groupId] });
    const sub = await s.data('create_submodel', { instanceIds: [id], name: '车身' });
    const inst = await s.data('instantiate_submodel', { submodelId: sub.submodelId, pose: { ...pose, x: 8 } });
    await s.data('make_unique', { instanceId: inst.instanceId });
    await s.data('delete', { instanceIds: [inst.instanceId] });
    await s.host.commitTransaction();
    expect(s.session.history).toHaveLength(1);
    expect(expandInstances(s.session.document)).toHaveLength(1);
  });

  it.each([
    [2000, 1500, false],
    [1500, 2000, false],
    [2000, 1500, true],
    [600, 400, false],
    [768, 512, false],
  ])(
    'compares %i×%i references at up to 768 pixels (transparent: %s)',
    async (width, height, transparent) => {
      const s = setup();
      // A stepped silhouette with a shifted render makes IoU nontrivial. White on
      // transparent also catches accidental compositing onto a white background.
      const picture = (w: number, h: number, shift = 0) => {
        const data = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const px = x / w - shift,
              py = y / h;
            const subject =
              (px >= 0.2 && px < 0.8 && py >= 0.4 && py < 0.85) || (px >= 0.35 && px < 0.65 && py >= 0.15 && py < 0.4);
            data.set(
              subject
                ? transparent
                  ? [255, 255, 255, 255]
                  : [200, 30, 10, 255]
                : transparent
                  ? [40, 100, 220, 0]
                  : [255, 255, 255, 255],
              (y * w + x) * 4,
            );
          }
        return { width: w, height: h, data };
      };
      const reference = picture(width, height);
      const encoded: RgbaImage[] = [];
      s.services.decode = async () => reference;
      s.services.encode = (rgba) => {
        encoded.push(rgba);
        return { ...image, base64: btoa(JSON.stringify({ width: rgba.width, height: rgba.height })) };
      };
      vi.mocked(s.services.render).mockImplementation(async (_doc, input) => {
        const rendered = picture(input.width, input.height, 0.03);
        return { images: [s.services.encode(rendered)], rgba: [rendered] };
      });
      await s.host.beginTransaction('reference');
      const ref = await s.data('add_reference_image', { image, name: 'synthetic', view: 'front' });
      const result = await s.data('compare_to_reference', { referenceId: ref.referenceId, view: 'front' });
      const scale = Math.min(1, 768 / Math.max(width, height));
      const expected = { width: Math.round(width * scale), height: Math.round(height * scale) };
      expect(s.services.render).toHaveBeenCalledWith(s.session.document, {
        ...expected,
        views: ['front'],
        transparent: true,
      });
      const pair = result.images as ImageBlock[];
      expect(pair).toHaveLength(2);
      for (const value of pair) expect(JSON.parse(atob(value.base64))).toEqual(expected);
      const composite = JSON.parse(atob((result.comparisonImage as ImageBlock).base64)) as {
        width: number;
        height: number;
      };
      if (scale < 1) {
        expect(Math.max(composite.width, composite.height)).toBe(768);
        expect(encoded[1]).not.toBe(reference);
        if (transparent) {
          expect(encoded[1]!.data[3]).toBe(0);
          expect(encoded[1]!.data.some((value, i) => i % 4 === 3 && value > 0 && value < 255)).toBe(true);
        }
      } else {
        expect(encoded[1]).toBe(reference);
        expect(composite).toEqual({ width: width * 2 + 8, height });
      }
      const original = compareImages(reference, picture(width, height, 0.03));
      // Allow <1 percentage point for edge pixel quantization, not a change of silhouette.
      expect(Math.abs(Number(result.iou) - original.iou)).toBeLessThan(0.01);
      expect(Math.abs(Number(result.colorDifference) - original.colorDifference!)).toBeLessThan(0.5);
      expect(Math.abs(Number(result.boundsRatioDifference) - original.boundsRatioDifference!)).toBeLessThan(0.02);
      expect(s.session.document.referenceImages[String(ref.referenceId)]).toMatchObject({ width, height });
      expect(Object.values(s.tab.assets)).toEqual([new Uint8Array([1, 2, 3])]);
    },
    15000,
  );

  it('adds hashed reference assets, compares RGBA IoU, creates mosaic and rejects unknown jobs', async () => {
    const s = setup();
    await s.host.beginTransaction('reference');
    const ref = await s.data('add_reference_image', { image, name: '正面', view: 'front' });
    expect(Object.keys(s.tab.assets)[0]).toMatch(/^assets\/images\/[a-f0-9]{64}$/);
    expect(await s.data('compare_to_reference', { referenceId: ref.referenceId, view: 'front' })).toMatchObject({
      iou: 1,
      images: [image, image],
    });
    expect(await s.tool('compare_to_reference', { referenceId: ref.referenceId, view: 'left' })).toMatchObject({
      code: 'VIEW_MISMATCH',
    });
    await s.data('make_mosaic', {
      referenceId: ref.referenceId,
      width: 2,
      height: 2,
      name: '图案',
      partId: 'ld:3070b',
    });
    for (const name of ['job_status', 'job_cancel'] as const)
      expect(await s.tool(name, { jobId: 'missing' })).toMatchObject({ ok: false, code: 'JOB_NOT_FOUND' });
    await s.host.commitTransaction();
    expect(s.session.history).toHaveLength(1);
    s.session.undo();
    expect(Object.keys(s.session.document.referenceImages)).toHaveLength(0);
  });
  it('returns only newly introduced issues and rejects mutations from another owner while reserved', async () => {
    const s = setup();
    await s.renderer.request('reserve', {}, 'ai');
    expect(await s.renderer.request('get_selection', {}, 'mcp')).toMatchObject({ code: 'DOCUMENT_BUSY' });
    await s.host.beginTransaction('issues');
    await s.data('place_part', { partId: 'ld:3001', colorId: 'c:red', pose });
    const result = await s.tool('place_part', { partId: 'ld:3001', colorId: 'c:red', pose: { ...pose, x: 0.5 } });
    expect(result).toMatchObject({ ok: true, introducedIssues: [{ kind: 'collision' }] });
    await s.host.commitTransaction();
    await s.renderer.request('release', {}, 'ai');
    expect(s.services.lock).not.toHaveBeenCalled();
    const external = createEditorHost(s.rpc.call, 'mcp');
    expect(await external.list_documents({})).toMatchObject({ ok: true });
    expect(await external.open_document({ path: 'fixture.brkl' })).toMatchObject({ ok: true });
    expect(await external.set_active_document({ documentId: s.session.document.documentId })).toMatchObject({
      ok: true,
    });
  });
  it('rejects illegal input and read-only documents without leaving a transaction', async () => {
    const s = setup();
    s.tab.readOnly = true;
    await expect(s.host.beginTransaction('read-only')).rejects.toThrow();
    expect(s.session.isPreviewing).toBe(false);
    expect(await s.tool('place_part', { partId: 'bad' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
  });
  it('enforces image task palette and category restrictions inside the shared transaction host', async () => {
    const s = setup();
    await s.renderer.request('reserve', {}, 'ai');
    await s.renderer.request(
      'image.configure',
      { palette: { source: 'custom', colorIds: ['c:red'] }, parts: { source: 'categories', categories: ['brick'] } },
      'ai',
    );
    await s.host.beginTransaction('image task');
    expect(await s.tool('place_part', { partId: 'ld:3001', colorId: 'c:blue', pose })).toMatchObject({
      ok: false,
      code: 'COLOR_RESTRICTED',
    });
    await s.data('place_part', { partId: 'ld:3001', colorId: 'c:red', pose });
    await s.renderer.request('image.configure', { parts: { source: 'categories', categories: ['tile'] } }, 'ai');
    expect(await s.tool('place_part', { partId: 'ld:3001', colorId: 'c:red', pose })).toMatchObject({
      ok: false,
      code: 'CATEGORY_RESTRICTED',
    });
    await s.host.commitTransaction();
    expect(await s.renderer.request('release', {}, 'ai')).toMatchObject({
      transactionId: s.session.history[0]!.id,
      changed: 1,
    });
    await s.renderer.request('reserve', {}, 'ai');
    await s.data('get_model_summary');
    expect(await s.renderer.request('release', {}, 'ai')).toEqual({ transactionId: undefined, changed: 0 });
  });
  it('uses upward plate heights and never snaps reverse coordinates', () => {
    expect(gridToLdu({ x: 0.5, z: 1, level: 3 })).toEqual({ x_ldu: 10, y_ldu: -24, z_ldu: 20 });
    expect(lduToGrid({ x_ldu: 3, y_ldu: -2, z_ldu: 5 })).toEqual({ x: 0.15, level: 0.25, z: 0.25 });
  });
});
