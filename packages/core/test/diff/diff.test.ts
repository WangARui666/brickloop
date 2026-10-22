import { describe, expect, it } from 'vitest';
import {
  applyOps,
  changeState,
  createModel,
  diffDocuments,
  DocumentSession,
  revertChanges,
  touchedModelIds,
  ulid,
} from '../../src';
import type { Instance, Op } from '../../src';
import { fixture, unwrap } from '../fixtures';

describe('AI document diff and review transactions', () => {
  it('classifies all fields, including concurrent changes and unknown extension fields', () => {
    const { doc, modelId, instances } = fixture(7);
    const after = structuredClone(doc),
      model = after.models[modelId]!;
    model.instances[instances[0]!.id]!.colorId = 'ld:4';
    model.instances[instances[1]!.id]!.ref = { kind: 'part', partId: 'ld:3003' };
    model.instances[instances[2]!.id]!.transform[0]! += 20;
    model.instances[instances[2]!.id]!.colorId = 'ld:4';
    model.instances[instances[3]!.id]!.stepId = 'next';
    model.instances[instances[4]!.id]!.groupId = 'group';
    model.instances[instances[5]!.id]!.extension = { nested: true };
    delete model.instances[instances[6]!.id];
    const added = { ...instances[0]!, id: ulid() };
    model.instances[added.id] = added;
    const diff = diffDocuments(doc, after);
    expect(diff.instances.map((change) => change.kinds)).toEqual([
      ['recolored'],
      ['replaced'],
      ['recolored', 'moved'],
      ['restepped'],
      ['other'],
      ['other'],
      ['removed'],
      ['added'],
    ]);
    expect(diff.instances[0]!.key).toBe(`${modelId}/${instances[0]!.id}`);
    expect(diff.instances[6]!.beforePosition).toBe(6);
  });

  it('compares model definitions once, limits scope, and reports read-only structural changes', () => {
    const { doc, modelId } = fixture(1);
    const sub = createModel('Repeated'),
      stepId = sub.stepIds[0]!;
    const instance: Instance = {
      id: ulid(),
      ref: { kind: 'part', partId: 'ld:3001' },
      colorId: 'ld:4',
      transform: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      stepId,
      groupId: null,
    };
    sub.instances[instance.id] = instance;
    sub.steps[stepId]!.instanceIds.push(instance.id);
    const before = { ...doc, models: { ...doc.models, [sub.id]: sub } };
    const ops: Op[] = [
      { type: 'instance.update', items: [{ modelId: sub.id, instanceId: instance.id, changes: { colorId: 'ld:1' } }] },
      { type: 'model.update', items: [{ modelId: sub.id, changes: { name: 'Renamed' } }] },
      { type: 'meta.update', changes: { notes: 'AI' } },
    ];
    const after = applyOps(before, ops);
    expect(touchedModelIds(ops)).toEqual(new Set([sub.id]));
    expect(diffDocuments(before, after, { modelIds: [modelId] }).instances).toHaveLength(0);
    const diff = diffDocuments(before, after, { modelIds: touchedModelIds(ops) });
    expect(diff.instances).toHaveLength(1);
    expect(diff.structure).toEqual(
      expect.arrayContaining([
        { kind: 'model.renamed', id: sub.id, name: 'Renamed' },
        { kind: 'meta', id: doc.documentId },
      ]),
    );
    const newer = applyOps(after, [
      { type: 'step.add', items: [{ modelId: sub.id, step: { id: ulid(), instanceIds: [] } }] },
      { type: 'group.add', items: [{ id: ulid(), name: 'Group', modelId: sub.id, parentGroupId: null }] },
      { type: 'asset.add', items: [{ kind: 'referenceImage', id: 'reference', value: { hash: 'hash' } }] },
    ]);
    expect(diffDocuments(after, newer).structure.map((change) => change.kind)).toEqual(
      expect.arrayContaining(['step.added', 'group', 'asset']),
    );
    expect(diffDocuments(newer, doc).structure.map((change) => change.kind)).toEqual(
      expect.arrayContaining(['model.removed', 'step.removed']),
    );
  });

  it('restores deletions in their original step positions and restores additions to their after positions', () => {
    const { doc, modelId, instances } = fixture(6);
    const removed = applyOps(doc, [
      {
        type: 'instance.remove',
        items: [instances[1]!, instances[3]!].map((instance) => ({ modelId, instanceId: instance.id })),
      },
    ]);
    const diff = diffDocuments(doc, removed);
    const restored = applyOps(removed, unwrap(revertChanges(removed, [...diff.instances].reverse(), 'before')));
    expect(restored).toEqual(doc);
    const additions = diffDocuments(removed, doc).instances;
    expect(applyOps(removed, unwrap(revertChanges(removed, additions, 'after')))).toEqual(doc);
    expect(applyOps(doc, unwrap(revertChanges(doc, additions, 'before')))).toEqual(removed);
  });

  it('restores a whole instance including removal of unknown fields and original step', () => {
    const { doc, modelId, instances } = fixture(2),
      stepId = ulid();
    const withStep = applyOps(doc, [{ type: 'step.add', items: [{ modelId, step: { id: stepId, instanceIds: [] } }] }]);
    const after = applyOps(withStep, [
      {
        type: 'instance.update',
        items: [{ modelId, instanceId: instances[0]!.id, changes: { stepId, colorId: 'ld:4', extension: 'new' } }],
      },
    ]);
    const changes = diffDocuments(withStep, after).instances;
    expect(applyOps(after, unwrap(revertChanges(after, changes, 'before')))).toEqual(withStep);
  });

  it('rejects the entire operation if a required step, model or group is missing', () => {
    const { doc, modelId, instances } = fixture(2);
    const changes = diffDocuments(
      doc,
      applyOps(doc, [
        { type: 'instance.remove', items: instances.map((instance) => ({ modelId, instanceId: instance.id })) },
      ]),
    ).instances;
    const current = structuredClone(doc);
    current.models[modelId]!.instances = {};
    current.models[modelId]!.steps = {};
    const result = revertChanges(current, changes, 'before');
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT', details: { reason: 'STEP_MISSING' } },
    });
    delete current.models[modelId];
    expect(revertChanges(current, changes, 'before')).toMatchObject({
      ok: false,
      error: { details: { reason: 'MODEL_MISSING' } },
    });
    expect(doc.models[modelId]!.instances).toHaveProperty(instances[0]!.id);
  });

  it('derives accepted, rejected and superseded states through undo/redo and manual edits', () => {
    const { doc, modelId, instances } = fixture(1),
      session = new DocumentSession(doc);
    unwrap(
      session.applyExternal(
        [{ type: 'instance.update', items: [{ modelId, instanceId: instances[0]!.id, changes: { colorId: 'ld:4' } }] }],
        'AI',
        'ai',
      ),
    );
    const changes = diffDocuments(doc, session.document).instances;
    expect(changeState(session.document, changes[0]!)).toBe('accepted');
    unwrap(session.applyExternal(unwrap(revertChanges(session.document, changes, 'before')), 'Reject', 'ui'));
    expect(changeState(session.document, changes[0]!)).toBe('rejected');
    unwrap(session.undo());
    expect(changeState(session.document, changes[0]!)).toBe('accepted');
    unwrap(session.redo());
    expect(changeState(session.document, changes[0]!)).toBe('rejected');
    unwrap(
      session.applyExternal(
        [{ type: 'instance.update', items: [{ modelId, instanceId: instances[0]!.id, changes: { colorId: 'ld:2' } }] }],
        'Manual',
        'ui',
      ),
    );
    expect(changeState(session.document, changes[0]!)).toBe('superseded');
    expect(revertChanges(session.document, changes, 'before')).toMatchObject({
      ok: false,
      error: { details: { reason: 'SUPERSEDED' } },
    });
  });

  it('uses the same inclusive translation and rotation tolerances for diff and state', () => {
    const { doc, modelId, instances } = fixture(1);
    const edit = (x: number, rotation = 0) =>
      applyOps(doc, [
        {
          type: 'instance.update',
          items: [
            {
              modelId,
              instanceId: instances[0]!.id,
              changes: { transform: [x, 0, 0, 1 + rotation, 0, 0, 0, 1, 0, 0, 0, 1] },
            },
          ],
        },
      ]);
    expect(diffDocuments(doc, edit(0.01, 1e-6)).instances).toHaveLength(0);
    expect(diffDocuments(doc, edit(0.010001)).instances[0]!.kinds).toEqual(['moved']);
    expect(diffDocuments(doc, edit(0, 1.001e-6)).instances[0]!.kinds).toEqual(['moved']);
    const change = diffDocuments(doc, edit(20)).instances[0]!;
    expect(changeState(edit(20.01, 1e-6), change)).toBe('accepted');
    expect(changeState(edit(0.01), change)).toBe('rejected');
    expect(changeState(edit(1), change)).toBe('superseded');
  });

  it('computes 2,000 changes and their states within 200 ms', () => {
    const { doc, modelId, instances } = fixture(2000);
    const after = applyOps(doc, [
      {
        type: 'instance.update',
        items: instances.map((instance) => ({ modelId, instanceId: instance.id, changes: { colorId: 'ld:4' } })),
      },
    ]);
    const start = performance.now();
    const diff = diffDocuments(doc, after, { modelIds: [modelId] });
    const states = diff.instances.map((change) => changeState(after, change));
    const ms = performance.now() - start;
    console.log(`REV-07 core: 2000 diffs + states = ${ms.toFixed(2)} ms`);
    expect(diff.instances).toHaveLength(2000);
    expect(states.every((state) => state === 'accepted')).toBe(true);
    expect(ms).toBeLessThan(200);
  });
});
