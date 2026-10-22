import { fail } from '../errors';
import type { IdGenerator } from './id';
import type { Group, ModelDef } from './types';

export function uniqueName(name: string, names: Set<string>): string {
  let result = name,
    suffix = 2;
  while (names.has(result)) result = `${name} (${suffix++})`;
  names.add(result);
  return result;
}
export function modelClosure(models: Record<string, ModelDef>, roots: readonly string[]): ModelDef[] {
  const result: ModelDef[] = [],
    seen = new Set<string>(),
    pending = [...roots].reverse();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const model = models[id] ?? fail('NOT_FOUND', id);
    result.push(model);
    for (const instance of Object.values(model.instances))
      if (instance.ref.kind === 'model') pending.push(instance.ref.modelId);
  }
  return result;
}
/** Copies a definition graph once per source definition, retaining internal sharing. */
export function cloneDefinitions(
  models: readonly ModelDef[],
  groups: readonly Group[],
  id: IdGenerator,
  names: Set<string>,
): { models: ModelDef[]; groups: Group[]; modelIds: Map<string, string> } {
  const modelIds = new Map(models.map((model) => [model.id, id()]));
  const relevant = groups.filter((group) => modelIds.has(group.modelId));
  const groupIds = new Map(relevant.map((group) => [group.id, id()]));
  return {
    modelIds,
    groups: relevant.map((group) => ({
      ...group,
      id: groupIds.get(group.id)!,
      modelId: modelIds.get(group.modelId)!,
      parentGroupId: group.parentGroupId === null ? null : (groupIds.get(group.parentGroupId) ?? null),
    })),
    models: models.map((model) => {
      const stepIds = new Map(model.stepIds.map((sid) => [sid, id()]));
      const instanceIds = new Map(Object.keys(model.instances).map((iid) => [iid, id()]));
      return {
        ...model,
        id: modelIds.get(model.id)!,
        kind: 'submodel',
        name: uniqueName(model.name, names),
        stepIds: model.stepIds.map((sid) => stepIds.get(sid)!),
        steps: Object.fromEntries(
          Object.values(model.steps).map((step) => [
            stepIds.get(step.id)!,
            { ...step, id: stepIds.get(step.id)!, instanceIds: step.instanceIds.map((iid) => instanceIds.get(iid)!) },
          ]),
        ),
        instances: Object.fromEntries(
          Object.values(model.instances).map((instance) => {
            const nextId = instanceIds.get(instance.id)!;
            return [
              nextId,
              {
                ...instance,
                id: nextId,
                ref:
                  instance.ref.kind === 'model'
                    ? {
                        ...instance.ref,
                        modelId: modelIds.get(instance.ref.modelId) ?? fail('NOT_FOUND', instance.ref.modelId),
                      }
                    : instance.ref,
                transform: [...instance.transform],
                stepId: stepIds.get(instance.stepId)!,
                groupId: instance.groupId === null ? null : (groupIds.get(instance.groupId) ?? null),
              },
            ];
          }),
        ),
      };
    }),
  };
}
