import { describe, expect, it } from 'vitest';
import { applyOps, createModel, planMerge, takeTheirs, ulid, validateDocument, DocumentSession } from '../../src';
import type { BrkDocument, Instance } from '../../src';
import { fixture, unwrap } from '../fixtures';

describe('parallel AI three-way merge', () => {
  const edit = (doc: BrkDocument, modelId: string, instance: Instance, changes: Partial<Instance>) =>
    applyOps(doc, [{ type: 'instance.update', items: [{ modelId, instanceId: instance.id, changes }] }]);
  it('applies untouched instances and additions, preserves designer edits, and ignores identical edits', () => {
    const {
      doc,
      modelId,
      instances: [x, y, z],
    } = fixture(3);
    const ai = edit(edit(doc, modelId, x!, { colorId: 'ld:4' }), modelId, y!, { colorId: 'ld:2' });
    const mine = edit(edit(doc, modelId, x!, { colorId: 'ld:4' }), modelId, z!, { colorId: 'ld:1' });
    const plan = unwrap(planMerge(doc, ai, mine)),
      merged = applyOps(mine, plan.ops);
    expect(plan.conflicts).toEqual([]);
    expect(plan.applied).toHaveLength(1);
    expect(Object.values(merged.models[modelId]!.instances).map((v) => v.colorId)).toEqual(['ld:4', 'ld:2', 'ld:1']);
    expect(doc.models[modelId]!.instances[x!.id]!.colorId).not.toBe('ld:4');
  });
  it('compares whole instances with review tolerances and resolves conflicts as an undoable transaction', () => {
    const {
      doc,
      modelId,
      instances: [x],
    } = fixture(1);
    const ai = edit(doc, modelId, x!, { transform: [20, ...x!.transform.slice(1)] });
    const mine = edit(doc, modelId, x!, { colorId: 'ld:4' });
    const plan = unwrap(planMerge(doc, ai, mine));
    expect(plan.ops).toEqual([]);
    expect(plan.conflicts).toMatchObject([{ kind: 'instance', reason: 'both_changed' }]);
    const session = new DocumentSession(mine);
    unwrap(session.applyExternal(unwrap(takeTheirs(mine, plan.conflicts[0]!)), 'Resolve', 'ui'));
    expect(session.document.models[modelId]!.instances[x!.id]).toEqual(ai.models[modelId]!.instances[x!.id]);
    unwrap(session.undo());
    expect(session.document.models[modelId]!.instances[x!.id]).toEqual(mine.models[modelId]!.instances[x!.id]);
    const near = edit(doc, modelId, x!, { transform: [20.01, ...x!.transform.slice(1)] });
    expect(unwrap(planMerge(doc, ai, near)).conflicts).toEqual([]);
  });
  it('reports deleted targets and restores an AI version when its containing step still exists', () => {
    const {
      doc,
      modelId,
      instances: [x],
    } = fixture(1);
    const ai = edit(doc, modelId, x!, { colorId: 'ld:4' });
    const mine = applyOps(doc, [{ type: 'instance.remove', items: [{ modelId, instanceId: x!.id }] }]);
    const conflict = unwrap(planMerge(doc, ai, mine)).conflicts[0]!;
    expect(conflict.reason).toBe('target_deleted');
    expect(applyOps(mine, unwrap(takeTheirs(mine, conflict))).models[modelId]!.instances[x!.id]).toEqual(
      ai.models[modelId]!.instances[x!.id],
    );
    const deleted = unwrap(planMerge(doc, mine, ai)).conflicts[0]!;
    expect(applyOps(ai, unwrap(takeTheirs(ai, deleted))).models[modelId]!.instances).toEqual({});
  });
  it('adds new submodels and steps, renaming colliding model names', () => {
    const {
      doc,
      modelId,
      instances: [x],
    } = fixture(1);
    const aiSub = createModel('Wing'),
      mySub = createModel('Wing'),
      sid = ulid();
    const ai = applyOps(doc, [
      { type: 'model.add', items: [aiSub] },
      { type: 'step.add', items: [{ modelId, step: { id: sid, instanceIds: [] } }] },
      {
        type: 'instance.add',
        items: [{ modelId, instance: { ...x!, id: ulid(), stepId: sid, ref: { kind: 'model', modelId: aiSub.id } } }],
      },
    ]);
    const mine = applyOps(doc, [{ type: 'model.add', items: [mySub] }]);
    const plan = unwrap(planMerge(doc, ai, mine)),
      merged = applyOps(mine, plan.ops);
    expect(plan.renamedModels).toEqual([{ modelId: aiSub.id, from: 'Wing', to: 'Wing（AI）' }]);
    expect(merged.models[modelId]!.steps[sid]!.instanceIds).toHaveLength(1);
    expect(validateDocument(merged)).toEqual([]);
  });
  it('conflicts on additions into deleted steps or models and refuses invalid resolutions', () => {
    const {
      doc,
      modelId,
      instances: [x],
    } = fixture(1);
    const sub = createModel('Wing');
    const base = applyOps(doc, [{ type: 'model.add', items: [sub] }]);
    const ai = applyOps(base, [
      { type: 'instance.add', items: [{ modelId: sub.id, instance: { ...x!, id: ulid(), stepId: sub.stepIds[0]! } }] },
    ]);
    const mine = applyOps(base, [{ type: 'model.remove', items: [{ modelId: sub.id }] }]);
    const conflict = unwrap(planMerge(base, ai, mine)).conflicts[0]!;
    expect(conflict.reason).toBe('model_missing');
    expect(takeTheirs(mine, conflict).ok).toBe(false);
    const sid = ulid(),
      withStep = applyOps(doc, [{ type: 'step.add', items: [{ modelId, step: { id: sid, instanceIds: [] } }] }]);
    const inStep = applyOps(withStep, [
      { type: 'instance.add', items: [{ modelId, instance: { ...x!, id: ulid(), stepId: sid } }] },
    ]);
    expect(unwrap(planMerge(withStep, inStep, doc)).conflicts[0]!.reason).toBe('step_missing');
  });
  it('merges groups, assets and metadata only when the designer did not change them', () => {
    const { doc, modelId } = fixture(0),
      id = ulid();
    const base = applyOps(doc, [{ type: 'group.add', items: [{ id, name: 'Base', modelId, parentGroupId: null }] }]);
    const ai = applyOps(base, [
      { type: 'group.update', items: [{ groupId: id, changes: { name: 'AI' } }] },
      { type: 'asset.add', items: [{ kind: 'referenceImage', id: ulid(), value: { hash: 'hash' } }] },
      { type: 'meta.update', changes: { notes: 'AI' } },
    ]);
    const mine = applyOps(base, [
      { type: 'group.update', items: [{ groupId: id, changes: { name: 'Mine' } }] },
      { type: 'meta.update', changes: { notes: 'Mine' } },
    ]);
    const plan = unwrap(planMerge(base, ai, mine)),
      merged = applyOps(mine, plan.ops);
    expect(plan.conflicts).toHaveLength(2);
    expect(merged.groups[id]!.name).toBe('Mine');
    expect(Object.keys(merged.referenceImages)).toHaveLength(1);
    for (const conflict of plan.conflicts) expect(takeTheirs(merged, conflict).ok).toBe(true);
    expect(unwrap(planMerge(base, ai, base)).conflicts).toEqual([]);
  });
  it('never returns a plan with dangling dependencies or modifies its inputs', () => {
    const {
      doc,
      modelId,
      instances: [x],
    } = fixture(1);
    const sub = createModel('Wing');
    const base = applyOps(doc, [{ type: 'model.add', items: [sub] }]);
    const ai = applyOps(base, [{ type: 'model.remove', items: [{ modelId: sub.id }] }]);
    const mine = edit(base, modelId, x!, { ref: { kind: 'model', modelId: sub.id } });
    const saved = structuredClone([base, ai, mine]);
    expect(planMerge(base, ai, mine).ok).toBe(false);
    expect([base, ai, mine]).toEqual(saved);
  });
  it('applies an AI addition even when the designer added the same instance ID', () => {
    const {
      doc,
      modelId,
      instances: [x],
    } = fixture(1);
    const empty = applyOps(doc, [{ type: 'instance.remove', items: [{ modelId, instanceId: x!.id }] }]);
    const mine = edit(doc, modelId, x!, { colorId: 'ld:4' });
    const merged = unwrap(planMerge(empty, doc, mine));
    expect(merged.conflicts).toEqual([]);
    expect(applyOps(mine, merged.ops).models[modelId]!.instances[x!.id]).toEqual(x);
  });
  it('merges step metadata/deletions and reports concurrent reordering', () => {
    const { doc, modelId } = fixture(0),
      first = doc.models[modelId]!.stepIds[0]!,
      second = ulid(),
      third = ulid();
    const base = applyOps(doc, [
      { type: 'step.add', items: [second, third].map((id) => ({ modelId, step: { id, instanceIds: [] } })) },
    ]);
    const ai = applyOps(base, [
      { type: 'step.update', items: [{ modelId, stepId: second, changes: { description: 'AI' } }] },
      { type: 'model.update', items: [{ modelId, changes: { stepIds: [second, first, third] } }] },
    ]);
    const mine = applyOps(base, [
      { type: 'model.update', items: [{ modelId, changes: { stepIds: [first, third, second] } }] },
    ]);
    const plan = unwrap(planMerge(base, ai, mine)),
      merged = applyOps(mine, plan.ops);
    expect(merged.models[modelId]!.steps[second]!.description).toBe('AI');
    expect(plan.conflicts).toHaveLength(1);
    expect(applyOps(merged, unwrap(takeTheirs(merged, plan.conflicts[0]!))).models[modelId]!.stepIds).toEqual([
      second,
      first,
      third,
    ]);
    const removed = applyOps(base, [{ type: 'step.remove', items: [{ modelId, stepId: second }] }]);
    expect(applyOps(base, unwrap(planMerge(base, removed, base)).ops).models[modelId]!.steps[second]).toBeUndefined();
  });
  it('restores a renamed model deleted by the designer using a validated structural resolution', () => {
    const { doc } = fixture(0),
      sub = createModel('Wing');
    const base = applyOps(doc, [{ type: 'model.add', items: [sub] }]);
    const ai = applyOps(base, [{ type: 'model.update', items: [{ modelId: sub.id, changes: { name: 'AI wing' } }] }]);
    const conflict = unwrap(planMerge(base, ai, doc)).conflicts[0]!;
    const restored = applyOps(doc, unwrap(takeTheirs(doc, conflict)));
    expect(restored.models[sub.id]!.name).toBe('AI wing');
    expect(validateDocument(restored)).toEqual([]);
  });
  it('merges 2,000 additions and reports elapsed time', () => {
    const { doc, modelId, instances } = fixture(2000);
    const empty = applyOps(doc, [
      { type: 'instance.remove', items: instances.map((v) => ({ modelId, instanceId: v.id })) },
    ]);
    const start = performance.now(),
      plan = unwrap(planMerge(empty, doc, empty));
    const elapsed = performance.now() - start;
    console.info(`planMerge 2,000 additions: ${elapsed.toFixed(1)} ms`);
    expect(plan.applied).toHaveLength(2000);
    expect(elapsed).toBeLessThan(200);
    expect(validateDocument(applyOps(empty, plan.ops))).toEqual([]);
  });
});
