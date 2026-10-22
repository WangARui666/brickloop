import {
  fromLDraw,
  identity,
  multiply,
  orderedInstances,
  pathStartsWith,
  resolveContext,
  resolvePath,
} from '@brickloop/core';
import type { BrkDocument, InstancePath, Matrix4 } from '@brickloop/core';
import type { Occurrence, ScopeOptions } from './types';

/** Full paths keep repeated submodels' visibility, selection and inherited colors independent. */
export function collectScene(doc: BrkDocument, options: ScopeOptions = {}, defaultIncludeHidden = false) {
  const scope = options.scope ?? { kind: 'project' };
  let prefixes: InstancePath[];
  if (scope.kind === 'model') {
    if (!resolveContext(doc, { activeModelPath: scope.path })) throw new RangeError('Invalid model scope');
    prefixes = [scope.path];
  } else if (scope.kind === 'selection') {
    for (const path of scope.paths)
      if (!path.length || !resolvePath(doc, path)) throw new RangeError('Invalid selection path');
    prefixes = scope.paths;
  } else prefixes = [[]];
  const includeHidden = options.includeHidden ?? defaultIncludeHidden;
  const parts: Occurrence[] = [];
  const models: Occurrence[] = [];
  const roots: Occurrence[] = [];
  function visit(
    modelId: string,
    path: InstancePath,
    matrix: Matrix4,
    colorId: string,
    ancestors: Set<string>,
  ): Occurrence[] {
    if (ancestors.has(modelId)) throw new RangeError('Cyclic model reference');
    const model = doc.models[modelId];
    if (!model) throw new RangeError('Missing model reference');
    const nextAncestors = new Set(ancestors).add(modelId);
    const result: Occurrence[] = [];
    for (const instance of orderedInstances(model)) {
      const nextPath = [...path, instance.id];
      if (!includeHidden && options.workspace?.hidden.some((hidden) => pathStartsWith(nextPath, hidden))) continue;
      const selected = prefixes.some((prefix) => pathStartsWith(nextPath, prefix));
      if (!selected && !prefixes.some((prefix) => pathStartsWith(prefix, nextPath))) continue;
      const localMatrix = fromLDraw(instance.transform);
      const node: Occurrence = {
        path: nextPath,
        name: instance.id,
        ref: instance.ref,
        localMatrix,
        worldMatrix: multiply(matrix, localMatrix),
        colorId: instance.colorId === 'inherit' ? colorId : instance.colorId,
        children: [],
      };
      if (instance.ref.kind === 'model') {
        node.name = doc.models[instance.ref.modelId]?.name ?? instance.id;
        node.children = visit(instance.ref.modelId, nextPath, node.worldMatrix, node.colorId, nextAncestors);
        if (selected) models.push(node);
      } else if (selected) parts.push(node);
      if (selected) {
        result.push(node);
        if (!prefixes.some((prefix) => pathStartsWith(path, prefix))) roots.push(node);
      }
    }
    return result;
  }
  const projectRoots = visit(doc.rootModelId, [], identity(), options.defaultColorId ?? 'ld:16', new Set());
  return { roots: prefixes.some((prefix) => prefix.length === 0) ? projectRoots : roots, parts, models };
}
