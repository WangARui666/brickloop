import {
  applyOps,
  copySelection,
  createModel,
  determinant,
  fromLDraw,
  identity,
  multiply,
  orderedInstances,
  pasteInto,
  resolveContext,
  toLDraw,
  ulid,
} from '@brickloop/core';
import type { BrkDocument, EditContext, IdGenerator, Op } from '@brickloop/core';
import { MacroError, macroIssue, macroName } from './types';
import type { MacroPackage } from './types';
import { macroPackageIssues } from './validation';

export interface MacroInsertOptions {
  as?: 'group' | 'submodel';
  /** 12 LDraw numbers, relative to the target editing model. */
  transform?: number[];
  stepId?: string;
  context?: EditContext;
  /** Display name for the new group/root submodel; defaults to the macro's zh-CN name. */
  name?: string;
  id?: IdGenerator;
}
export function macroInsertOps(pkg: MacroPackage, target: BrkDocument, options: MacroInsertOptions = {}): Op[] {
  const issues = macroPackageIssues(pkg);
  if (issues.length) throw new MacroError(issues);
  const id = options.id ?? ulid;
  const context: EditContext = { ...(options.context ?? { activeModelPath: [], selection: [] }) };
  const resolved = resolveContext(target, context);
  const transform = options.transform ?? toLDraw(identity());
  if (
    !resolved ||
    (options.as !== undefined && !['group', 'submodel'].includes(options.as)) ||
    transform.length !== 12 ||
    !transform.every(Number.isFinite) ||
    Math.abs(determinant(fromLDraw(transform))) < 1e-12
  )
    throw new MacroError([macroIssue('INVALID_PLACEMENT')]);
  const name = options.name ?? macroName(pkg.meta.name);
  const stepId = options.stepId ?? context.stepId ?? resolved.model.stepIds[0]!;
  const source = pkg.document;
  const root = source.models[source.rootModelId]!;
  let clipboard;
  let base = target;
  const ops: Op[] = [];
  if (options.as === 'submodel') {
    // A transient holder lets core clone the entire root + shared closure using public pasteInto.
    const holder = createModel('', 'main', id);
    const reference = {
      id: id(),
      ref: { kind: 'model' as const, modelId: root.id },
      colorId: 'inherit',
      transform: toLDraw(identity()),
      stepId: holder.stepIds[0]!,
      groupId: null,
    };
    holder.instances[reference.id] = reference;
    holder.steps[reference.stepId]!.instanceIds.push(reference.id);
    clipboard = copySelection(
      {
        ...source,
        rootModelId: holder.id,
        models: { ...source.models, [root.id]: { ...root, kind: 'submodel', name }, [holder.id]: holder },
      },
      [[reference.id]],
    );
  } else {
    const group = { id: id(), name, modelId: resolved.model.id, parentGroupId: context.activeGroupId ?? null };
    ops.push({ type: 'group.add', items: [group] });
    base = applyOps(target, ops);
    clipboard = copySelection(
      source,
      orderedInstances(root).map((instance) => [instance.id]),
    );
    context.activeGroupId = group.id;
  }
  clipboard.sourceDocumentId = '';
  // pasteInto consumes world matrices; placement is expressed in the active model's coordinates.
  const placement = multiply(resolved.matrix, fromLDraw(transform));
  clipboard.instances = clipboard.instances.map((item) => ({
    ...item,
    worldMatrix: toLDraw(multiply(placement, fromLDraw(item.worldMatrix))),
  }));
  ops.push(...pasteInto(base, context, clipboard, { stepId }, id));
  // Detach extension data as well as transforms from the reusable package.
  return structuredClone(ops);
}
