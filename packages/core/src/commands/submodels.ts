import { copySelection, pasteInto } from '../clipboard';
import { cloneDefinitions, modelClosure, uniqueName } from '../document/clone';
import { createModel, expandInstances, orderedInstances, ulid } from '../document';
import type { BrkDocument, EditContext, Group, Instance, ModelDef } from '../document';
import { fromLDraw, invert, multiply, snapToGrid, toLDraw, transformPoint, translation } from '../math';
import type { Vec3 } from '../math';
import { applyOps } from '../ops';
import type { Op } from '../ops';
import { fail } from '../errors';
import { commonGroup, contextModel, groupAncestors, selectedInstances } from './context';
import type { Command, CommandOutput, CommandServices } from './types';

export function submodelCommand(
  doc: BrkDocument,
  context: EditContext,
  command: Extract<Command, { type: 'submodel.create' | 'submodel.makeUnique' | 'submodel.explode' }>,
  services: CommandServices,
): CommandOutput {
  const id = services.id ?? ulid,
    { model } = contextModel(doc, context);
  const selected = selectedInstances(doc, context, command.paths),
    ids = new Set(selected.map((instance) => instance.id));
  const names = new Set(Object.values(doc.models).map((definition) => definition.name));
  if (command.type === 'submodel.makeUnique') {
    const ops: Op[] = [];
    for (const instance of selected) {
      if (instance.ref.kind !== 'model') fail('INVALID_ARGUMENT');
      const copied = cloneDefinitions(
        modelClosure(doc.models, [instance.ref.modelId]),
        Object.values(doc.groups),
        id,
        names,
      );
      ops.push({ type: 'model.add', items: copied.models });
      if (copied.groups.length) ops.push({ type: 'group.add', items: copied.groups });
      ops.push({
        type: 'instance.update',
        items: [
          {
            modelId: model.id,
            instanceId: instance.id,
            changes: { ref: { ...instance.ref, modelId: copied.modelIds.get(instance.ref.modelId)! } },
          },
        ],
      });
    }
    return { ops };
  }
  if (command.type === 'submodel.explode') {
    const ops: Op[] = [],
      selection: string[][] = [];
    let working = doc;
    for (const instance of selected) {
      if (instance.ref.kind !== 'model') fail('INVALID_ARGUMENT');
      const definition = doc.models[instance.ref.modelId] ?? fail('NOT_FOUND');
      const parentPath = [...context.activeModelPath, instance.id];
      const paths = orderedInstances(definition).map((child) => [...parentPath, child.id]);
      if (paths.length) {
        const clipboard = copySelection(working, paths);
        // The removed instance's surrounding group survives; child groups are
        // freshly identified inside that group, retaining nested selection semantics.
        const pasted = pasteInto(
          working,
          { ...context, activeGroupId: instance.groupId },
          clipboard,
          { stepId: instance.stepId },
          id,
        );
        for (const op of pasted)
          if (op.type === 'instance.add') {
            const position = working.models[model.id]!.steps[instance.stepId]!.instanceIds.indexOf(instance.id);
            op.items.forEach((item, index) => {
              item.position = position + index;
              selection.push([...context.activeModelPath, item.instance.id]);
            });
          }
        ops.push(...pasted);
        working = applyOps(working, pasted);
      }
      const remove: Op = { type: 'instance.remove', items: [{ modelId: model.id, instanceId: instance.id }] };
      ops.push(remove);
      working = applyOps(working, [remove]);
    }
    return { ops, selection };
  }
  const bboxProvider = services.bboxProvider ?? fail('INVALID_ARGUMENT', 'bboxProvider');
  const subset: ModelDef = {
    ...model,
    instances: Object.fromEntries(selected.map((instance) => [instance.id, instance])),
    steps: Object.fromEntries(
      Object.values(model.steps).map((step) => [
        step.id,
        { ...step, instanceIds: step.instanceIds.filter((iid) => ids.has(iid)) },
      ]),
    ),
  };
  const leaves = expandInstances({ ...doc, models: { ...doc.models, [model.id]: subset } }, model.id);
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const leaf of leaves) {
    const bbox = bboxProvider(leaf.partId) ?? fail('NOT_FOUND', { bbox: leaf.partId });
    if (bbox.length !== 6 || !bbox.every(Number.isFinite) || [0, 1, 2].some((axis) => bbox[axis]! > bbox[axis + 3]!))
      fail('INVALID_ARGUMENT', 'bbox');
    for (let corner = 0; corner < 8; corner++) {
      const point = transformPoint(leaf.worldMatrix, [
        bbox[corner & 1 ? 3 : 0],
        bbox[corner & 2 ? 4 : 1],
        bbox[corner & 4 ? 5 : 2],
      ]);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, point[axis]!);
        max[axis] = Math.max(max[axis]!, point[axis]!);
      }
    }
  }
  if (!leaves.length) fail('INVALID_ARGUMENT', 'Empty bounding box');
  // LDraw has -Y up, so the bottom of the box is maxY.
  const origin: Vec3 = [
    snapToGrid((min[0]! + max[0]!) / 2, 20),
    snapToGrid(max[1]!, 20),
    snapToGrid((min[2]! + max[2]!) / 2, 20),
  ];
  const newModel = createModel(uniqueName(command.name, names), 'submodel', id);
  const originMatrix = translation(origin),
    inverse = invert(originMatrix);
  const usedSteps = model.stepIds.filter((sid) => model.steps[sid]!.instanceIds.some((iid) => ids.has(iid)));
  const stepMap = new Map(usedSteps.map((sid) => [sid, id()]));
  const groupSet = new Set(
    selected.flatMap((instance) => groupAncestors(doc, instance.groupId).map((group) => group.id)),
  );
  const groupMap = new Map([...groupSet].map((gid) => [gid, id()]));
  const groups: Group[] = [...groupSet].map((gid) => {
    const group = doc.groups[gid]!;
    return {
      ...group,
      id: groupMap.get(gid)!,
      modelId: newModel.id,
      parentGroupId: group.parentGroupId === null ? null : (groupMap.get(group.parentGroupId) ?? null),
    };
  });
  newModel.stepIds = usedSteps.map((sid) => stepMap.get(sid)!);
  newModel.steps = Object.fromEntries(
    usedSteps.map((sid) => [
      stepMap.get(sid)!,
      {
        ...model.steps[sid]!,
        id: stepMap.get(sid)!,
        instanceIds: model.steps[sid]!.instanceIds.filter((iid) => ids.has(iid)),
      },
    ]),
  );
  newModel.instances = Object.fromEntries(
    selected.map((instance) => [
      instance.id,
      {
        ...instance,
        transform: toLDraw(multiply(inverse, fromLDraw(instance.transform))),
        stepId: stepMap.get(instance.stepId)!,
        groupId: instance.groupId === null ? null : groupMap.get(instance.groupId)!,
      },
    ]),
  );
  const first = orderedInstances(model).find((instance) => ids.has(instance.id))!;
  const parent: Instance = {
    id: id(),
    ref: { kind: 'model', modelId: newModel.id },
    transform: toLDraw(originMatrix),
    colorId: 'inherit',
    groupId: commonGroup(doc, selected),
    stepId: first.stepId,
  };
  return {
    ops: [
      { type: 'instance.remove', items: selected.map((instance) => ({ modelId: model.id, instanceId: instance.id })) },
      { type: 'model.add', items: [newModel] },
      ...(groups.length ? [{ type: 'group.add' as const, items: groups }] : []),
      {
        type: 'instance.add',
        items: [
          { modelId: model.id, instance: parent, position: model.steps[first.stepId]!.instanceIds.indexOf(first.id) },
        ],
      },
    ],
    selection: [[...context.activeModelPath, parent.id]],
  };
}
