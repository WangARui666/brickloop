import { copySelection, pasteInto } from '../clipboard';
import { resolvePath, ulid, validateDocument, wouldCreateCycle } from '../document';
import type { BrkDocument, EditContext, Instance } from '../document';
import { attempt, fail } from '../errors';
import {
  fromLDraw,
  identity,
  invert,
  multiply,
  rotateAboutPivot,
  snapToGrid,
  toLDraw,
  transformDirection,
  transformPoint,
  translation,
} from '../math';
import type { Matrix4 } from '../math';
import { applyOps } from '../ops';
import type { InstanceUpdate, Op } from '../ops';
import { commonGroup, contextModel, groupAncestors, selectedInstances } from './context';
import { submodelCommand } from './submodels';
import type { Command, CommandOutput, CommandServices } from './types';
import { transformPreview } from '../history/transform-preview';
export * from './types';
export * from './context';

function compute(doc: BrkDocument, context: EditContext, command: Command, services: CommandServices): CommandOutput {
  if (doc.schemaVersion > 1) fail('READ_ONLY_NEWER');
  const { model, matrix } = contextModel(doc, context),
    id = services.id ?? ulid;
  const selection = () => selectedInstances(doc, context, 'paths' in command ? command.paths : undefined);
  const update = (items: InstanceUpdate[]): CommandOutput => ({
    ops: items.length ? [{ type: 'instance.update', items }] : [],
  });
  const rename = (name: string) => {
    if (!name.trim()) fail('INVALID_ARGUMENT', 'name');
    return name;
  };
  const color = (value: string) => {
    if (!/^(inherit|(?:c|cx|ld):.+)$/.test(value)) fail('INVALID_ARGUMENT', 'colorId');
    return value;
  };
  const step = (stepId?: string) => {
    const sid = stepId ?? context.stepId ?? model.stepIds[0]!;
    if (!model.steps[sid]) fail('NOT_FOUND', sid);
    return sid;
  };
  switch (command.type) {
    case 'part.add':
    case 'submodel.instantiate': {
      if (command.type === 'part.add' && !/^(ld|cu):.+$/.test(command.partId)) fail('INVALID_ARGUMENT', 'partId');
      if (command.type === 'submodel.instantiate') {
        if (!doc.models[command.modelId]) fail('NOT_FOUND');
        if (wouldCreateCycle(doc, model.id, command.modelId)) fail('CYCLE');
      }
      const instance: Instance = {
        id: id(),
        ref:
          command.type === 'part.add'
            ? { kind: 'part', partId: command.partId }
            : { kind: 'model', modelId: command.modelId },
        colorId: color(command.colorId ?? 'inherit'),
        transform: command.transform ? toLDraw(fromLDraw(command.transform)) : toLDraw(identity()),
        stepId: step(command.stepId),
        groupId: context.activeGroupId ?? null,
      };
      return {
        ops: [{ type: 'instance.add', items: [{ modelId: model.id, instance }] }],
        selection: [[...context.activeModelPath, instance.id]],
      };
    }
    case 'transform.translate':
    case 'transform.rotate':
    case 'transform.set':
    case 'transform.snapToGrid': {
      const selected = selection(),
        inverse = invert(matrix);
      const primaryId = context.primaryPath?.at(-1) ?? selected.at(-1)!.id;
      const primary = selected.find((instance) => instance.id === primaryId) ?? fail('INVALID_CONTEXT', 'primaryPath');
      if (
        context.primaryPath &&
        (context.primaryPath.length !== context.activeModelPath.length + 1 ||
          !context.activeModelPath.every((iid, index) => context.primaryPath![index] === iid))
      )
        fail('INVALID_CONTEXT');
      const primaryWorld = multiply(matrix, fromLDraw(primary.transform));
      let delta: Matrix4 | undefined;
      if (command.type === 'transform.translate') {
        if (command.delta.length !== 3 || !command.delta.every(Number.isFinite)) fail('INVALID_ARGUMENT');
        const movement =
          command.space === 'primaryLocal' ? transformDirection(primaryWorld, command.delta) : command.delta;
        delta = translation(movement);
      } else if (command.type === 'transform.rotate') {
        const axis = command.space === 'primaryLocal' ? transformDirection(primaryWorld, command.axis) : command.axis;
        const pivot =
          command.pivot.kind === 'primaryOrigin' ? transformPoint(primaryWorld, [0, 0, 0]) : command.pivot.point;
        if (pivot.length !== 3 || !pivot.every(Number.isFinite)) fail('INVALID_ARGUMENT');
        delta = rotateAboutPivot(identity(), axis, command.degrees, pivot);
      } else if (command.type === 'transform.set') {
        const target = fromLDraw(command.transform);
        delta = multiply(command.space === 'context' ? multiply(matrix, target) : target, invert(primaryWorld));
      }
      return update(
        selected.flatMap((instance) => {
          const world = multiply(matrix, fromLDraw(instance.transform));
          let next: Matrix4;
          if (command.type === 'transform.snapToGrid') {
            const steps = typeof command.step === 'number' ? [command.step, command.step, command.step] : command.step;
            const origin = command.origin ?? [0, 0, 0];
            next = world.slice();
            for (let axis = 0; axis < 3; axis++)
              next[12 + axis] = snapToGrid(world[12 + axis]! - origin[axis]!, steps[axis]!) + origin[axis]!;
          } else next = multiply(delta!, world);
          const transform = toLDraw(multiply(inverse, next));
          if (transform.every((value, index) => Math.abs(value - instance.transform[index]!) < 1e-12)) return [];
          return [{ modelId: model.id, instanceId: instance.id, changes: { transform } }];
        }),
      );
    }
    case 'color.set':
      return update(
        selection()
          .filter((instance) => instance.colorId !== command.colorId)
          .map((instance) => ({
            modelId: model.id,
            instanceId: instance.id,
            changes: { colorId: color(command.colorId) },
          })),
      );
    case 'color.replace': {
      color(command.to);
      const targets = command.scope === 'document' ? Object.values(doc.models) : [model];
      const ids = command.scope === 'selection' ? new Set(selection().map((instance) => instance.id)) : undefined;
      return update(
        targets.flatMap((target) =>
          Object.values(target.instances)
            .filter(
              (instance) =>
                instance.colorId === command.from && instance.colorId !== command.to && (!ids || ids.has(instance.id)),
            )
            .map((instance) => ({ modelId: target.id, instanceId: instance.id, changes: { colorId: command.to } })),
        ),
      );
    }
    case 'edit.delete':
    case 'edit.cut': {
      const selected = selection();
      return {
        ops: [
          {
            type: 'instance.remove',
            items: selected.map((instance) => ({ modelId: model.id, instanceId: instance.id })),
          },
        ],
        ...(command.type === 'edit.cut' ? { clipboard: copySelection(doc, command.paths ?? context.selection) } : {}),
        selection: [],
      };
    }
    case 'edit.paste':
    case 'edit.clone': {
      if (command.type === 'edit.clone') selection();
      const clipboard =
        command.type === 'edit.paste' ? command.clipboard : copySelection(doc, command.paths ?? context.selection);
      const ops = pasteInto(doc, context, clipboard, command.placement, id);
      return {
        ops,
        selection: ops.flatMap((op) =>
          op.type === 'instance.add' ? op.items.map((item) => [...context.activeModelPath, item.instance.id]) : [],
        ),
      };
    }
    case 'group.create': {
      const selected = selection(),
        selectedIds = new Set(selected.map((instance) => instance.id));
      const parentGroupId = commonGroup(doc, selected),
        group = { id: id(), name: command.name ?? '', modelId: model.id, parentGroupId };
      const full = new Set(
        Object.values(doc.groups)
          .filter((candidate) => candidate.modelId === model.id && candidate.id !== parentGroupId)
          .filter(
            (candidate) =>
              parentGroupId === null ||
              groupAncestors(doc, candidate.parentGroupId).some((ancestor) => ancestor.id === parentGroupId),
          )
          .filter((candidate) => {
            const members = Object.values(model.instances).filter((instance) =>
              groupAncestors(doc, instance.groupId).some((ancestor) => ancestor.id === candidate.id),
            );
            return members.length > 0 && members.every((member) => selectedIds.has(member.id));
          })
          .map((candidate) => candidate.id),
      );
      const roots = [...full].filter((gid) => !full.has(doc.groups[gid]!.parentGroupId ?? ''));
      const items = selected
        .filter((instance) => !groupAncestors(doc, instance.groupId).some((ancestor) => full.has(ancestor.id)))
        .map((instance) => ({ modelId: model.id, instanceId: instance.id, changes: { groupId: group.id } }));
      const ops: Op[] = [{ type: 'group.add', items: [group] }];
      if (roots.length)
        ops.push({
          type: 'group.update',
          items: roots.map((groupId) => ({ groupId, changes: { parentGroupId: group.id } })),
        });
      if (items.length) ops.push({ type: 'instance.update', items });
      return { ops };
    }
    case 'group.dissolve': {
      const groupIds = command.groupIds ?? [
        ...new Set(
          selection()
            .map((instance) => {
              const ancestors = groupAncestors(doc, instance.groupId);
              const boundary = context.activeGroupId
                ? ancestors.findIndex((group) => group.id === context.activeGroupId)
                : ancestors.length;
              return ancestors.slice(0, boundary).at(-1)?.id ?? context.activeGroupId ?? undefined;
            })
            .filter((gid): gid is string => gid !== undefined),
        ),
      ];
      if (!groupIds.length) fail('EMPTY_SELECTION');
      const removed = new Set(groupIds);
      for (const gid of removed) if (doc.groups[gid]?.modelId !== model.id) fail('INVALID_CONTEXT');
      const survivingParent = (gid: string | null): string | null =>
        gid !== null && removed.has(gid) ? survivingParent(doc.groups[gid]!.parentGroupId) : gid;
      const ops: Op[] = [
        {
          type: 'instance.update',
          items: Object.values(model.instances)
            .filter((instance) => instance.groupId !== null && removed.has(instance.groupId))
            .map((instance) => ({
              modelId: model.id,
              instanceId: instance.id,
              changes: { groupId: survivingParent(instance.groupId) },
            })),
        },
        {
          type: 'group.update',
          items: Object.values(doc.groups)
            .filter(
              (group) => !removed.has(group.id) && group.parentGroupId !== null && removed.has(group.parentGroupId),
            )
            .map((group) => ({ groupId: group.id, changes: { parentGroupId: survivingParent(group.parentGroupId) } })),
        },
        { type: 'group.remove', items: [...removed].map((groupId) => ({ groupId })) },
      ];
      return { ops };
    }
    case 'group.rename': {
      if (doc.groups[command.groupId]?.modelId !== model.id) fail('NOT_FOUND');
      return {
        ops: [{ type: 'group.update', items: [{ groupId: command.groupId, changes: { name: rename(command.name) } }] }],
      };
    }
    case 'submodel.create':
      rename(command.name);
      return submodelCommand(doc, context, command, services);
    case 'submodel.makeUnique':
    case 'submodel.explode':
      return submodelCommand(doc, context, command, services);
    case 'submodel.rename': {
      if (!doc.models[command.modelId]) fail('NOT_FOUND');
      return {
        ops: [{ type: 'model.update', items: [{ modelId: command.modelId, changes: { name: rename(command.name) } }] }],
      };
    }
    case 'step.add': {
      const newStep = {
        id: id(),
        instanceIds: [],
        ...(command.description === undefined ? {} : { description: command.description }),
      };
      return {
        ops: [
          {
            type: 'step.add',
            items: [
              {
                modelId: model.id,
                step: newStep,
                ...(command.position === undefined ? {} : { position: command.position }),
              },
            ],
          },
        ],
      };
    }
    case 'step.remove': {
      step(command.stepId);
      if (model.stepIds.length === 1) fail('INVALID_ARGUMENT', 'Last step');
      const index = model.stepIds.indexOf(command.stepId);
      const targetStepId = step(command.targetStepId ?? model.stepIds[index > 0 ? index - 1 : 1]);
      if (targetStepId === command.stepId) fail('INVALID_ARGUMENT');
      return {
        ops: [
          {
            type: 'instance.update',
            items: model.steps[command.stepId]!.instanceIds.map((instanceId) => ({
              modelId: model.id,
              instanceId,
              changes: { stepId: targetStepId },
            })),
          },
          { type: 'step.remove', items: [{ modelId: model.id, stepId: command.stepId }] },
        ],
      };
    }
    case 'step.move': {
      step(command.stepId);
      if (!Number.isInteger(command.position) || command.position < 0 || command.position >= model.stepIds.length)
        fail('INVALID_ARGUMENT');
      const stepIds = model.stepIds.filter((sid) => sid !== command.stepId);
      stepIds.splice(command.position, 0, command.stepId);
      return { ops: [{ type: 'model.update', items: [{ modelId: model.id, changes: { stepIds } }] }] };
    }
    case 'step.assign': {
      const stepId = step(command.stepId);
      return update(
        selection().map((instance, index) => ({
          modelId: model.id,
          instanceId: instance.id,
          changes: { stepId },
          ...(command.position === undefined ? {} : { position: command.position + index }),
        })),
      );
    }
    default:
      return fail('INVALID_ARGUMENT', 'Unknown command');
  }
}

export function executeCommand(
  doc: BrkDocument,
  context: EditContext,
  command: Command,
  services: CommandServices = {},
) {
  return attempt(() => {
    const output = compute(doc, context, command, services);
    if (transformPreview(doc, output.ops)) return output;
    const issues = validateDocument(applyOps(doc, output.ops));
    if (issues.length) fail(issues.some((issue) => issue.code === 'CYCLE') ? 'CYCLE' : 'INVALID_ARGUMENT', issues);
    return output;
  });
}

/** Whether a previously frozen edit still addresses the same model occurrence. */
export function isContextCurrent(before: BrkDocument, after: BrkDocument, context: EditContext): boolean {
  if (before.documentId !== after.documentId) return false;
  for (let index = 1; index <= context.activeModelPath.length; index++) {
    const path = context.activeModelPath.slice(0, index),
      a = resolvePath(before, path),
      b = resolvePath(after, path);
    if (
      !a ||
      !b ||
      a.instance.ref.kind !== 'model' ||
      b.instance.ref.kind !== 'model' ||
      a.instance.ref.modelId !== b.instance.ref.modelId
    )
      return false;
  }
  return true;
}
