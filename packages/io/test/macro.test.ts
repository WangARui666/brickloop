import { describe, expect, it } from 'vitest';
import {
  applyOps,
  createDocument,
  createModel,
  createUlidGenerator,
  DocumentSession,
  expandInstances,
  multiply,
  orderedInstances,
  rotationAxisAngle,
  serializeDocument,
  toLDraw,
  translation,
  validateDocument,
} from '@brickloop/core';
import type { BrkDocument, Instance, ModelDef, Vec3 } from '@brickloop/core';
import type { Pack } from '@brickloop/catalog/types';
import { createMacroFromSelection, macroAvailability, macroInsertOps, MacroError, readMacro, writeMacro } from '../src';
import { hashBytes, readZip, text, utf8, writeZip } from '../src/binary';
import { emptyThumbnail } from '../src/thumbnail';

const meta = {
  id: 'fixture.table',
  name: { 'zh-CN': '桌子', en: 'Table' },
  category: 'furniture',
  author: 'test',
  createdAt: '2026-10-16T00:00:00Z',
};
const bboxProvider = () => [-10, -4, -10, 10, 24, 10] as const;
function fixture() {
  const id = createUlidGenerator({ clock: () => 1700000000000, random: () => 0.3 });
  let doc = createDocument({ title: 'original' }, { id });
  const root = doc.models[doc.rootModelId]!;
  const leaf = createModel('桌子', 'submodel', id),
    nested = createModel('nested', 'submodel', id);
  const instance = (model: ModelDef, ref: Instance['ref'], colorId: string, pos: Vec3): Instance => ({
    id: id(),
    ref,
    colorId,
    transform: toLDraw(translation(pos)),
    stepId: model.stepIds[0]!,
    groupId: null,
  });
  const brick = instance(leaf, { kind: 'part', partId: 'ld:3005' }, 'inherit', [0, -24, 0]);
  const other = instance(leaf, { kind: 'part', partId: 'ld:3024' }, 'c:white', [20, -24, 0]);
  const child = instance(nested, { kind: 'model', modelId: leaf.id }, 'inherit', [40, 0, 0]);
  const a = instance(root, { kind: 'model', modelId: nested.id }, 'c:bright-red', [0, 0, 0]);
  const b = instance(root, { kind: 'model', modelId: leaf.id }, 'c:bright-blue', [100, 0, 0]);
  b.transform = toLDraw(multiply(translation([100, 0, 0]), rotationAxisAngle([0, 1, 0], 90)));
  const groupId = id();
  a.groupId = groupId;
  const secondStep = id();
  other.stepId = secondStep;
  doc = applyOps(doc, [
    { type: 'model.add', items: [leaf, nested, createModel('not selected', 'submodel', id)] },
    {
      type: 'step.add',
      items: [{ modelId: leaf.id, step: { id: secondStep, instanceIds: [], description: 'detail' } }],
    },
    { type: 'group.add', items: [{ id: groupId, modelId: root.id, parentGroupId: null, name: 'source group' }] },
    {
      type: 'instance.add',
      items: [
        { modelId: leaf.id, instance: brick },
        { modelId: leaf.id, instance: other },
        { modelId: nested.id, instance: child },
        { modelId: root.id, instance: a },
        { modelId: root.id, instance: b },
      ],
    },
  ]);
  doc.models[leaf.id]!.extensions = { unknown: { preserved: [1, 2] } };
  return { doc, id, a, b, child, brick, other, leaf, nested, paths: [[a.id], [b.id]] };
}
const inventory = (doc: BrkDocument) =>
  expandInstances(doc)
    .map((row) => `${row.partId}/${row.colorId}`)
    .sort();
const packageOf = () => {
  const f = fixture();
  return createMacroFromSelection(f.doc, f.paths, meta, { bboxProvider, id: f.id });
};
function rewrite(bytes: Uint8Array, mutate: (members: Record<string, Uint8Array>) => void, rehash = false) {
  const { members } = readZip(bytes);
  mutate(members);
  if (rehash) {
    const manifest = JSON.parse(text(members['manifest.json']!)) as {
      members: Record<string, { size: number; sha256: string }>;
    };
    manifest.members = Object.fromEntries(
      Object.entries(members)
        .filter(([name]) => name !== 'manifest.json')
        .map(([name, bytes]) => [name, { size: bytes.length, sha256: hashBytes(bytes) }]),
    );
    members['manifest.json'] = utf8(JSON.stringify(manifest));
  }
  return writeZip(members);
}

describe('.brklmacro selection and archive', () => {
  it('round-trips the shared nested closure, groups, internal steps, metadata, extensions and thumbnail', () => {
    const f = fixture(),
      before = serializeDocument(f.doc);
    const pkg = createMacroFromSelection(f.doc, [...f.paths, [f.a.id], [f.a.id, f.child.id, f.brick.id]], meta, {
      bboxProvider,
      id: f.id,
    });
    pkg.thumbnail = emptyThumbnail();
    const result = readMacro(writeMacro(pkg));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.issues).toEqual([]);
    expect(result.value).toEqual(pkg);
    expect(Object.values(pkg.document.models)).toHaveLength(3);
    expect(
      Object.values(pkg.document.models)
        .map((model) => model.stepIds.length)
        .sort(),
    ).toEqual([1, 1, 2]);
    const leaf = Object.values(pkg.document.models).find((model) => model.name === '桌子 (2)')!;
    expect(leaf.extensions).toEqual({ unknown: { preserved: [1, 2] } });
    const references = Object.values(pkg.document.models)
      .flatMap((model) => Object.values(model.instances))
      .filter((instance) => instance.ref.kind === 'model' && instance.ref.modelId === leaf.id);
    expect(references).toHaveLength(2);
    expect(inventory(pkg.document)).toEqual(inventory(f.doc));
    expect(serializeDocument(f.doc)).toBe(before);
    expect(writeMacro(result.value)).toEqual(writeMacro(pkg));
  });
  it('uses the world bbox bottom center snapped to 20/8/20, including rotated corners and inherited colors', () => {
    const f = fixture();
    const pkg = createMacroFromSelection(f.doc, [[f.b.id, f.brick.id]], meta, { bboxProvider });
    expect(pkg.meta.bboxLdu).toEqual([-10, -28, -10, 10, 0, 10]);
    expect(pkg.meta.colorIds).toEqual(['c:bright-blue']);
    expect(pkg.meta.partCount).toBe(1);
    const offGrid = applyOps(f.doc, [
      {
        type: 'instance.update',
        items: [
          {
            modelId: f.doc.rootModelId,
            instanceId: f.b.id,
            changes: { transform: toLDraw(translation([113, 5, -27])) },
          },
        ],
      },
    ]);
    const shifted = createMacroFromSelection(offGrid, [[f.b.id, f.brick.id]], meta, { bboxProvider });
    expect(shifted.meta.bboxLdu).toEqual([-17, -31, -17, 3, -3, 3]);
  });
  it('rejects empty selections, unknown geometry and invalid metadata without modifying the source', () => {
    const f = fixture();
    expect(() => createMacroFromSelection(f.doc, [], meta, { bboxProvider })).toThrow(MacroError);
    expect(() => createMacroFromSelection(f.doc, f.paths, meta, { bboxProvider: () => undefined })).toThrow(
      'MACRO_BOUNDS_MISSING',
    );
    expect(() => createMacroFromSelection(f.doc, f.paths, { ...meta, name: {} }, { bboxProvider })).toThrow(
      'MACRO_INVALID_METADATA',
    );
  });
  it.each([
    ['broken zip', () => new Uint8Array([1, 2, 3]), 'ZIP_INVALID'],
    [
      'hash mismatch',
      (b: Uint8Array) =>
        rewrite(b, (m) => {
          m['macro.json'] = utf8('{}');
        }),
      'MACRO_HASH_MISMATCH',
    ],
    [
      'missing model',
      (b: Uint8Array) =>
        rewrite(b, (m) => {
          delete m['model.json'];
        }),
      'MACRO_MEMBER_MISSING',
    ],
    [
      'unlisted payload',
      (b: Uint8Array) =>
        rewrite(b, (m) => {
          m['extra.json'] = utf8('{}');
        }),
      'MACRO_UNLISTED_MEMBER',
    ],
    [
      'invalid JSON',
      (b: Uint8Array) =>
        rewrite(
          b,
          (m) => {
            m['macro.json'] = utf8('{');
          },
          true,
        ),
      'MACRO_INVALID_JSON',
    ],
    [
      'invalid document',
      (b: Uint8Array) =>
        rewrite(
          b,
          (m) => {
            m['model.json'] = utf8('{}');
          },
          true,
        ),
      'MACRO_INVALID_MODEL',
    ],
    [
      'wrong count',
      (b: Uint8Array) =>
        rewrite(
          b,
          (m) => {
            m['macro.json'] = utf8(JSON.stringify({ ...packageOf().meta, partCount: 100 }));
          },
          true,
        ),
      'MACRO_INVALID_METADATA',
    ],
    [
      'newer version',
      (b: Uint8Array) =>
        rewrite(b, (m) => {
          const v = JSON.parse(text(m['manifest.json']!)) as Record<string, unknown>;
          v.formatVersion = 2;
          m['manifest.json'] = utf8(JSON.stringify(v));
        }),
      'MACRO_UNSUPPORTED_VERSION',
    ],
    [
      'older unsupported version',
      (b: Uint8Array) =>
        rewrite(b, (m) => {
          const v = JSON.parse(text(m['manifest.json']!)) as Record<string, unknown>;
          v.formatVersion = 0;
          m['manifest.json'] = utf8(JSON.stringify(v));
        }),
      'MACRO_UNSUPPORTED_VERSION',
    ],
  ] as const)('returns structured errors for %s', (_label, corrupt, code) => {
    const result = readMacro(corrupt(writeMacro(packageOf())));
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(code);
    expect(result.issues.every((issue) => !!issue.messageKey)).toBe(true);
    expect('value' in result).toBe(false);
  });
});

describe('macro insertion', () => {
  it.each(['group', 'submodel'] as const)(
    'MAC-01 %s insertion preserves inventory, nested sharing, placement and undo/redo in one transaction',
    (as) => {
      const pkg = packageOf(),
        target = createDocument(),
        before = serializeDocument(target);
      const session = new DocumentSession(target);
      const stepId = createUlidGenerator()();
      expect(
        session.applyExternal(
          [{ type: 'step.add', items: [{ modelId: target.rootModelId, step: { id: stepId, instanceIds: [] } }] }],
          'step',
        ).ok,
      ).toBe(true);
      const prior = serializeDocument(session.document);
      const transform = multiply(translation([200, -24, 80]), rotationAxisAngle([0, 1, 0], 90));
      const ops = macroInsertOps(pkg, session.document, { as, stepId, transform: toLDraw(transform) });
      expect(session.applyExternal(ops, 'macro.insert', 'ui').ok).toBe(true);
      expect(inventory(session.document)).toEqual(inventory(pkg.document));
      expect(validateDocument(session.document)).toEqual([]);
      const root = session.document.models[target.rootModelId]!;
      expect(root.steps[stepId]!.instanceIds).toHaveLength(as === 'group' ? 2 : 1);
      expect(root.steps[root.stepIds[0]!]!.instanceIds).toEqual([]);
      const rows = expandInstances(session.document),
        original = expandInstances(pkg.document);
      rows.forEach((row, i) =>
        expect(Array.from(row.worldMatrix)).toEqual(Array.from(multiply(transform, original[i]!.worldMatrix))),
      );
      expect(Object.values(session.document.models)).toHaveLength(as === 'group' ? 3 : 4);
      const inserted = serializeDocument(session.document);
      expect(session.undo().ok).toBe(true);
      expect(serializeDocument(session.document)).toBe(prior);
      expect(session.redo().ok).toBe(true);
      expect(serializeDocument(session.document)).toBe(inserted);
      expect(serializeDocument(target)).toBe(before);
    },
  );
  it('defaults to one enclosing group and keeps nested groups beneath it', () => {
    const doc = applyOps(createDocument(), []),
      pkg = packageOf();
    const added = applyOps(doc, macroInsertOps(pkg, doc));
    const groups = Object.values(added.groups),
      outer = groups.find((group) => group.name === '桌子')!;
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.name === 'source group')!.parentGroupId).toBe(outer.id);
    expect(orderedInstances(added.models[added.rootModelId]!).every((instance) => instance.groupId !== null)).toBe(
      true,
    );
  });
  it('renames colliding definitions on repeated insertion, even into its own source package document', () => {
    const pkg = packageOf();
    let target = pkg.document;
    target = applyOps(target, macroInsertOps(pkg, target, { as: 'submodel' }));
    target = applyOps(target, macroInsertOps(pkg, target, { as: 'submodel' }));
    const names = Object.values(target.models).map((model) => model.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('桌子 (3)');
    expect(validateDocument(target)).toEqual([]);
    expect(expandInstances(target)).toHaveLength(12);
  });
  it('places relative to a nested editing context and leaves the context/package untouched', () => {
    const f = fixture(),
      pkg = packageOf();
    const context = { activeModelPath: [f.a.id], selection: [] };
    const saved = JSON.stringify([context, pkg]);
    const ops = macroInsertOps(pkg, f.doc, { context, transform: toLDraw(translation([0, -40, 0])) });
    const added = applyOps(f.doc, ops);
    expect(validateDocument(added)).toEqual([]);
    expect(JSON.stringify([context, pkg])).toBe(saved);
    expect(orderedInstances(added.models[f.nested.id]!)).toHaveLength(3);
    expect(() => macroInsertOps(pkg, f.doc, { transform: [0] })).toThrow('MACRO_INVALID_PLACEMENT');
    expect(() => macroInsertOps(pkg, f.doc, { stepId: 'missing' })).toThrow();
  });
});

it('availability distinguishes missing/discontinued parts, colors and unavailable combinations with sorted unique results', () => {
  const pack: Pick<Pack, 'parts' | 'colors'> = {
    parts: [
      {
        partId: 'ld:3005',
        legoNo: '3005',
        ldrawFile: '3005.dat',
        factoryNo: 'D1',
        status: 'active',
        colors: ['c:bright-blue'],
      },
    ],
    colors: [
      {
        colorId: 'c:bright-red',
        factoryCode: 'R',
        measuredRgb: '#FF0000',
        definition: {
          id: 'c:bright-red',
          legoName: null,
          legoColorId: null,
          nameZh: '红',
          ldrawCode: 4,
          rgb: '#FF0000',
          edgeRgb: '#000000',
          finish: 'solid',
          alpha: 1,
        },
      },
    ],
  };
  const pkg = packageOf();
  expect(macroAvailability(pkg, pack)).toEqual({
    missingParts: ['ld:3024'],
    missingColors: ['c:bright-blue', 'c:white'],
    unavailableColors: [{ partId: 'ld:3005', colorId: 'c:bright-red' }],
  });
  pack.parts[0]!.status = 'discontinued';
  expect(macroAvailability(pkg, pack).missingParts).toEqual(['ld:3005', 'ld:3024']);
  expect(macroAvailability(pkg, { parts: [], colors: [] }).missingParts).toEqual(['ld:3005', 'ld:3024']);
});
