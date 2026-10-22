import { cloneDefinitions, modelClosure } from '../document/clone';
import { groupAncestors, contextModel } from '../commands/context';
import { pathStartsWith, resolvePath, ulid, wouldCreateCycle } from '../document';
import type {
  BrkDocument,
  EditContext,
  EmbeddedPartRef,
  Group,
  IdGenerator,
  Instance,
  InstancePath,
  ModelDef,
} from '../document';
import { fromLDraw, invert, multiply, toLDraw, transformPoint, translation } from '../math';
import type { Vec3 } from '../math';
import { attempt, fail } from '../errors';
import type { Op } from '../ops';

export interface ClipboardItem {
  instance: Instance;
  path: InstancePath;
  worldMatrix: number[];
  colorId: string;
}
export interface ClipboardData {
  version: 1;
  sourceDocumentId: string;
  instances: ClipboardItem[];
  models: Record<string, ModelDef>;
  groups: Record<string, Group>;
  embeddedParts: Record<string, EmbeddedPartRef>;
  /** World-space placement anchor; defaults to the first selected instance origin. */
  anchor: Vec3;
}
export interface Placement {
  offset?: Vec3;
  position?: Vec3;
  anchor?: Vec3;
  stepId?: string;
}
export function copySelection(doc: BrkDocument, paths: InstancePath[]): ClipboardData {
  if (!paths.length) fail('EMPTY_SELECTION');
  const unique = [...new Map(paths.map((path) => [path.join('/'), path])).values()];
  const roots = unique.filter(
    (path) => !unique.some((parent) => parent.length < path.length && pathStartsWith(path, parent)),
  );
  const instances: ClipboardItem[] = roots.map((path) => {
    const resolved = resolvePath(doc, path) ?? fail('NOT_FOUND');
    let colorId = 'ld:16';
    for (let i = 1; i <= path.length; i++) {
      const color = resolvePath(doc, path.slice(0, i))!.instance.colorId;
      if (color !== 'inherit') colorId = color;
    }
    return { instance: resolved.instance, path: [...path], worldMatrix: toLDraw(resolved.worldMatrix), colorId };
  });
  const models = modelClosure(
    doc.models,
    instances.flatMap((item) => (item.instance.ref.kind === 'model' ? [item.instance.ref.modelId] : [])),
  );
  const modelIds = new Set(models.map((model) => model.id));
  const selectedGroupIds = new Set(
    instances.flatMap((item) => groupAncestors(doc, item.instance.groupId).map((group) => group.id)),
  );
  const groups = Object.values(doc.groups).filter(
    (group) => modelIds.has(group.modelId) || selectedGroupIds.has(group.id),
  );
  const partIds = new Set(
    [...instances.map((item) => item.instance), ...models.flatMap((model) => Object.values(model.instances))].flatMap(
      (instance) => (instance.ref.kind === 'part' ? [instance.ref.partId] : []),
    ),
  );
  return {
    version: 1,
    sourceDocumentId: doc.documentId,
    instances,
    models: Object.fromEntries(models.map((model) => [model.id, model])),
    groups: Object.fromEntries(groups.map((group) => [group.id, group])),
    embeddedParts: Object.fromEntries(Object.entries(doc.embeddedParts).filter(([id]) => partIds.has(id))),
    anchor: transformPoint(fromLDraw(instances[0]!.worldMatrix), [0, 0, 0]),
  };
}
export function pasteInto(
  doc: BrkDocument,
  context: EditContext,
  clipboard: ClipboardData,
  placement: Placement = {},
  id: IdGenerator = ulid,
): Op[] {
  const { model, matrix } = contextModel(doc, context);
  if (clipboard.version !== 1 || !clipboard.instances.length) fail('INVALID_ARGUMENT');
  if (placement.position && placement.offset) fail('INVALID_ARGUMENT', 'placement');
  const stepId = placement.stepId ?? context.stepId ?? model.stepIds[0]!;
  if (!model.steps[stepId]) fail('NOT_FOUND', stepId);
  const sameDocument = clipboard.sourceDocumentId === doc.documentId;
  const ops: Op[] = [],
    groupValues = Object.values(clipboard.groups);
  const copied = sameDocument
    ? undefined
    : cloneDefinitions(
        Object.values(clipboard.models),
        groupValues,
        id,
        new Set(Object.values(doc.models).map((def) => def.name)),
      );
  if (copied?.models.length) ops.push({ type: 'model.add', items: copied.models });
  if (copied?.groups.length) ops.push({ type: 'group.add', items: copied.groups });
  const assets = Object.entries(clipboard.embeddedParts).filter(([partId, asset]) => {
    if (doc.embeddedParts[partId] && doc.embeddedParts[partId]!.hash !== asset.hash)
      fail('INVALID_ARGUMENT', { assetConflict: partId });
    return !doc.embeddedParts[partId];
  });
  if (assets.length)
    ops.push({
      type: 'asset.add',
      items: assets.map(([partId, value]) => ({ kind: 'embeddedPart', id: partId, value })),
    });
  // The same definition can be copied through several occurrences. Group identity
  // therefore includes the parent occurrence path, not only the definition's ID.
  const groupMap = new Map<string, string>(),
    groups: Group[] = [];
  const cloneGroup = (groupId: string, parentPath: string): string => {
    const key = parentPath + '/' + groupId;
    const existing = groupMap.get(key);
    if (existing) return existing;
    const group = clipboard.groups[groupId] ?? fail('NOT_FOUND', groupId);
    const nextId = id();
    groupMap.set(key, nextId);
    groups.push({
      ...group,
      id: nextId,
      modelId: model.id,
      parentGroupId:
        group.parentGroupId === null ? (context.activeGroupId ?? null) : cloneGroup(group.parentGroupId, parentPath),
    });
    return nextId;
  };
  const anchor = placement.anchor ?? clipboard.anchor;
  const offset =
    placement.offset ??
    (placement.position ? (placement.position.map((v, i) => v - anchor[i]!) as [number, number, number]) : [0, 0, 0]);
  if (offset.length !== 3 || !offset.every(Number.isFinite)) fail('INVALID_ARGUMENT', 'offset');
  const delta = multiply(invert(matrix), translation(offset as Vec3));
  const items = clipboard.instances.map((item) => {
    const instance = item.instance;
    const ref =
      instance.ref.kind === 'part'
        ? instance.ref
        : {
            ...instance.ref,
            modelId: sameDocument
              ? instance.ref.modelId
              : (copied!.modelIds.get(instance.ref.modelId) ?? fail('NOT_FOUND')),
          };
    if (ref.kind === 'model' && sameDocument) {
      if (!doc.models[ref.modelId]) fail('NOT_FOUND', ref.modelId);
      if (wouldCreateCycle(doc, model.id, ref.modelId)) fail('CYCLE');
    }
    return {
      modelId: model.id,
      instance: {
        ...instance,
        id: id(),
        ref,
        colorId: instance.colorId === 'inherit' ? item.colorId : instance.colorId,
        transform: toLDraw(multiply(delta, fromLDraw(item.worldMatrix))),
        stepId,
        groupId: instance.groupId
          ? cloneGroup(instance.groupId, item.path.slice(0, -1).join('/'))
          : (context.activeGroupId ?? null),
      },
    };
  });
  if (groups.length) ops.push({ type: 'group.add', items: groups });
  ops.push({ type: 'instance.add', items });
  return ops;
}
export const tryCopySelection = (doc: BrkDocument, paths: InstancePath[]) => attempt(() => copySelection(doc, paths));
export const tryPasteInto = (
  doc: BrkDocument,
  context: EditContext,
  clipboard: ClipboardData,
  placement: Placement = {},
  id: IdGenerator = ulid,
) => attempt(() => pasteInto(doc, context, clipboard, placement, id));
