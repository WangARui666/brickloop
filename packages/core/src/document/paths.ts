import { fromLDraw, identity, multiply } from '../math';
import type { Matrix4 } from '../math';
import type { BrkDocument, ColorId, EditContext, Instance, InstancePath, ModelDef, ModelId } from './types';

export interface ResolvedPath {
  model: ModelDef;
  instance: Instance;
  parentMatrix: Matrix4;
  worldMatrix: Matrix4;
}
export function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((id, i) => path[i] === id);
}
export function resolvePath(doc: BrkDocument, path: readonly string[]): ResolvedPath | undefined {
  let model = doc.models[doc.rootModelId],
    parentMatrix = identity();
  for (let index = 0; index < path.length; index++) {
    const instance: Instance | undefined = model?.instances[path[index]!];
    if (!model || !instance) return undefined;
    const matrix = multiply(parentMatrix, fromLDraw(instance.transform));
    if (index === path.length - 1) return { model, instance, parentMatrix, worldMatrix: matrix };
    model = instance.ref.kind === 'model' ? doc.models[instance.ref.modelId] : undefined;
    parentMatrix = matrix;
  }
  return undefined;
}
export function worldMatrix(doc: BrkDocument, path: readonly string[]): Matrix4 | undefined {
  return path.length === 0 ? identity() : resolvePath(doc, path)?.worldMatrix;
}
export function resolveContext(
  doc: BrkDocument,
  context: Pick<EditContext, 'activeModelPath'>,
): { model: ModelDef; matrix: Matrix4 } | undefined {
  if (context.activeModelPath.length === 0) {
    const model = doc.models[doc.rootModelId];
    return model ? { model, matrix: identity() } : undefined;
  }
  const resolved = resolvePath(doc, context.activeModelPath);
  if (resolved?.instance.ref.kind !== 'model') return undefined;
  const model = doc.models[resolved.instance.ref.modelId];
  return model ? { model, matrix: resolved.worldMatrix } : undefined;
}
export function orderedInstances(model: ModelDef): Instance[] {
  return model.stepIds.flatMap((id) =>
    (model.steps[id]?.instanceIds ?? []).flatMap((instanceId) =>
      model.instances[instanceId] ? [model.instances[instanceId]!] : [],
    ),
  );
}
export function wouldCreateCycle(doc: BrkDocument, parentModelId: ModelId, childModelId: ModelId): boolean {
  const pending = [childModelId],
    visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === parentModelId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const instance of Object.values(doc.models[id]?.instances ?? {}))
      if (instance.ref.kind === 'model') pending.push(instance.ref.modelId);
  }
  return false;
}
export interface ExpandedInstance {
  path: InstancePath;
  modelId: ModelId;
  instance: Instance;
  partId: string;
  worldMatrix: Matrix4;
  colorId: ColorId;
  /** One row is one occurrence. Sum multiplicity for BOM totals. */
  multiplicity: number;
  /** Number of occurrences of this definition-local instance in this expansion. */
  definitionMultiplicity: number;
}
export function expandInstances(
  doc: BrkDocument,
  modelId = doc.rootModelId,
  inheritedColor: ColorId = 'ld:16',
): ExpandedInstance[] {
  const result: ExpandedInstance[] = [];
  type Frame = { modelId: string; path: InstancePath; matrix: Matrix4; color: string; ancestors: Set<string> };
  const pending: (Frame | ExpandedInstance)[] = [
    { modelId, path: [], matrix: identity(), color: inheritedColor, ancestors: new Set<string>() },
  ];
  while (pending.length) {
    const frame = pending.pop()!;
    if ('instance' in frame) {
      result.push(frame);
      continue;
    }
    if (frame.ancestors.has(frame.modelId)) throw new RangeError('Cyclic model reference');
    const model = doc.models[frame.modelId];
    if (!model) throw new RangeError('Missing model reference');
    const ancestors = new Set(frame.ancestors).add(frame.modelId);
    const children = orderedInstances(model);
    // Push in reverse to preserve step/instance order in depth-first output.
    for (let i = children.length - 1; i >= 0; i--) {
      const instance = children[i]!;
      const path = [...frame.path, instance.id],
        matrix = multiply(frame.matrix, fromLDraw(instance.transform));
      const color = instance.colorId === 'inherit' ? frame.color : instance.colorId;
      if (instance.ref.kind === 'part') {
        pending.push({
          path,
          modelId: model.id,
          instance,
          partId: instance.ref.partId,
          worldMatrix: matrix,
          colorId: color,
          multiplicity: 1,
          definitionMultiplicity: 0,
        });
      } else pending.push({ modelId: instance.ref.modelId, path, matrix, color, ancestors });
    }
  }
  const counts = new Map<string, number>();
  for (const item of result) {
    const key = item.modelId + '/' + item.instance.id;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const item of result) item.definitionMultiplicity = counts.get(item.modelId + '/' + item.instance.id)!;
  return result;
}
