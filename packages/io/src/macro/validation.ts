import { expandInstances, isRecord, validateDocument } from '@brickloop/core';
import type { BrkDocument } from '@brickloop/core';
import type { IoIssue } from '../issues';
import { MACRO_ORIGIN, macroIssue } from './types';
import type { MacroMeta, MacroMetaInput, MacroPackage } from './types';

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
export function validMetaInput(value: unknown): value is MacroMetaInput {
  if (!isRecord(value)) return false;
  const name = value.name;
  return (
    nonempty(value.id) &&
    (nonempty(name) ||
      (isRecord(name) &&
        Object.keys(name).length > 0 &&
        Object.entries(name).every(([k, v]) => nonempty(k) && nonempty(v)))) &&
    nonempty(value.category) &&
    typeof value.author === 'string' &&
    typeof value.createdAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T/.test(value.createdAt) &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}
export function validBounds(value: unknown): value is MacroMeta['bboxLdu'] {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    value.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) &&
    [0, 1, 2].every((axis) => value[axis] <= value[axis + 3])
  );
}
export function validMeta(value: unknown): value is MacroMeta {
  if (!isRecord(value) || !validMetaInput(value)) return false;
  const ids = (items: unknown): boolean =>
    Array.isArray(items) && items.every(nonempty) && new Set(items).size === items.length;
  return (
    Number.isSafeInteger(value.partCount) &&
    Number(value.partCount) > 0 &&
    validBounds(value.bboxLdu) &&
    ids(value.partIds) &&
    ids(value.colorIds) &&
    isRecord(value.origin) &&
    value.origin.convention === MACRO_ORIGIN &&
    JSON.stringify(value.origin.gridLdu) === '[20,8,20]'
  );
}
export function macroInventory(doc: BrkDocument) {
  const rows = expandInstances(doc);
  return {
    partCount: rows.length,
    partIds: [...new Set(rows.map((row) => row.partId))].sort(),
    colorIds: [...new Set(rows.map((row) => row.colorId))].sort(),
  };
}
export function macroPackageIssues(pkg: MacroPackage): IoIssue[] {
  const issues: IoIssue[] = [];
  if (!validMeta(pkg.meta)) issues.push(macroIssue('INVALID_METADATA', 'macro.json'));
  const problems = validateDocument(pkg.document);
  if (problems.length || pkg.document.schemaVersion !== 1) {
    issues.push(macroIssue('INVALID_MODEL', 'model.json', JSON.stringify(problems)));
    return issues;
  }
  const reachable = new Set<string>();
  const pending = [pkg.document.rootModelId];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const instance of Object.values(pkg.document.models[id]!.instances))
      if (instance.ref.kind === 'model') pending.push(instance.ref.modelId);
  }
  if (reachable.size !== Object.keys(pkg.document.models).length)
    issues.push(macroIssue('INVALID_MODEL', 'model.json', 'Unreachable model definitions'));
  if (!issues.length) {
    const inventory = macroInventory(pkg.document);
    if (
      inventory.partCount !== pkg.meta.partCount ||
      JSON.stringify(inventory.partIds) !== JSON.stringify([...pkg.meta.partIds].sort()) ||
      JSON.stringify(inventory.colorIds) !== JSON.stringify([...pkg.meta.colorIds].sort())
    )
      issues.push(macroIssue('INVALID_METADATA', 'macro.json', 'Inventory does not match model'));
  }
  return issues;
}
