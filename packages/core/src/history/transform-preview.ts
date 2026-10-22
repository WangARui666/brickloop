import type { BrkDocument, Instance, ModelDef } from '../document';
import type { Op } from '../ops';
import { fail } from '../errors';

// Internal transaction metadata, deliberately not exported from the core public entry point.
export const previewBases = new WeakSet<BrkDocument>();
export const transformPreviews = new WeakMap<BrkDocument, { base: BrkDocument; ids: string[] }>();
export const previewViews = new WeakMap<object, BrkDocument>();
const materialized = new WeakMap<BrkDocument, BrkDocument>();

/** Internal viewport read; public DocumentSession.document remains a plain, clonable snapshot. */
export function previewDocument(session: { readonly document: BrkDocument }): BrkDocument {
  return previewViews.get(session) ?? session.document;
}
export function materializePreview(view: BrkDocument): BrkDocument {
  const metadata = transformPreviews.get(view);
  if (!metadata) return view;
  const cached = materialized.get(view);
  if (cached) return cached;
  const doc = {
    ...view,
    models: Object.fromEntries(
      Object.entries(view.models).map(([id, model]) => [
        id,
        model === metadata.base.models[id] ? model : { ...model, instances: { ...model.instances } },
      ]),
    ),
  };
  materialized.set(view, doc);
  transformPreviews.set(doc, metadata);
  return doc;
}

/** A sparse, immutable view for a validated transaction. Committing materializes ordinary records.
 * Property access and JSON enumeration preserve Record semantics; previous previews stay unchanged. */
export function transformPreview(base: BrkDocument, ops: Op[]): BrkDocument | undefined {
  if (
    !previewBases.has(base) ||
    !ops.every(
      (op) =>
        op.type === 'instance.update' &&
        op.items.every(
          (item) =>
            item.position === undefined &&
            !item.unset?.length &&
            Object.keys(item.changes).every((key) => key === 'transform'),
        ),
    )
  )
    return;
  const changes = new Map<string, Map<string, Instance>>();
  const ids = new Set<string>();
  for (const op of ops) {
    if (op.type !== 'instance.update') continue;
    for (const item of op.items) {
      const instance = base.models[item.modelId]?.instances[item.instanceId];
      if (!instance) fail('NOT_FOUND');
      const transform = item.changes.transform;
      if (transform === undefined) continue;
      if (!Array.isArray(transform) || transform.length !== 12 || !transform.every(Number.isFinite))
        fail('INVALID_DOCUMENT');
      const model = changes.get(item.modelId) ?? new Map<string, Instance>();
      model.set(item.instanceId, { ...instance, transform: [...transform] });
      changes.set(item.modelId, model);
      ids.add(item.instanceId);
    }
  }
  const models: Record<string, ModelDef> = { ...base.models };
  for (const [id, changed] of changes) {
    const model = base.models[id]!;
    const instances = new Proxy(model.instances, {
      get: (target, property, receiver) =>
        typeof property === 'string' && changed.has(property)
          ? changed.get(property)
          : Reflect.get(target, property, receiver),
      getOwnPropertyDescriptor: (target, property) =>
        typeof property === 'string' && changed.has(property)
          ? { value: changed.get(property), writable: true, enumerable: true, configurable: true }
          : Reflect.getOwnPropertyDescriptor(target, property),
    });
    models[id] = { ...model, instances };
  }
  const next = { ...base, models };
  transformPreviews.set(next, { base, ids: [...ids] });
  return next;
}
