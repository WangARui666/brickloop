import { fail } from '../errors';
import type {
  BrkDocument,
  DocumentMeta,
  EmbeddedPartRef,
  Group,
  Instance,
  ModelDef,
  RefImage,
  Step,
  UnknownFields,
} from '../document';

export interface Patch<T> {
  changes: Partial<T>;
  unset?: string[];
}
export interface InstanceAdd {
  modelId: string;
  instance: Instance;
  stepId?: string;
  position?: number;
}
export interface InstanceTarget {
  modelId: string;
  instanceId: string;
}
export interface InstanceUpdate extends InstanceTarget, Patch<Instance> {
  position?: number;
}
export interface StepTarget {
  modelId: string;
  stepId: string;
}
export type Op =
  | { type: 'instance.add'; items: InstanceAdd[] }
  | { type: 'instance.remove'; items: InstanceTarget[] }
  | { type: 'instance.update'; items: InstanceUpdate[] }
  | { type: 'model.add'; items: ModelDef[] }
  | { type: 'model.remove'; items: { modelId: string }[] }
  | { type: 'model.update'; items: ({ modelId: string } & Patch<ModelDef>)[] }
  | { type: 'step.add'; items: { modelId: string; step: Step; position?: number }[] }
  | { type: 'step.remove'; items: StepTarget[] }
  | { type: 'step.update'; items: (StepTarget & Patch<Step>)[] }
  | { type: 'group.add'; items: Group[] }
  | { type: 'group.remove'; items: { groupId: string }[] }
  | { type: 'group.update'; items: ({ groupId: string } & Patch<Group>)[] }
  | { type: 'asset.add'; items: AssetEntry[] }
  | { type: 'asset.remove'; items: AssetTarget[] }
  | ({ type: 'meta.update' } & Patch<DocumentMeta>);
export type AssetTarget = { kind: 'embeddedPart' | 'referenceImage'; id: string };
export type AssetEntry =
  | { kind: 'embeddedPart'; id: string; value: EmbeddedPartRef }
  | { kind: 'referenceImage'; id: string; value: RefImage };

export function requireValue<T>(value: T | undefined): T {
  return value ?? fail('NOT_FOUND');
}
function patch<T extends UnknownFields>(before: T, update: Patch<T>): T {
  if (('id' in update.changes && update.changes.id !== before.id) || update.unset?.includes('id'))
    fail('INVALID_ARGUMENT', 'id');
  const after = { ...before, ...update.changes };
  for (const key of update.unset ?? []) delete after[key];
  return after;
}
function reversePatch<T extends UnknownFields>(before: T, update: Patch<T>): Patch<T> {
  const changes: Record<string, unknown> = {},
    unset: string[] = [];
  for (const key of new Set([...Object.keys(update.changes), ...(update.unset ?? [])])) {
    if (Object.hasOwn(before, key)) changes[key] = before[key];
    else unset.push(key);
  }
  return { changes: changes as Partial<T>, ...(unset.length ? { unset } : {}) };
}
function insert(list: readonly string[], id: string, position = list.length): string[] {
  if (!Number.isInteger(position) || position < 0 || position > list.length) fail('INVALID_ARGUMENT', 'position');
  return [...list.slice(0, position), id, ...list.slice(position)];
}
function absent<T>(map: Record<string, T>, id: string): void {
  if (Object.hasOwn(map, id)) fail('INVALID_ARGUMENT', `Duplicate ID: ${id}`);
}

/** Applies a primitive without mutating its input. Validate at the transaction boundary,
 * since compound commands may temporarily detach members while moving definitions. */
export function apply(doc: BrkDocument, op: Op): BrkDocument {
  let models = doc.models;
  const changed = new Map<string, ModelDef>();
  const edit = (id: string): ModelDef => {
    let model = changed.get(id);
    if (!model) {
      model = { ...requireValue(models[id]) };
      changed.set(id, model);
      if (models === doc.models) models = { ...models };
      models[id] = model;
    }
    return model;
  };
  const instances = (id: string): ModelDef => {
    const model = edit(id);
    if (model.instances === doc.models[id]!.instances) model.instances = { ...model.instances };
    return model;
  };
  const steps = (id: string): ModelDef => {
    const model = edit(id);
    if (model.steps === doc.models[id]!.steps) model.steps = { ...model.steps };
    return model;
  };
  const changeMembers = (modelId: string, stepId: string, action: (ids: string[]) => string[]) => {
    const model = steps(modelId),
      step = requireValue(model.steps[stepId]);
    model.steps[stepId] = { ...step, instanceIds: action(step.instanceIds) };
  };
  switch (op.type) {
    case 'instance.add':
      for (const item of op.items) {
        const model = instances(item.modelId),
          instance = item.instance;
        absent(model.instances, instance.id);
        if (item.stepId !== undefined && item.stepId !== instance.stepId) fail('INVALID_ARGUMENT', 'stepId');
        model.instances[instance.id] = instance;
        changeMembers(item.modelId, instance.stepId, (ids) => insert(ids, instance.id, item.position));
      }
      break;
    case 'instance.remove': {
      const removals = new Map<string, Map<string, Set<string>>>();
      for (const item of op.items) {
        const model = instances(item.modelId),
          instance = requireValue(model.instances[item.instanceId]);
        delete model.instances[item.instanceId];
        const byStep = removals.get(item.modelId) ?? new Map<string, Set<string>>();
        removals.set(item.modelId, byStep);
        const ids = byStep.get(instance.stepId) ?? new Set<string>();
        byStep.set(instance.stepId, ids);
        ids.add(instance.id);
      }
      for (const [modelId, byStep] of removals)
        for (const [stepId, ids] of byStep)
          changeMembers(modelId, stepId, (members) => members.filter((id) => !ids.has(id)));
      break;
    }
    case 'instance.update': {
      const movements: { modelId: string; instance: Instance; position?: number }[] = [];
      const removed = new Map<string, Map<string, Set<string>>>();
      const targets = new Set<string>();
      for (const item of op.items) {
        const key = item.modelId + '/' + item.instanceId;
        if (targets.has(key)) fail('INVALID_ARGUMENT', 'Duplicate update target');
        targets.add(key);
        const model = instances(item.modelId),
          before = requireValue(model.instances[item.instanceId]),
          after = patch(before, item);
        model.instances[item.instanceId] = after;
        if (before.stepId !== after.stepId || item.position !== undefined) {
          requireValue(model.steps[after.stepId]);
          const byStep = removed.get(item.modelId) ?? new Map<string, Set<string>>();
          removed.set(item.modelId, byStep);
          const ids = byStep.get(before.stepId) ?? new Set<string>();
          byStep.set(before.stepId, ids);
          ids.add(before.id);
          movements.push({
            modelId: item.modelId,
            instance: after,
            ...(item.position === undefined ? {} : { position: item.position }),
          });
        }
      }
      for (const [modelId, byStep] of removed)
        for (const [stepId, ids] of byStep)
          changeMembers(modelId, stepId, (members) => members.filter((id) => !ids.has(id)));
      movements.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
      for (const item of movements)
        changeMembers(item.modelId, item.instance.stepId, (ids) => insert(ids, item.instance.id, item.position));
      break;
    }
    case 'model.add':
      models = { ...models };
      for (const model of op.items) {
        absent(models, model.id);
        models[model.id] = model;
      }
      break;
    case 'model.remove':
      models = { ...models };
      for (const item of op.items) {
        requireValue(models[item.modelId]);
        delete models[item.modelId];
      }
      break;
    case 'model.update':
      models = { ...models };
      for (const item of op.items) models[item.modelId] = patch(requireValue(models[item.modelId]), item);
      break;
    case 'step.add':
      for (const item of op.items) {
        const model = steps(item.modelId);
        absent(model.steps, item.step.id);
        model.steps[item.step.id] = item.step;
        model.stepIds = insert(model.stepIds, item.step.id, item.position);
      }
      break;
    case 'step.remove':
      for (const item of op.items) {
        const model = steps(item.modelId);
        requireValue(model.steps[item.stepId]);
        delete model.steps[item.stepId];
        model.stepIds = model.stepIds.filter((id) => id !== item.stepId);
      }
      break;
    case 'step.update':
      for (const item of op.items) {
        const model = steps(item.modelId);
        model.steps[item.stepId] = patch(requireValue(model.steps[item.stepId]), item);
      }
      break;
    case 'group.add': {
      const groups = { ...doc.groups };
      for (const group of op.items) {
        absent(groups, group.id);
        groups[group.id] = group;
      }
      return { ...doc, groups };
    }
    case 'group.remove': {
      const groups = { ...doc.groups };
      for (const item of op.items) {
        requireValue(groups[item.groupId]);
        delete groups[item.groupId];
      }
      return { ...doc, groups };
    }
    case 'group.update': {
      const groups = { ...doc.groups };
      for (const item of op.items) groups[item.groupId] = patch(requireValue(groups[item.groupId]), item);
      return { ...doc, groups };
    }
    case 'asset.add':
    case 'asset.remove': {
      let embeddedParts = doc.embeddedParts,
        referenceImages = doc.referenceImages;
      for (const item of op.items) {
        if (item.kind === 'embeddedPart') {
          if (embeddedParts === doc.embeddedParts) embeddedParts = { ...embeddedParts };
        } else if (referenceImages === doc.referenceImages) referenceImages = { ...referenceImages };
        const map = item.kind === 'embeddedPart' ? embeddedParts : referenceImages;
        if ('value' in item) {
          absent(map, item.id);
          map[item.id] = item.value;
        } else {
          requireValue(map[item.id]);
          delete map[item.id];
        }
      }
      return { ...doc, embeddedParts, referenceImages };
    }
    case 'meta.update':
      return { ...doc, meta: patch(doc.meta, op) };
  }
  return models === doc.models ? doc : { ...doc, models };
}

export function invert(op: Op, docBefore: BrkDocument): Op {
  const model = (id: string) => requireValue(docBefore.models[id]);
  switch (op.type) {
    case 'instance.add':
      return {
        type: 'instance.remove',
        items: op.items.map((item) => ({ modelId: item.modelId, instanceId: item.instance.id })),
      };
    case 'instance.remove':
      return {
        type: 'instance.add',
        items: op.items
          .map((item) => {
            const parent = model(item.modelId),
              instance = requireValue(parent.instances[item.instanceId]);
            return {
              modelId: parent.id,
              instance,
              stepId: instance.stepId,
              position: requireValue(parent.steps[instance.stepId]).instanceIds.indexOf(instance.id),
            };
          })
          .sort((a, b) => a.position - b.position),
      };
    case 'instance.update':
      return {
        type: 'instance.update',
        items: op.items.map((item) => {
          const parent = model(item.modelId),
            before = requireValue(parent.instances[item.instanceId]);
          const moved =
            (item.changes.stepId !== undefined && item.changes.stepId !== before.stepId) || item.position !== undefined;
          return {
            modelId: item.modelId,
            instanceId: item.instanceId,
            ...reversePatch(before, item),
            ...(moved ? { position: parent.steps[before.stepId]!.instanceIds.indexOf(before.id) } : {}),
          };
        }),
      };
    case 'model.add':
      return { type: 'model.remove', items: op.items.map((m) => ({ modelId: m.id })) };
    case 'model.remove':
      return { type: 'model.add', items: op.items.map((item) => model(item.modelId)) };
    case 'model.update':
      return {
        type: 'model.update',
        items: op.items.map((item) => ({ modelId: item.modelId, ...reversePatch(model(item.modelId), item) })),
      };
    case 'step.add':
      return { type: 'step.remove', items: op.items.map((item) => ({ modelId: item.modelId, stepId: item.step.id })) };
    case 'step.remove':
      return {
        type: 'step.add',
        items: op.items
          .map((item) => ({
            modelId: item.modelId,
            step: requireValue(model(item.modelId).steps[item.stepId]),
            position: model(item.modelId).stepIds.indexOf(item.stepId),
          }))
          .sort((a, b) => a.position - b.position),
      };
    case 'step.update':
      return {
        type: 'step.update',
        items: op.items.map((item) => ({
          modelId: item.modelId,
          stepId: item.stepId,
          ...reversePatch(requireValue(model(item.modelId).steps[item.stepId]), item),
        })),
      };
    case 'group.add':
      return { type: 'group.remove', items: op.items.map((group) => ({ groupId: group.id })) };
    case 'group.remove':
      return { type: 'group.add', items: op.items.map((item) => requireValue(docBefore.groups[item.groupId])) };
    case 'group.update':
      return {
        type: 'group.update',
        items: op.items.map((item) => ({
          groupId: item.groupId,
          ...reversePatch(requireValue(docBefore.groups[item.groupId]), item),
        })),
      };
    case 'asset.add':
      return { type: 'asset.remove', items: op.items.map(({ id, kind }) => ({ id, kind })) };
    case 'asset.remove':
      return {
        type: 'asset.add',
        items: op.items.map((item) =>
          item.kind === 'embeddedPart'
            ? { ...item, kind: 'embeddedPart', value: requireValue(docBefore.embeddedParts[item.id]) }
            : { ...item, kind: 'referenceImage', value: requireValue(docBefore.referenceImages[item.id]) },
        ),
      };
    case 'meta.update':
      return { type: 'meta.update', ...reversePatch(docBefore.meta, op) };
  }
}
export function applyOps(doc: BrkDocument, ops: readonly Op[]): BrkDocument {
  return ops.reduce(apply, doc);
}
export function applyWithInverse(doc: BrkDocument, ops: readonly Op[]): { doc: BrkDocument; inverse: Op[] } {
  const inverse: Op[] = [];
  for (const op of ops) {
    inverse.push(invert(op, doc));
    doc = apply(doc, op);
  }
  return { doc, inverse: inverse.reverse() };
}
