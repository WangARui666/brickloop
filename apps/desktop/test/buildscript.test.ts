import { describe, expect, it, vi } from 'vitest';
import { createDocument, DocumentSession, expandInstances, validateDocument } from '@brickloop/core';
import type { ToolResult } from '@brickloop/ai';
import { toolSchemas } from '@brickloop/ai';
import { createI18n } from '@brickloop/i18n';
import { packProject, unpackProject } from '@brickloop/io';
import { runBuildScript, standardPackingParts } from '../../../packages/buildscript/src/index';
import { RendererEditorHost } from '../src/renderer/src/ai-editor-host';
import type { EditorHostServices } from '../src/renderer/src/ai-editor-host';
import {
  buildScriptAssets,
  editedScriptOutput,
  findScript,
  patchBuildScript,
  detachBuildScript,
  scriptOutputs,
  SCRIPT_EXTENSION,
} from '../src/shared/buildscript-document';
import type { BuildCatalog } from '../src/shared/buildscript-catalog';
import { planDesignGuides, planBuildExamples } from '../src/main/buildscript-guidance';
import { parseStructurePlan } from '@brickloop/ai';

const catalog: BuildCatalog = {
  parts: standardPackingParts.map((p) => ({ ...p, factory: true })),
  colors: [
    { id: 'c:red', name: 'Red', rgb: '#C91A09', factory: true },
    { id: 'c:blue', name: 'Blue', rgb: '#0055BF', factory: true },
  ],
};
function setup(base = createDocument(), paths?: string[][]) {
  const session = new DocumentSession(base),
    tab = { session, assets: {}, readOnly: false };
  const services: EditorHostServices = {
    active: () => tab,
    lock: vi.fn(),
    changed: vi.fn(),
    library: {
      catalogSearch: async () => [],
      catalogPart: async () => null,
      catalogColors: async () => ({ factory: [], all: [] }),
    },
    assemblyPart: async () => {
      throw new Error('Not needed for build scripts');
    },
    catalog: async () => ({ parts: [], colors: [] }),
    check: async () => [],
    render: async () => ({ images: [], rgba: [] }),
    decode: async () => ({ width: 1, height: 1, data: new Uint8Array(4) }),
    encode: () => ({ type: 'image', mime: 'image/png', base64: 'AAAA' }),
    bom: async () => ({}),
    exportIo: async () => ({}),
    documents: async () => ({ ok: false, code: 'UNUSED', message: 'Unused' }),
    buildCatalog: async () => catalog,
    runBuildScript: vi.fn(runBuildScript),
  };
  const host = new RendererEditorHost(services, paths ? { base, paths } : undefined);
  const call = async (tool: string, value: unknown = {}, owner: 'ai' | 'mcp' = 'ai') =>
    (await host.request(tool, value, owner)) as ToolResult;
  const run = async (value: unknown, owner: 'ai' | 'mcp' = 'ai') => {
    await call('beginTransaction', 'script', owner);
    const result = await call('run_build_script', value, owner);
    await call('commitTransaction', {}, owner);
    return result;
  };
  return { session, host, run, call, services };
}
const code = 'submodel("Walls",()=>box(0,0,0,8,4,6,"Red")); instance("Walls",{x:0,z:0,y:0});';

describe('desktop build script integration', () => {
  it('preserves script locations and separates unavailable engines from editable scripts', async () => {
    const s = setup();
    for (const source of ['\n  const =;', '\n  throw new Error("fixture script");']) {
      expect(await s.run({ scriptId: 'bad', code: source })).toMatchObject({
        ok: false,
        details: { line: 2, column: expect.any(Number) },
      });
    }
    vi.mocked(s.services.runBuildScript!).mockRejectedValue(new Error('WebAssembly.instantiate failed, token=secret'));
    const failure = await s.run({ scriptId: 'unavailable', code });
    expect(failure).toMatchObject({ ok: false, code: 'ENGINE_UNAVAILABLE' });
    expect(JSON.stringify(failure)).not.toContain('secret');
    expect(expandInstances(s.session.document)).toHaveLength(0);
  });
  it('uses explicit confirmed categories even when names suggest another category, and matches example metadata', () => {
    const parsed = parseStructurePlan({
      name: 'Tower',
      components: [
        {
          id: 'tree',
          name: 'tower tree',
          category: 'plants',
          strategy: 'shapes',
          size: { width: 4, depth: 4, height: 6 },
          colors: ['c:red'],
          partTypes: ['brick'],
        },
      ],
      buildOrder: ['tree'],
    });
    if (!parsed.ok) throw new Error('Invalid fixture plan');
    expect(planDesignGuides(parsed.plan)).toContain('Design guide: plants');
    expect(planDesignGuides(parsed.plan)).not.toContain('Design guide: buildings');
    expect(planBuildExamples(parsed.plan, { examples: [{ id: 'cottage' }, { id: 'trees' }] })).toEqual([
      { id: 'trees' },
    ]);
  });
  it('localizes every exported editor tool in both UI languages', () => {
    for (const language of ['zh-CN', 'en'] as const) {
      const i18n = createI18n({ language });
      for (const tool of Object.keys(toolSchemas))
        expect(i18n.exists(`aiTools.${tool}`), `${language}: ${tool}`).toBe(true);
    }
  });
  it('keeps previous visible generations unchanged when adding or rerunning after conversion', async () => {
    const s = setup();
    await s.run({ scriptId: 'a', code });
    const count = expandInstances(s.session.document).length;
    await s.run({ scriptId: 'a', mode: 'add' });
    expect(expandInstances(s.session.document)).toHaveLength(count * 2);
    s.session.applyExternal(detachBuildScript(s.session.document, 'a'), 'detach');
    await s.run({ scriptId: 'a' });
    expect(expandInstances(s.session.document)).toHaveLength(count * 3);
    await s.run({ scriptId: 'a', code: code.replace('Red', 'Blue') });
    expect(expandInstances(s.session.document)).toHaveLength(count * 3);
    expect(expandInstances(s.session.document).filter((r) => r.colorId === 'c:blue')).toHaveLength(count);
  });
  it('retains script submodel names that coincide with JavaScript object properties', async () => {
    const s = setup();
    expect(await s.run({ scriptId: 'names', code: code.replaceAll('Walls', '__proto__') })).toMatchObject({ ok: true });
    expect(Object.keys(findScript(s.session.document, 'names')!.models)).toEqual(['__proto__']);
    expect(await s.run({ scriptId: 'names' })).toMatchObject({ ok: true });
    expect(validateDocument(s.session.document)).toEqual([]);
  });
  it('writes one undoable transaction, preserves grid/matrix poses, reuses definitions and replaces only its own output', async () => {
    const s = setup();
    s.session.dispatch({ type: 'part.add', partId: 'ld:3001', colorId: 'c:blue' });
    const manual = expandInstances(s.session.document)[0]!.instance.id;
    const first = await s.run({ scriptId: 'house', name: 'House', code, seed: 7 });
    expect(first).toMatchObject({
      ok: true,
      data: { stats: { colors: 1 }, submodels: [{ name: 'root' }, { name: 'Walls' }] },
    });
    expect(s.session.history).toHaveLength(2);
    const old = findScript(s.session.document, 'house')!,
      ids = old.instanceIds,
      model = old.models.Walls;
    const repeated = await s.run({ scriptId: 'house' });
    expect(repeated).toMatchObject({ ok: true, data: { hash: old.hash, changed: old.instanceIds.length * 2 } });
    expect(findScript(s.session.document, 'house')!.models.Walls).toBe(model);
    expect(
      Object.values(s.session.document.models)
        .flatMap((m) => Object.keys(m.instances))
        .some((id) => ids.includes(id)),
    ).toBe(false);
    expect(expandInstances(s.session.document).find((i) => i.instance.id === manual)).toBeDefined();
    expect(await s.run({ scriptId: 'house', code: code.replace('Red', 'Blue') })).toMatchObject({ ok: true });
    expect(findScript(s.session.document, 'house')!.hash).not.toBe(old.hash);
    s.session.undo();
    expect(findScript(s.session.document, 'house')!.hash).toBe(old.hash);
    expect(validateDocument(s.session.document)).toEqual([]);
    const layer = await s.call('view_layers', { modelPath: [], fromLevel: 0, toLevel: 5 });
    expect(layer).toMatchObject({ ok: true });
    expect(JSON.stringify(layer)).toContain('level 0');
  });
  it('tracks add output for subsequent replacement and conversion; detects manual edits, deletes and undo', async () => {
    const s = setup(),
      code = 'part("3001",{x:2,z:1,y:3},"Red")';
    await s.run({ scriptId: 'a', code });
    await s.run({ scriptId: 'b', code });
    await s.run({ scriptId: 'a', mode: 'add' });
    expect(findScript(s.session.document, 'a')!.instanceIds).toHaveLength(2);
    expect(expandInstances(s.session.document)).toHaveLength(3);
    await s.run({ scriptId: 'a' });
    expect(expandInstances(s.session.document)).toHaveLength(2);
    expect(editedScriptOutput(s.session.document, 'a')).toBe(false);
    const id = findScript(s.session.document, 'a')!.instanceIds[0]!;
    s.session.dispatch({ type: 'color.set', paths: [[id]], colorId: 'c:blue' });
    expect(editedScriptOutput(s.session.document, 'a')).toBe(true);
    s.session.undo();
    expect(editedScriptOutput(s.session.document, 'a')).toBe(false);
    s.session.dispatch({ type: 'edit.delete', paths: [[id]] });
    expect(editedScriptOutput(s.session.document, 'a')).toBe(true);
    s.session.undo();
    s.session.applyExternal(detachBuildScript(s.session.document, 'a'), 'detach');
    expect(findScript(s.session.document, 'a')!.instanceIds).toEqual([]);
    await s.run({ scriptId: 'a' });
    expect(expandInstances(s.session.document)).toHaveLength(3);
    expect(s.session.document.models[s.session.document.rootModelId]!.instances[id]).toBeDefined();
  });
  it('round trips script source/index, provenance and stats, including after undo', async () => {
    const s = setup();
    await s.run({ scriptId: 'house', code });
    const doc = s.session.document,
      assets = buildScriptAssets(doc, {});
    expect(new TextDecoder().decode(assets['ai/scripts/house.js'])).toBe(code);
    expect(JSON.parse(new TextDecoder().decode(assets['ai/scripts/index.json']))).toMatchObject([
      { scriptId: 'house', target: 'root', scope: 'factory', seed: 0 },
    ]);
    const opened = unpackProject(packProject(doc, s.session.workspace, assets));
    expect(opened.issues).toEqual([]);
    expect(scriptOutputs(opened.doc!)).toEqual(scriptOutputs(doc));
    expect(opened.doc!.models[doc.rootModelId]!.extensions[SCRIPT_EXTENSION]).toBeDefined();
    s.session.undo();
    expect(buildScriptAssets(s.session.document, opened.assets)['ai/scripts/house.js']).toBeUndefined();
  });
  it('returns source locations and leaves earlier work unchanged on runtime, syntax or patch failure', async () => {
    const s = setup();
    await s.run({ scriptId: 'a', code: 'box(0,0,0,4,2,3,"Red");' });
    const before = s.session.document;
    for (const value of [
      { code: '\nthrow new Error("oops")' },
      { code: 'const =' },
      { patch: '@@ -1 +1 @@\n-no match\n+box(0,0,0,1,1,3,"Red");' },
    ]) {
      expect(await s.run({ scriptId: 'a', ...value })).toMatchObject({
        ok: false,
        details: { line: expect.any(Number), column: expect.any(Number) },
      });
      expect(s.session.document).toEqual(before);
    }
    expect(
      await s.run({ scriptId: 'a', patch: '@@ -1 +1 @@\n-box(0,0,0,4,2,3,"Red");\n+box(0,0,0,4,2,3,"Blue");' }),
    ).toMatchObject({ ok: true });
    expect(findScript(s.session.document, 'a')!.script.code).toContain('Blue');
  });
  it('checks all replacement deletions against task-start selection; additions/new identities and MCP remain allowed', async () => {
    const initial = setup();
    await initial.run({ scriptId: 'a', code });
    const base = initial.session.document,
      rootId = Object.keys(base.models[base.rootModelId]!.instances)[0]!;
    const denied = setup(base, []);
    expect(await denied.run({ scriptId: 'a' })).toMatchObject({ ok: false, code: 'OUT_OF_SCOPE' });
    expect(denied.services.runBuildScript).not.toHaveBeenCalled();
    expect(await denied.run({ scriptId: 'new', code: 'box(20,0,0,2,2,3,"Red")' })).toMatchObject({ ok: true });
    expect(await denied.run({ scriptId: 'new' })).toMatchObject({ ok: true });
    expect(await denied.run({ scriptId: 'a' }, 'mcp')).toMatchObject({ ok: true });
    const allowed = setup(base, [[rootId]]);
    expect(await allowed.run({ scriptId: 'a' })).toMatchObject({ ok: true });
    initial.session.dispatch({ type: 'submodel.instantiate', modelId: findScript(base, 'a')!.models.Walls! });
    const shared = setup(initial.session.document, [[rootId]]);
    expect(await shared.run({ scriptId: 'a' })).toMatchObject({
      ok: false,
      code: 'OUT_OF_SCOPE',
      details: { rejected: expect.any(Array) },
    });
  });
  it('uses complete catalog scope, retains mirrored transforms and loads reference content', async () => {
    const s = setup();
    s.services.buildCatalog = async () => ({
      ...catalog,
      parts: [...catalog.parts, { id: 'custom', name: 'Asymmetric', category: 'other', kind: 'other', factory: false }],
    });
    const code = 'transform({mirrorX:true},()=>part("custom",{x:2,z:1,y:3},"Red"))';
    expect(await s.run({ scriptId: 'all', code })).toMatchObject({ ok: false, code: 'PART_NOT_ALLOWED' });
    expect(await s.run({ scriptId: 'all', code, scope: 'all' })).toMatchObject({ ok: true });
    const instance = expandInstances(s.session.document)[0]!.instance;
    expect(instance.transform[0]).toBe(-40);
    expect(instance.transform[3]).toBe(-1);
    expect(await s.call('list_build_examples')).toMatchObject({ ok: true });
    expect(await s.call('get_design_guide', { category: 'buildings' })).toMatchObject({ ok: true });
    expect(planDesignGuides({ title: '小屋和树' })).toContain('Design guide: plants');
  });
});
it('applies multiple strict diff hunks and rejects partial/count mismatches', () => {
  expect(patchBuildScript('a\nb\nc\nd', '@@ -1 +1 @@\n-a\n+A\n@@ -4 +4 @@\n-d\n+D\n\\ No newline at end of file')).toBe(
    'A\nb\nc\nD',
  );
  expect(patchBuildScript('a', '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n')).toBe('b\n');
  expect(patchBuildScript('a\n', '@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n')).toBe('b');
  expect(() => patchBuildScript('a', '@@ -1,2 +1 @@\n-a\n+A')).toThrow('does not match');
});
