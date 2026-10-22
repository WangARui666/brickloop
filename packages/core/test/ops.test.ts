import { describe, expect, it } from 'vitest';
import { apply, applyOps, applyWithInverse, createModel, invertOp, serializeDocument, validateDocument } from '../src';
import type { Op } from '../src';
import { fixture, instance } from './fixtures';

describe('reversible batch primitives', () => {
  it('covers every primitive, including absent optional and unknown fields', () => {
    const f = fixture(3),
      sid = f.id(),
      gid = f.id(),
      other = createModel('other', 'submodel', f.id);
    const add = instance(f.id, f.doc.models[f.modelId]!);
    const operations: Op[] = [
      { type: 'model.add', items: [other] },
      {
        type: 'model.update',
        items: [{ modelId: other.id, changes: { name: 'renamed', importedMetadata: { unknown: 42 } } }],
      },
      { type: 'step.add', items: [{ modelId: f.modelId, step: { id: sid, instanceIds: [] }, position: 0 }] },
      {
        type: 'step.update',
        items: [{ modelId: f.modelId, stepId: sid, changes: { description: 'new', future: ['kept'] } }],
      },
      { type: 'group.add', items: [{ id: gid, name: 'group', modelId: f.modelId, parentGroupId: null }] },
      { type: 'group.update', items: [{ groupId: gid, changes: { name: 'changed' } }] },
      { type: 'instance.add', items: [{ modelId: f.modelId, instance: add, position: 1 }] },
      {
        type: 'instance.update',
        items: [
          {
            modelId: f.modelId,
            instanceId: add.id,
            changes: { groupId: gid, colorId: 'c:blue', future: { x: 2 }, stepId: sid },
          },
        ],
      },
      {
        type: 'asset.add',
        items: [
          { kind: 'embeddedPart', id: 'cu:test', value: { hash: 'hash1', data: 'opaque' } },
          { kind: 'referenceImage', id: f.id(), value: { hash: 'hash2', opacity: 0.5 } },
        ],
      },
      { type: 'meta.update', changes: { title: 'changed', future: [1, 2] } },
      { type: 'meta.update', changes: {}, unset: ['future'] },
      { type: 'instance.remove', items: [{ modelId: f.modelId, instanceId: add.id }] },
      { type: 'group.remove', items: [{ groupId: gid }] },
      { type: 'step.remove', items: [{ modelId: f.modelId, stepId: sid }] },
      { type: 'model.remove', items: [{ modelId: other.id }] },
      { type: 'asset.remove', items: [{ kind: 'embeddedPart', id: 'cu:test' }] },
    ];
    let doc = f.doc;
    for (const op of operations) {
      const snapshot = serializeDocument(doc),
        inverse = invertOp(op, doc),
        next = apply(doc, op);
      expect(serializeDocument(doc)).toBe(snapshot);
      expect(apply(next, inverse)).toEqual(doc);
      expect(serializeDocument(apply(next, inverse))).toBe(snapshot);
      doc = next;
    }
    const applied = applyWithInverse(f.doc, operations);
    expect(applyOps(applied.doc, applied.inverse)).toEqual(f.doc);
    expect(validateDocument(applied.doc)).toEqual([]);
  });
  it('restores non-contiguous removals and multi-step assignments in original order', () => {
    const f = fixture(6),
      sid = f.id();
    const doc = apply(f.doc, { type: 'step.add', items: [{ modelId: f.modelId, step: { id: sid, instanceIds: [] } }] });
    const operations: Op[] = [
      {
        type: 'instance.update',
        items: [4, 1, 3].map((i) => ({ modelId: f.modelId, instanceId: f.instances[i]!.id, changes: { stepId: sid } })),
      },
      {
        type: 'instance.remove',
        items: [0, 2, 5].map((i) => ({ modelId: f.modelId, instanceId: f.instances[i]!.id })),
      },
    ];
    const result = applyWithInverse(doc, operations);
    expect(applyOps(result.doc, result.inverse)).toEqual(doc);
  });
  it('shares untouched models, steps, instances, assets and extensions', () => {
    const f = fixture(3),
      other = createModel('other', 'submodel', f.id);
    const doc = apply(f.doc, { type: 'model.add', items: [other] });
    const next = apply(doc, {
      type: 'instance.update',
      items: [
        { modelId: f.modelId, instanceId: f.instances[0]!.id, changes: { colorId: 'c:blue' } },
        { modelId: f.modelId, instanceId: f.instances[1]!.id, changes: { colorId: 'c:yellow' } },
      ],
    });
    expect(next).not.toBe(doc);
    expect(next.models[f.modelId]).not.toBe(doc.models[f.modelId]);
    expect(next.models[other.id]).toBe(other);
    expect(next.models[f.modelId]!.steps).toBe(doc.models[f.modelId]!.steps);
    expect(next.models[f.modelId]!.instances[f.instances[2]!.id]).toBe(f.instances[2]);
    expect(next.embeddedParts).toBe(doc.embeddedParts);
    expect(next.extensions).toBe(doc.extensions);
  });
  it('does not partially mutate the document on an invalid batch', () => {
    const f = fixture(2),
      snapshot = serializeDocument(f.doc);
    expect(() =>
      apply(f.doc, {
        type: 'instance.remove',
        items: [
          { modelId: f.modelId, instanceId: f.instances[0]!.id },
          { modelId: f.modelId, instanceId: f.id() },
        ],
      }),
    ).toThrow();
    expect(serializeDocument(f.doc)).toBe(snapshot);
  });
});
