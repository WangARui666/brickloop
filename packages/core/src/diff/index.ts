import type { BrkDocument, Instance } from '../document';
import { validateDocument } from '../document';
import { attempt, fail } from '../errors';
import type { Result } from '../errors';
import { applyOps } from '../ops';
import type { InstanceAdd, InstanceTarget, InstanceUpdate, Op } from '../ops';

export type ChangeKind = 'added' | 'removed' | 'recolored' | 'replaced' | 'moved' | 'restepped' | 'other';
export interface InstanceChange {
  key: string;
  modelId: string;
  instanceId: string;
  kinds: ChangeKind[];
  before?: Instance;
  after?: Instance;
  beforePosition?: number;
  /** Also retain the destination slot so restoring a rejected addition preserves order. */
  afterPosition?: number;
}
export type StructureChangeKind =
  'model.added' | 'model.removed' | 'model.renamed' | 'step.added' | 'step.removed' | 'group' | 'asset' | 'meta';
export interface StructureChange {
  kind: StructureChangeKind;
  id: string;
  name?: string;
}
export interface DocumentDiff {
  instances: InstanceChange[];
  structure: StructureChange[];
}
export type ChangeState = 'accepted' | 'rejected' | 'superseded';

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  );
}
function except(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
function exceeds(delta: number, threshold: number): boolean {
  // Accommodate roundoff at an inclusive threshold, without rounding stored transforms.
  return delta > threshold + Number.EPSILON * 8;
}
function kindsBetween(before: Instance, after: Instance): ChangeKind[] {
  if (before === after) return [];
  const kinds: ChangeKind[] = [];
  if (!equal(before.ref, after.ref)) kinds.push('replaced');
  if (before.colorId !== after.colorId) kinds.push('recolored');
  if (
    exceeds(Math.hypot(...before.transform.slice(0, 3).map((v, i) => v - after.transform[i]!)), 0.01) ||
    before.transform.slice(3).some((v, i) => exceeds(Math.abs(v - after.transform[i + 3]!), 1e-6))
  )
    kinds.push('moved');
  if (before.stepId !== after.stepId) kinds.push('restepped');
  if (
    !equal(
      except(before, ['ref', 'colorId', 'transform', 'stepId']),
      except(after, ['ref', 'colorId', 'transform', 'stepId']),
    )
  )
    kinds.push('other');
  return kinds;
}
function sameInstance(a: Instance | undefined, b: Instance | undefined): boolean {
  return a === b || (!!a && !!b && kindsBetween(a, b).length === 0);
}

/** The same tolerances used by review, also used by three-way merge. */
export const instancesEqual = sameInstance;
export { planMerge, takeTheirs } from './merge';
export type { MergeConflict, MergePlan } from './merge';

export function diffDocuments(
  before: BrkDocument,
  after: BrkDocument,
  options?: { modelIds?: Iterable<string> },
): DocumentDiff {
  const instances: InstanceChange[] = [],
    structure: StructureChange[] = [];
  const ids = new Set(options?.modelIds ?? [...Object.keys(before.models), ...Object.keys(after.models)]);
  for (const modelId of ids) {
    const a = before.models[modelId],
      b = after.models[modelId];
    if (a === b) continue;
    if (!a || !b) structure.push({ kind: a ? 'model.removed' : 'model.added', id: modelId, name: (a ?? b)!.name });
    else {
      if (a.name !== b.name) structure.push({ kind: 'model.renamed', id: modelId, name: b.name });
      if (
        !equal(
          except(a, ['name', 'instances', 'steps', 'stepIds']),
          except(b, ['name', 'instances', 'steps', 'stepIds']),
        ) ||
        !equal(a.stepIds, b.stepIds)
      )
        structure.push({ kind: 'meta', id: modelId, name: b.name });
    }
    const positions = (model: typeof a) =>
      new Map(
        Object.values(model?.steps ?? {}).flatMap((step) => step.instanceIds.map((id, index) => [id, index] as const)),
      );
    const beforePositions = positions(a),
      afterPositions = positions(b);
    for (const instanceId of new Set([...Object.keys(a?.instances ?? {}), ...Object.keys(b?.instances ?? {})])) {
      const left = a?.instances[instanceId],
        right = b?.instances[instanceId];
      const kinds: ChangeKind[] = !left ? ['added'] : !right ? ['removed'] : kindsBetween(left, right);
      if (kinds.length)
        instances.push({
          key: `${modelId}/${instanceId}`,
          modelId,
          instanceId,
          kinds,
          ...(left ? { before: left, beforePosition: beforePositions.get(instanceId)! } : {}),
          ...(right ? { after: right, afterPosition: afterPositions.get(instanceId)! } : {}),
        });
    }
    for (const stepId of new Set([...Object.keys(a?.steps ?? {}), ...Object.keys(b?.steps ?? {})])) {
      const left = a?.steps[stepId],
        right = b?.steps[stepId];
      if (!left || !right) structure.push({ kind: left ? 'step.removed' : 'step.added', id: `${modelId}/${stepId}` });
      else if (!equal(except(left, ['instanceIds']), except(right, ['instanceIds'])))
        structure.push({ kind: 'meta', id: `${modelId}/${stepId}` });
    }
  }
  for (const id of new Set([...Object.keys(before.groups), ...Object.keys(after.groups)])) {
    const a = before.groups[id],
      b = after.groups[id];
    if ((ids.has(a?.modelId ?? '') || ids.has(b?.modelId ?? '')) && !equal(a, b))
      structure.push({ kind: 'group', id, name: (b ?? a)!.name });
  }
  for (const field of ['embeddedParts', 'referenceImages'] as const)
    for (const id of new Set([...Object.keys(before[field]), ...Object.keys(after[field])]))
      if (!equal(before[field][id], after[field][id])) structure.push({ kind: 'asset', id: `${field}/${id}` });
  if (
    !equal(
      except(before, ['models', 'groups', 'embeddedParts', 'referenceImages', 'revision']),
      except(after, ['models', 'groups', 'embeddedParts', 'referenceImages', 'revision']),
    )
  )
    structure.push({ kind: 'meta', id: before.documentId });
  return { instances, structure };
}

export function touchedModelIds(ops: readonly Op[]): Set<string> {
  const ids = new Set<string>();
  for (const op of ops) {
    if (op.type === 'meta.update') continue;
    for (const item of op.items) {
      if (op.type === 'model.add') ids.add((item as { id: string }).id);
      else if ('modelId' in item && typeof item.modelId === 'string') ids.add(item.modelId);
      if (
        'changes' in item &&
        item.changes &&
        typeof item.changes === 'object' &&
        'modelId' in item.changes &&
        typeof item.changes.modelId === 'string'
      )
        ids.add(item.changes.modelId);
    }
  }
  return ids;
}

export function changeState(current: BrkDocument, change: InstanceChange): ChangeState {
  const instance = current.models[change.modelId]?.instances[change.instanceId];
  return sameInstance(instance, change.after)
    ? 'accepted'
    : sameInstance(instance, change.before)
      ? 'rejected'
      : 'superseded';
}

export function revertChanges(
  current: BrkDocument,
  changes: readonly InstanceChange[],
  to: 'before' | 'after',
): Result<Op[]> {
  return attempt(() => {
    if (current.schemaVersion > 1) fail('READ_ONLY_NEWER');
    const removes: InstanceTarget[] = [],
      adds: InstanceAdd[] = [],
      updates: InstanceUpdate[] = [];
    const seen = new Set<string>();
    for (const change of changes) {
      if (seen.has(change.key)) continue;
      seen.add(change.key);
      if (changeState(current, change) === 'superseded')
        fail('INVALID_ARGUMENT', { reason: 'SUPERSEDED', key: change.key });
      const model = current.models[change.modelId],
        target = change[to];
      const existing = model?.instances[change.instanceId];
      if (sameInstance(existing, target)) continue;
      if (!model) fail('INVALID_ARGUMENT', { reason: 'MODEL_MISSING', key: change.key });
      if (target) {
        if (!model.steps[target.stepId]) fail('INVALID_ARGUMENT', { reason: 'STEP_MISSING', key: change.key });
        if (target.ref.kind === 'model' && !current.models[target.ref.modelId])
          fail('INVALID_ARGUMENT', { reason: 'MODEL_MISSING', key: change.key });
        if (target.groupId && current.groups[target.groupId]?.modelId !== model.id)
          fail('INVALID_ARGUMENT', { reason: 'GROUP_MISSING', key: change.key });
      }
      if (existing && target && existing.stepId === target.stepId) {
        updates.push({
          modelId: model.id,
          instanceId: existing.id,
          changes: target,
          unset: Object.keys(existing).filter((key) => !Object.hasOwn(target, key)),
        });
      } else {
        if (existing) removes.push({ modelId: model.id, instanceId: existing.id });
        if (target)
          adds.push({
            modelId: model.id,
            instance: target,
            position:
              (to === 'before' ? change.beforePosition : change.afterPosition) ??
              model.steps[target.stepId]!.instanceIds.length,
          });
      }
    }
    const lengths = new Map<string, number>();
    const length = (modelId: string, stepId: string) => {
      const key = `${modelId}/${stepId}`;
      if (!lengths.has(key)) lengths.set(key, current.models[modelId]!.steps[stepId]!.instanceIds.length);
      return key;
    };
    for (const item of removes) {
      const key = length(item.modelId, current.models[item.modelId]!.instances[item.instanceId]!.stepId);
      lengths.set(key, lengths.get(key)! - 1);
    }
    adds.sort((a, b) => a.position! - b.position!);
    for (const item of adds) {
      const key = length(item.modelId, item.instance.stepId);
      item.position = Math.min(item.position!, lengths.get(key)!);
      lengths.set(key, lengths.get(key)! + 1);
    }
    const ops: Op[] = [];
    if (removes.length) ops.push({ type: 'instance.remove', items: removes });
    if (updates.length) ops.push({ type: 'instance.update', items: updates });
    if (adds.length) ops.push({ type: 'instance.add', items: adds });
    const issues = validateDocument(applyOps(current, ops));
    if (issues.length) fail('INVALID_ARGUMENT', { reason: 'DEPENDENCY', issues });
    return ops;
  });
}
