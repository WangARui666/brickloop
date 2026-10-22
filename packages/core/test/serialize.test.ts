import { describe, expect, it } from 'vitest';
import { DocumentSession, parseDocument, serializeDocument, validateDocument } from '../src';
import { pairFixture, run } from './fixtures';

describe('canonical serialization', () => {
  it('P01 normalizes matrices and round-trips IDs, order, groups and sharing byte-for-byte', () => {
    const f = pairFixture();
    const grouped = run(f.doc, f.context, { type: 'group.create', name: '保留组' }).doc;
    const before = grouped.models[f.modelId]!.instances[f.first.id]!;
    before.transform[0] = 12.123456;
    before.transform[4] = 1e-10;
    const serialized = serializeDocument(grouped),
      parsed = parseDocument(serialized);
    expect(parsed.issues).toEqual([]);
    expect(parsed.doc!.documentId).toBe(grouped.documentId);
    expect(serializeDocument(parsed.doc!)).toBe(serialized);
    expect(serializeDocument(grouped)).toBe(serialized);
    expect(parsed.doc!.models[f.modelId]!.instances[f.first.id]!.transform[0]).toBe(12.1235);
    expect(before.transform[0]).toBe(12.123456);
    expect(parsed.doc!.models[f.pair.id]!.stepIds).toEqual(f.pair.stepIds);
    expect(parsed.doc!.models[f.pair.id]!.steps[f.pair.stepIds[0]!]!.instanceIds).toEqual([f.red.id, f.yellow.id]);
  });
  it('P05 retains unknown fields at every object depth and leaves extension transforms opaque', () => {
    const f = pairFixture(),
      doc = f.doc;
    doc.futureRoot = { b: 2, a: 1, ordered: [3, 1, 2], transform: [0.123456789, 2] };
    doc.extensions['future.plugin'] = { schema: 5, enabled: true, transform: [1e-12, 0.123456789] };
    doc.meta.futureMeta = { value: '中文' };
    doc.catalogPack.futureCatalog = [2, 1];
    const model = doc.models[f.pair.id]!;
    model.futureModel = 42;
    model.extensions['ldraw.meta'] = ['0 !FUTURE x', '0 !FUTURE y'];
    model.steps[model.stepIds[0]!]!.futureStep = { exact: 1e-12 };
    model.steps[model.stepIds[0]!]!.camera = { futureCamera: 3 };
    model.instances[f.red.id]!.futureInstance = { limit: [30, 45] };
    model.instances[f.red.id]!.ref.futureRef = 'kept';
    const grouped = run(doc, f.context, { type: 'group.create', name: 'future' }).doc;
    Object.values(grouped.groups)[0]!.futureGroup = { owner: 'custom' };
    const result = parseDocument(serializeDocument(grouped));
    expect(result.issues).toEqual([]);
    expect(serializeDocument(result.doc!)).toBe(serializeDocument(grouped));
    expect(result.doc!.futureRoot).toEqual(doc.futureRoot);
    expect(result.doc!.extensions).toEqual(doc.extensions);
    const restoredModel = result.doc!.models[f.pair.id]!;
    expect(restoredModel.futureModel).toBe(42);
    expect(restoredModel.extensions).toEqual(model.extensions);
    expect(restoredModel.steps[model.stepIds[0]!]!.futureStep).toEqual({ exact: 1e-12 });
    expect(restoredModel.steps[model.stepIds[0]!]!.camera).toEqual({ futureCamera: 3 });
    expect(restoredModel.instances[f.red.id]!.ref.futureRef).toBe('kept');
    expect(Object.values(result.doc!.groups)[0]!.futureGroup).toEqual({ owner: 'custom' });
    const changed = run(
      result.doc!,
      { activeModelPath: [f.first.id], selection: [[f.first.id, f.red.id]] },
      { type: 'color.set', colorId: 'c:blue' },
    ).doc;
    expect(changed.models[f.pair.id]!.instances[f.red.id]!.futureInstance).toEqual({ limit: [30, 45] });
  });
  it('sorts numeric-looking keys lexically too, without reordering arrays', () => {
    const f = pairFixture();
    f.doc.extensions = { '2': 'second', '10': 'tenth', z: [2, 1] };
    const text = serializeDocument(f.doc);
    expect(text).toContain('"extensions":{"10":"tenth","2":"second","z":[2,1]}');
  });
  it('returns READ_ONLY_NEWER and sessions refuse edits of future documents', () => {
    const f = pairFixture();
    f.doc.schemaVersion = 2;
    f.doc.futureField = 'keep';
    const parsed = parseDocument(serializeDocument(f.doc));
    expect(parsed.doc!.schemaVersion).toBe(2);
    expect(parsed.issues.map((issue) => issue.code)).toEqual(['READ_ONLY_NEWER']);
    const session = new DocumentSession(parsed.doc!);
    expect(session.begin('edit').ok).toBe(false);
    const result = session.dispatch({ type: 'edit.delete' }, f.context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('READ_ONLY_NEWER');
    expect(session.history).toHaveLength(0);
  });
  it('reports invalid JSON and structure with paths; missing catalog data is not structural failure', () => {
    expect(parseDocument('{').issues[0]!.code).toBe('INVALID_JSON');
    expect(parseDocument('{}').doc).toBeNull();
    const f = pairFixture();
    const raw = JSON.parse(serializeDocument(f.doc)) as typeof f.doc;
    raw.models[f.pair.id]!.instances[f.red.id]!.transform = [1, 2];
    const result = parseDocument(JSON.stringify(raw));
    expect(result.doc).toBeNull();
    expect(result.issues[0]!.path).toContain('.transform');
    expect(validateDocument(f.doc)).toEqual([]);
  });
  it('preserves JSON keys such as __proto__ without changing object prototypes', () => {
    const f = pairFixture();
    f.doc.extensions = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"data":1}}') as Record<
      string,
      unknown
    >;
    const parsed = parseDocument(serializeDocument(f.doc));
    expect(Object.hasOwn(parsed.doc!.extensions, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(parsed.doc!.extensions)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('rejects non-JSON extension values rather than silently dropping them', () => {
    const f = pairFixture();
    f.doc.extensions.bad = undefined;
    expect(() => serializeDocument(f.doc)).toThrow('non-JSON');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    f.doc.extensions.bad = cycle;
    expect(() => serializeDocument(f.doc)).toThrow('JSON cycle');
  });
});
