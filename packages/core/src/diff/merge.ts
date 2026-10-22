import type { BrkDocument, Instance, ModelDef } from '../document';
import { validateDocument } from '../document';
import { attempt, fail } from '../errors';
import type { Result } from '../errors';
import { applyOps } from '../ops';
import type { Op } from '../ops';
import { diffDocuments, instancesEqual } from './index';
import type { InstanceChange } from './index';

type StructureTarget =
  | { field: 'models'; id: string }
  | { field: 'steps'; id: string; modelId: string }
  | { field: 'modelMeta'; id: string }
  | { field: 'stepOrder'; id: string }
  | { field: 'groups' | 'embeddedParts' | 'referenceImages'; id: string }
  | { field: 'meta'; id: string };
export interface MergeConflict {
  key: string;
  kind: 'instance' | 'structure';
  reason: 'both_changed' | 'target_deleted' | 'model_missing' | 'step_missing';
  modelId?: string;
  instanceId?: string;
  base?: Instance;
  ai?: Instance;
  mine?: Instance;
  /** Structural targets retain values, not precomputed operations against a stale document. */
  target?: StructureTarget;
  aiValue?: unknown;
}
export interface MergePlan {
  ops: Op[];
  applied: InstanceChange[];
  conflicts: MergeConflict[];
  renamedModels: { modelId: string; from: string; to: string }[];
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  return (
    Object.keys(x).length === Object.keys(y).length &&
    Object.keys(x).every((key) => Object.hasOwn(y, key) && equal(x[key], y[key]))
  );
}
function omit(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
const modelMeta = (m: ModelDef) => omit(m, ['instances', 'steps', 'stepIds']);
const patch = (before: Record<string, unknown>, after: Record<string, unknown>) => ({
  changes: after,
  unset: Object.keys(before).filter((key) => !Object.hasOwn(after, key)),
});

/** Produce bounded, reversible ops. A model replacement keeps step membership atomic and
 * avoids quadratic instance insertion when thousands of AI additions land in one step. */
function operations(before: BrkDocument, after: BrkDocument): Op[] {
  const ops: Op[] = [];
  const adds: ModelDef[] = [],
    updates: Extract<Op, { type: 'model.update' }>['items'] = [],
    removes: { modelId: string }[] = [];
  for (const id of new Set([...Object.keys(before.models), ...Object.keys(after.models)])) {
    const a = before.models[id],
      b = after.models[id];
    if (a === b) continue;
    if (!b) removes.push({ modelId: id });
    else if (!a) adds.push(b);
    else if (!equal(a, b)) updates.push({ modelId: id, ...patch(a, b) });
  }
  if (adds.length) ops.push({ type: 'model.add', items: adds });
  if (updates.length) ops.push({ type: 'model.update', items: updates });
  if (removes.length) ops.push({ type: 'model.remove', items: removes });
  for (const id of new Set([...Object.keys(before.groups), ...Object.keys(after.groups)])) {
    const a = before.groups[id],
      b = after.groups[id];
    if (equal(a, b)) continue;
    if (!b) ops.push({ type: 'group.remove', items: [{ groupId: id }] });
    else if (!a) ops.push({ type: 'group.add', items: [b] });
    else ops.push({ type: 'group.update', items: [{ groupId: id, ...patch(a, b) }] });
  }
  for (const [field, kind] of [
    ['embeddedParts', 'embeddedPart'],
    ['referenceImages', 'referenceImage'],
  ] as const)
    for (const id of new Set([...Object.keys(before[field]), ...Object.keys(after[field])])) {
      const a = before[field][id],
        b = after[field][id];
      if (equal(a, b)) continue;
      if (a) ops.push({ type: 'asset.remove', items: [{ kind, id }] });
      if (b) ops.push({ type: 'asset.add', items: [{ kind, id, value: b }] });
    }
  if (!equal(before.meta, after.meta)) ops.push({ type: 'meta.update', ...patch(before.meta, after.meta) });
  return ops;
}
function validate(doc: BrkDocument) {
  const issues = validateDocument(doc);
  if (issues.length) fail('INVALID_DOCUMENT', { reason: 'MERGE_DEPENDENCY', issues });
}
function writable(doc: BrkDocument) {
  if (doc.schemaVersion > 1) fail('READ_ONLY_NEWER');
}
function copy(doc: BrkDocument): BrkDocument {
  return {
    ...doc,
    models: { ...doc.models },
    groups: { ...doc.groups },
    embeddedParts: { ...doc.embeddedParts },
    referenceImages: { ...doc.referenceImages },
  };
}
function editModel(doc: BrkDocument, id: string): ModelDef {
  const model = doc.models[id] ?? fail('NOT_FOUND', { reason: 'MODEL_MISSING' });
  return (doc.models[id] = {
    ...model,
    instances: { ...model.instances },
    steps: { ...model.steps },
    stepIds: [...model.stepIds],
  });
}
function setInstance(model: ModelDef, id: string, instance?: Instance) {
  if (instance) model.instances[id] = instance;
  else delete model.instances[id];
}
function membership(model: ModelDef) {
  const remaining = new Map(Object.values(model.instances).map((v) => [v.id, v]));
  for (const step of Object.values(model.steps)) {
    const ids = step.instanceIds.filter((id) => {
      if (remaining.get(id)?.stepId !== step.id) return false;
      remaining.delete(id);
      return true;
    });
    model.steps[step.id] = { ...step, instanceIds: ids };
  }
  for (const instance of remaining.values()) model.steps[instance.stepId]?.instanceIds.push(instance.id);
}

export function planMerge(base: BrkDocument, ai: BrkDocument, mine: BrkDocument): Result<MergePlan> {
  return attempt(() => {
    writable(mine);
    if (base.documentId !== ai.documentId || base.documentId !== mine.documentId) fail('INVALID_ARGUMENT');
    validate(base);
    validate(ai);
    validate(mine);
    const result = copy(mine),
      conflicts: MergeConflict[] = [],
      renamedModels: MergePlan['renamedModels'] = [];
    const choose = (a: unknown, b: unknown, c: unknown, target: StructureTarget): boolean => {
      if (equal(a, b) || equal(b, c)) return false;
      if (equal(a, c)) return true;
      conflicts.push({
        key: `${target.field}/${'modelId' in target ? `${target.modelId}/` : ''}${target.id}`,
        kind: 'structure',
        reason: c === undefined ? 'target_deleted' : 'both_changed',
        target,
        ...(b !== undefined ? { aiValue: b } : {}),
      });
      return false;
    };
    const skipped = new Set<string>();
    const removedSteps: { modelId: string; id: string }[] = [];
    for (const id of new Set([...Object.keys(base.models), ...Object.keys(ai.models)])) {
      const a = base.models[id],
        b = ai.models[id],
        c = mine.models[id];
      if (!a || !b) {
        if (choose(a, b, c, { field: 'models', id })) {
          if (!b) delete result.models[id];
          else {
            let name = b.name;
            while (Object.values(result.models).some((model) => model.name === name)) name += '（AI）';
            if (name !== b.name) renamedModels.push({ modelId: id, from: b.name, to: name });
            result.models[id] = { ...b, name };
          }
        }
        skipped.add(id);
        continue;
      }
      if (!c) {
        if (
          !equal(modelMeta(a), modelMeta(b)) ||
          !equal(a.stepIds, b.stepIds) ||
          Object.keys(a.steps).some(
            (sid) => b.steps[sid] && !equal(omit(a.steps[sid]!, ['instanceIds']), omit(b.steps[sid]!, ['instanceIds'])),
          )
        )
          choose(a, b, undefined, { field: 'models', id });
        continue;
      }
      const model = editModel(result, id);
      if (choose(modelMeta(a), modelMeta(b), modelMeta(c), { field: 'modelMeta', id }))
        result.models[id] = {
          ...modelMeta(b),
          instances: model.instances,
          steps: model.steps,
          stepIds: model.stepIds,
        } as ModelDef;
      for (const sid of new Set([...Object.keys(a.steps), ...Object.keys(b.steps)])) {
        const left = a.steps[sid],
          right = b.steps[sid],
          current = c.steps[sid];
        if (!right) {
          if (left && current) removedSteps.push({ modelId: id, id: sid });
        } else if (
          choose(
            left && omit(left, ['instanceIds']),
            omit(right, ['instanceIds']),
            current && omit(current, ['instanceIds']),
            { field: 'steps', id: sid, modelId: id },
          )
        ) {
          model.steps[sid] = { ...right, instanceIds: current?.instanceIds ?? [] };
          if (!current) model.stepIds.push(sid);
        }
      }
      // Preserve the designer's order unless the AI alone reordered existing steps.
      const common = (ids: string[]) => ids.filter((sid) => a.steps[sid] && b.steps[sid] && c.steps[sid]);
      if (choose(common(a.stepIds), common(b.stepIds), common(c.stepIds), { field: 'stepOrder', id }))
        model.stepIds = [
          ...b.stepIds.filter((sid) => model.steps[sid]),
          ...model.stepIds.filter((sid) => !b.steps[sid]),
        ];
      result.models[id]!.stepIds = model.stepIds;
    }
    for (const change of diffDocuments(base, ai).instances) {
      if (skipped.has(change.modelId)) continue;
      const current = mine.models[change.modelId]?.instances[change.instanceId],
        model = result.models[change.modelId];
      if (instancesEqual(current, change.after)) continue;
      let reason: MergeConflict['reason'] | undefined;
      if (!model) reason = 'model_missing';
      else if (change.after && !model.steps[change.after.stepId]) reason = 'step_missing';
      else if (change.after?.ref.kind === 'model' && !result.models[change.after.ref.modelId]) reason = 'model_missing';
      else if (change.before && !instancesEqual(current, change.before))
        reason = current ? 'both_changed' : 'target_deleted';
      if (reason)
        conflicts.push({
          key: change.key,
          kind: 'instance',
          reason,
          modelId: change.modelId,
          instanceId: change.instanceId,
          ...(change.before ? { base: change.before } : {}),
          ...(change.after ? { ai: change.after } : {}),
          ...(current ? { mine: current } : {}),
        });
      else setInstance(model!, change.instanceId, change.after);
    }
    for (const model of Object.values(result.models))
      if (model !== mine.models[model.id] && !skipped.has(model.id)) membership(model);
    for (const { modelId, id } of removedSteps) {
      const model = result.models[modelId]!,
        current = model.steps[id]!;
      if (
        current.instanceIds.length ||
        !equal(omit(base.models[modelId]!.steps[id]!, ['instanceIds']), omit(current, ['instanceIds']))
      ) {
        conflicts.push({
          key: `steps/${modelId}/${id}`,
          kind: 'structure',
          reason: 'both_changed',
          target: { field: 'steps', modelId, id },
        });
      } else {
        delete model.steps[id];
        model.stepIds = model.stepIds.filter((sid) => sid !== id);
      }
    }
    for (const field of ['groups', 'embeddedParts', 'referenceImages'] as const)
      for (const id of new Set([...Object.keys(base[field]), ...Object.keys(ai[field])]))
        if (choose(base[field][id], ai[field][id], mine[field][id], { field, id })) {
          if (ai[field][id]) Object.assign(result[field], { [id]: ai[field][id] });
          else delete result[field][id];
        }
    if (choose(base.meta, ai.meta, mine.meta, { field: 'meta', id: mine.documentId })) result.meta = ai.meta;
    const ops = operations(mine, result);
    validate(applyOps(mine, ops));
    return { ops, applied: diffDocuments(mine, result).instances, conflicts, renamedModels };
  });
}

/** Resolve against the current document, so intervening edits cannot make stored ops stale. */
export function takeTheirs(mine: BrkDocument, conflict: MergeConflict): Result<Op[]> {
  return attempt(() => {
    writable(mine);
    const result = copy(mine);
    if (conflict.kind === 'instance') {
      const model = editModel(result, conflict.modelId!);
      if (conflict.ai && !model.steps[conflict.ai.stepId]) fail('NOT_FOUND', { reason: 'STEP_MISSING' });
      setInstance(model, conflict.instanceId!, conflict.ai);
      membership(model);
    } else {
      const target = conflict.target ?? fail('INVALID_ARGUMENT'),
        value = conflict.aiValue;
      if (target.field === 'meta') result.meta = value as BrkDocument['meta'];
      else if (target.field === 'modelMeta') {
        const model = editModel(result, target.id);
        result.models[target.id] = {
          ...(value as ModelDef),
          instances: model.instances,
          steps: model.steps,
          stepIds: model.stepIds,
        };
      } else if (target.field === 'stepOrder') {
        const model = editModel(result, target.id),
          order = value as string[];
        model.stepIds = [
          ...order.filter((id) => model.steps[id]),
          ...model.stepIds.filter((id) => !order.includes(id)),
        ];
      } else if (target.field === 'steps') {
        const model = editModel(result, target.modelId);
        if (value) {
          model.steps[target.id] = {
            ...(value as ModelDef['steps'][string]),
            instanceIds: model.steps[target.id]?.instanceIds ?? [],
          };
          if (!model.stepIds.includes(target.id)) model.stepIds.push(target.id);
        } else {
          delete model.steps[target.id];
          model.stepIds = model.stepIds.filter((id) => id !== target.id);
        }
      } else if (value) Object.assign(result[target.field], { [target.id]: value });
      else delete result[target.field][target.id];
    }
    const ops = operations(mine, result);
    validate(applyOps(mine, ops));
    return ops;
  });
}
