import {
  applyOps,
  copySelection,
  createDocument,
  expandInstances,
  fromLDraw,
  multiply,
  orderedInstances,
  parseDocument,
  pasteInto,
  serializeDocument,
  toLDraw,
  transformPoint,
  translation,
  validateDocument,
} from '@brickloop/core';
import type { BBox, BrkDocument, InstancePath } from '@brickloop/core';
import { MACRO_ORIGIN, MacroError, macroIssue, macroName } from './types';
import type { MacroMetaInput, MacroPackage, MacroServices } from './types';
import { macroInventory, validBounds, validMetaInput } from './validation';

function bounds(doc: BrkDocument, provider: MacroServices['bboxProvider']): BBox {
  const result: [number, number, number, number, number, number] = [
    Infinity,
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
    -Infinity,
  ];
  const rows = expandInstances(doc);
  if (!rows.length) throw new MacroError([macroIssue('EMPTY_SELECTION')]);
  for (const row of rows) {
    const box = provider(row.partId);
    if (!validBounds(box)) throw new MacroError([macroIssue('BOUNDS_MISSING', undefined, row.partId)]);
    for (const x of [box[0], box[3]])
      for (const y of [box[1], box[4]])
        for (const z of [box[2], box[5]]) {
          const point = transformPoint(row.worldMatrix, [x, y, z]);
          for (let axis = 0; axis < 3; axis++) {
            result[axis] = Math.min(result[axis]!, point[axis]!);
            result[axis + 3] = Math.max(result[axis + 3]!, point[axis]!);
          }
        }
  }
  return result;
}

/** Detached, normalized selection closure; leaves the source document untouched. */
export function createMacroFromSelection(
  source: BrkDocument,
  paths: InstancePath[],
  meta: MacroMetaInput,
  services: MacroServices,
): MacroPackage {
  if (!validMetaInput(meta)) throw new MacroError([macroIssue('INVALID_METADATA')]);
  if (!paths.length) throw new MacroError([macroIssue('EMPTY_SELECTION')]);
  const problems = validateDocument(source);
  if (problems.length || source.schemaVersion !== 1)
    throw new MacroError([macroIssue('INVALID_MODEL', undefined, JSON.stringify(problems))]);
  const clipboard = copySelection(source, paths);
  // Always clone definitions, including when an injected ID generator reuses the document ID.
  clipboard.sourceDocumentId = '';
  let document = createDocument(
    { title: macroName(meta.name), author: meta.author, createdAt: meta.createdAt },
    { ...(services.id ? { id: services.id } : {}), catalogPack: { ...source.catalogPack } },
  );
  document = applyOps(
    document,
    pasteInto(document, { activeModelPath: [], selection: [] }, clipboard, {}, services.id),
  );
  const box = bounds(document, services.bboxProvider);
  const anchor = [
    Math.round((box[0] + box[3]) / 40) * 20,
    Math.round(box[4] / 8) * 8,
    Math.round((box[2] + box[5]) / 40) * 20,
  ] as const;
  const offset = translation([-anchor[0], -anchor[1], -anchor[2]]);
  document = applyOps(document, [
    {
      type: 'instance.update',
      items: orderedInstances(document.models[document.rootModelId]!).map((instance) => ({
        modelId: document.rootModelId,
        instanceId: instance.id,
        changes: { transform: toLDraw(multiply(offset, fromLDraw(instance.transform))) },
      })),
    },
  ]);
  // Reuse .brkl canonicalization and detach all nested extension data from the source.
  const parsed = parseDocument(serializeDocument(document));
  if (!parsed.doc) throw new MacroError([macroIssue('INVALID_MODEL', undefined, JSON.stringify(parsed.issues))]);
  document = parsed.doc;
  return {
    document,
    meta: {
      ...meta,
      name: typeof meta.name === 'string' ? meta.name : { ...meta.name },
      ...macroInventory(document),
      bboxLdu: bounds(document, services.bboxProvider),
      origin: { convention: MACRO_ORIGIN, gridLdu: [20, 8, 20] },
    },
  };
}
