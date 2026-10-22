import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createModel,
  createUlidGenerator,
  isUlid,
  validateDocument,
  wouldCreateCycle,
  resolvePath,
  worldMatrix,
  expandInstances,
  applyOps,
} from '../src';
import type { BrkDocument } from '../src';
import { fixture, pairFixture, unitTransform } from './fixtures';

describe('identity and document invariants', () => {
  it('creates a main model with one empty ordered step and valid metadata', () => {
    const doc = createDocument({ title: '新工程' });
    expect(validateDocument(doc)).toEqual([]);
    expect(doc.models[doc.rootModelId]!.stepIds).toHaveLength(1);
    expect(Object.keys(doc.models[doc.rootModelId]!.instances)).toHaveLength(0);
  });
  it('generates injectable monotonic ULIDs even when the clock moves backwards', () => {
    let time = 100;
    const id = createUlidGenerator({ clock: () => time, random: () => 0 });
    const a = id(),
      b = id();
    time = 99;
    const c = id();
    time = 101;
    const d = id();
    expect(a).toBe('00000000340000000000000000');
    expect([a, b, c, d].every(isUlid)).toBe(true);
    expect([a, b, c, d]).toEqual([a, b, c, d].sort());
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(() => createUlidGenerator({ random: () => 1 })()).toThrow();
  });
  const cases: [string, string, (doc: BrkDocument, id: () => string) => void][] = [
    [
      'instance absent from all steps',
      'STEP_MEMBERSHIP',
      (doc) => {
        const m = doc.models[doc.rootModelId]!;
        m.steps[m.stepIds[0]!]!.instanceIds = [];
      },
    ],
    [
      'instance in two steps',
      'STEP_MEMBERSHIP',
      (doc, id) => {
        const m = doc.models[doc.rootModelId]!,
          sid = id();
        m.stepIds.push(sid);
        m.steps[sid] = { id: sid, instanceIds: [...m.steps[m.stepIds[0]!]!.instanceIds] };
      },
    ],
    [
      'stepId disagrees with membership',
      'STEP_MEMBERSHIP',
      (doc, id) => {
        Object.values(doc.models[doc.rootModelId]!.instances)[0]!.stepId = id();
      },
    ],
    [
      'dangling step member',
      'STEP_MEMBERSHIP',
      (doc, id) => {
        const m = doc.models[doc.rootModelId]!;
        m.steps[m.stepIds[0]!]!.instanceIds.push(id());
      },
    ],
    [
      'self reference cycle',
      'CYCLE',
      (doc) => {
        Object.values(doc.models[doc.rootModelId]!.instances)[0]!.ref = { kind: 'model', modelId: doc.rootModelId };
      },
    ],
    [
      'foreign group',
      'GROUP_MODEL',
      (doc, id) => {
        const m = doc.models[doc.rootModelId]!,
          gid = id(),
          foreign = createModel('other', 'submodel', id);
        doc.models[foreign.id] = foreign;
        doc.groups[gid] = { id: gid, name: '', modelId: foreign.id, parentGroupId: null };
        Object.values(m.instances)[0]!.groupId = gid;
      },
    ],
    [
      'foreign parent group',
      'GROUP_MODEL',
      (doc, id) => {
        const foreign = createModel('other', 'submodel', id);
        doc.models[foreign.id] = foreign;
        const a = id(),
          b = id();
        doc.groups[a] = { id: a, name: '', modelId: doc.rootModelId, parentGroupId: b };
        doc.groups[b] = { id: b, name: '', modelId: foreign.id, parentGroupId: null };
      },
    ],
    [
      'group nesting cycle',
      'GROUP_CYCLE',
      (doc, id) => {
        const gid = id();
        doc.groups[gid] = { id: gid, modelId: doc.rootModelId, name: '', parentGroupId: gid };
      },
    ],
    [
      'root missing',
      'ROOT_MODEL',
      (doc, id) => {
        doc.rootModelId = id();
      },
    ],
    [
      'root not main',
      'ROOT_MODEL',
      (doc) => {
        doc.models[doc.rootModelId]!.kind = 'submodel';
      },
    ],
    [
      'dangling model reference',
      'MODEL_REFERENCE',
      (doc, id) => {
        Object.values(doc.models[doc.rootModelId]!.instances)[0]!.ref = { kind: 'model', modelId: id() };
      },
    ],
    [
      'steps not ordered exactly once',
      'STEP_ORDER',
      (doc) => {
        const m = doc.models[doc.rootModelId]!;
        m.stepIds.push(m.stepIds[0]!);
      },
    ],
    [
      'duplicate identifiers',
      'DUPLICATE_ID',
      (doc) => {
        doc.documentId = doc.rootModelId;
      },
    ],
    [
      'invalid matrix',
      'STRUCTURE',
      (doc) => {
        Object.values(doc.models[doc.rootModelId]!.instances)[0]!.transform[1] = NaN;
      },
    ],
    [
      'key mismatch',
      'KEY_MISMATCH',
      (doc, id) => {
        Object.values(doc.models[doc.rootModelId]!.instances)[0]!.id = id();
      },
    ],
  ];
  it.each(cases)('rejects %s', (_name, code, mutate) => {
    const { doc, id } = fixture(1);
    mutate(doc, id);
    expect(validateDocument(doc).some((issue) => issue.code === code)).toBe(true);
  });
  it('keeps unknown catalog PartId and ColorId valid (invariant 5)', () => {
    const { doc } = fixture(1),
      instance = Object.values(doc.models[doc.rootModelId]!.instances)[0]!;
    instance.ref = { kind: 'part', partId: 'cu:unknown-catalog-entry' };
    instance.colorId = 'cx:unknown-color';
    expect(validateDocument(doc)).toEqual([]);
  });
  it.each([null, [], {}, { models: null }, { schemaVersion: '1' }])(
    'reports malformed runtime input without throwing: %j',
    (value) => {
      expect(validateDocument(value).length).toBeGreaterThan(0);
    },
  );
});

describe('paths and shared definitions', () => {
  it('MOD-01 expands four occurrences in step order and composes matrices along paths', () => {
    const f = pairFixture(),
      rows = expandInstances(f.doc);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.path)).toEqual([
      [f.first.id, f.red.id],
      [f.first.id, f.yellow.id],
      [f.second.id, f.red.id],
      [f.second.id, f.yellow.id],
    ]);
    expect(rows[3]!.worldMatrix[12]).toBeCloseTo(100, 12);
    expect(rows[3]!.worldMatrix[14]).toBeCloseTo(10, 12);
    expect(rows.map((row) => row.definitionMultiplicity)).toEqual([2, 2, 2, 2]);
    expect(rows.reduce((sum, row) => sum + row.multiplicity, 0)).toBe(4);
    expect(worldMatrix(f.doc, rows[3]!.path)).toEqual(rows[3]!.worldMatrix);
    expect(resolvePath(f.doc, [f.first.id, f.yellow.id])!.model.id).toBe(f.pair.id);
    expect(resolvePath(f.doc, [f.red.id])).toBeUndefined();
    expect(worldMatrix(f.doc, [])).toEqual(new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  });
  it('resolves inherit through nested references, with a deterministic root fallback', () => {
    const f = pairFixture();
    const doc = applyOps(f.doc, [
      {
        type: 'instance.update',
        items: [
          { modelId: f.pair.id, instanceId: f.yellow.id, changes: { colorId: 'inherit' } },
          { modelId: f.modelId, instanceId: f.second.id, changes: { colorId: 'c:blue' } },
        ],
      },
    ]);
    expect(expandInstances(doc).map((row) => row.colorId)).toEqual([
      'c:bright-red',
      'c:bright-red',
      'c:bright-red',
      'c:blue',
    ]);
    expect(expandInstances(doc, f.pair.id)[1]!.colorId).toBe('ld:16');
  });
  it('detects transitive cycles and bounds expansion of a bad file', () => {
    const f = pairFixture();
    expect(wouldCreateCycle(f.doc, f.pair.id, f.modelId)).toBe(true);
    expect(wouldCreateCycle(f.doc, f.modelId, f.pair.id)).toBe(false);
    const doc = applyOps(f.doc, [
      {
        type: 'instance.add',
        items: [
          {
            modelId: f.pair.id,
            instance: {
              id: f.id(),
              ref: { kind: 'model', modelId: f.modelId },
              transform: unitTransform,
              colorId: 'inherit',
              groupId: null,
              stepId: f.pair.stepIds[0]!,
            },
          },
        ],
      },
    ]);
    expect(validateDocument(doc).some((issue) => issue.code === 'CYCLE')).toBe(true);
    expect(() => expandInstances(doc)).toThrow('Cyclic');
  });
});
