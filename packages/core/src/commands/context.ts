import { fail } from '../errors';
import { pathStartsWith, resolveContext, resolvePath } from '../document';
import type { BrkDocument, EditContext, Group, Instance, InstancePath } from '../document';

export function contextModel(doc: BrkDocument, context: EditContext) {
  const resolved = resolveContext(doc, context) ?? fail('INVALID_CONTEXT');
  if (context.activeGroupId && doc.groups[context.activeGroupId]?.modelId !== resolved.model.id)
    fail('INVALID_CONTEXT');
  return resolved;
}
export function groupAncestors(doc: BrkDocument, groupId: string | null): Group[] {
  const groups: Group[] = [],
    seen = new Set<string>();
  while (groupId !== null) {
    if (seen.has(groupId)) fail('CYCLE');
    seen.add(groupId);
    const group = doc.groups[groupId] ?? fail('NOT_FOUND', groupId);
    groups.push(group);
    groupId = group.parentGroupId;
  }
  return groups;
}
export function selectedInstances(doc: BrkDocument, context: EditContext, paths = context.selection): Instance[] {
  const { model } = contextModel(doc, context),
    selected = new Map<string, Instance>();
  if (!paths.length) fail('EMPTY_SELECTION');
  for (const path of paths) {
    if (path.length !== context.activeModelPath.length + 1 || !pathStartsWith(path, context.activeModelPath))
      fail('INVALID_CONTEXT');
    const instance = model.instances[path[path.length - 1]!] ?? fail('NOT_FOUND');
    if (
      context.activeGroupId &&
      !groupAncestors(doc, instance.groupId).some((group) => group.id === context.activeGroupId)
    )
      fail('INVALID_CONTEXT');
    selected.set(instance.id, instance);
  }
  return [...selected.values()];
}
export function commonGroup(doc: BrkDocument, selected: readonly Instance[]): string | null {
  if (!selected.length) return null;
  const first = groupAncestors(doc, selected[0]!.groupId);
  return (
    first.find((group) =>
      selected.every((instance) => groupAncestors(doc, instance.groupId).some((g) => g.id === group.id)),
    )?.id ?? null
  );
}
export interface ClickModifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}
export function resolveClickSelection(
  doc: BrkDocument,
  context: EditContext,
  hitPath: InstancePath,
  modifiers: ClickModifiers = {},
): InstancePath[] {
  const { model } = contextModel(doc, context);
  if (
    !pathStartsWith(hitPath, context.activeModelPath) ||
    hitPath.length <= context.activeModelPath.length ||
    !resolvePath(doc, hitPath)
  )
    return context.selection;
  const path = hitPath.slice(0, context.activeModelPath.length + 1);
  if ((context.hidden ?? []).some((hidden) => pathStartsWith(hitPath, hidden) || pathStartsWith(path, hidden)))
    return context.selection;
  const instance = model.instances[path[path.length - 1]!]!;
  const ancestors = groupAncestors(doc, instance.groupId);
  if (context.activeGroupId && !ancestors.some((group) => group.id === context.activeGroupId)) return context.selection;
  const boundary = context.activeGroupId
    ? ancestors.findIndex((group) => group.id === context.activeGroupId)
    : ancestors.length;
  const targetGroup = modifiers.alt ? undefined : ancestors.slice(0, boundary).at(-1);
  const members = targetGroup
    ? Object.values(model.instances).filter((candidate) =>
        groupAncestors(doc, candidate.groupId).some((group) => group.id === targetGroup.id),
      )
    : [instance];
  const picked = members
    .map((member) => [...context.activeModelPath, member.id])
    .filter((candidate) => !(context.hidden ?? []).some((hidden) => pathStartsWith(candidate, hidden)));
  const key = (candidate: InstancePath) => candidate.join('/');
  if (modifiers.ctrl) {
    const selected = new Set(context.selection.map(key)),
      keys = new Set(picked.map(key));
    return picked.every((candidate) => selected.has(key(candidate)))
      ? context.selection.filter((candidate) => !keys.has(key(candidate)))
      : [...context.selection, ...picked.filter((candidate) => !selected.has(key(candidate)))];
  }
  if (modifiers.shift) {
    const selected = new Set(context.selection.map(key));
    return [...context.selection, ...picked.filter((candidate) => !selected.has(key(candidate)))];
  }
  return picked;
}
