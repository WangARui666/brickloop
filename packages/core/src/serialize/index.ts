import { isRecord, validateDocument } from '../document';
import type { BrkDocument, DocumentIssue } from '../document';
import { normalizeForSave } from '../math';

/** Stable JSON preserves semantic array order (steps, members, unknown arrays). */
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (
    typeof value !== 'object' ||
    value === null ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new TypeError('Document contains a non-JSON value');
  if (ancestors.has(value)) throw new TypeError('Document contains a JSON cycle');
  ancestors.add(value);
  let text: string;
  if (Array.isArray(value)) text = '[' + value.map((item: unknown) => canonical(item, ancestors)).join(',') + ']';
  else
    text =
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key], ancestors))
        .join(',') +
      '}';
  ancestors.delete(value);
  return text;
}
export function serializeDocument(doc: BrkDocument): string {
  // Only known instance transforms are normalized. An extension called
  // "transform" is opaque and must round-trip unchanged.
  const models = Object.fromEntries(
    Object.entries(doc.models).map(([id, model]) => [
      id,
      {
        ...model,
        instances: Object.fromEntries(
          Object.entries(model.instances).map(([iid, instance]) => [
            iid,
            { ...instance, transform: normalizeForSave(instance.transform) },
          ]),
        ),
      },
    ]),
  );
  return canonical({ ...doc, models });
}
export interface ParseResult {
  doc: BrkDocument | null;
  issues: DocumentIssue[];
}
export function parseDocument(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      doc: null,
      issues: [{ code: 'INVALID_JSON', path: '', messageKey: 'core.validation.INVALID_JSON', severity: 'error' }],
    };
  }
  const issues = validateDocument(value);
  if (isRecord(value) && typeof value.schemaVersion === 'number' && value.schemaVersion > 1)
    issues.push({
      code: 'READ_ONLY_NEWER',
      path: 'schemaVersion',
      messageKey: 'core.errors.READ_ONLY_NEWER',
      severity: 'warning',
    });
  return { doc: issues.some((issue) => issue.severity === 'error') ? null : (value as BrkDocument), issues };
}
