import {
  createDocument,
  createModel,
  createWorkspace,
  expandInstances,
  isRecord,
  ulid,
  validateDocument,
} from '@brickloop/core';
import type { BrkDocument, Instance, ModelDef, Workspace } from '@brickloop/core';
import { normalizeFileName, parseLDraw, readModel, writeModel } from '@brickloop/ldraw';
import type { EmbeddedData, GeometryLine, LDrawModel, ModelStep, Transform } from '@brickloop/ldraw';
import { hashBytes } from './binary';
import type { ProjectAssets } from './binary';
import { createReport, issue } from './issues';
import type { IoReport } from './issues';

/** Structural subsets accept catalog PartDef/ColorDef without importing its Node/XLSX entry point. */
export interface IoPart {
  id: string;
  ldrawFile: string | null;
  geometry?: { source: string; ref: string; hash: string };
}
export interface IoColor {
  id: string;
  ldrawCode: number | null;
  rgb: string;
  alpha?: number;
  legoName?: string | null;
}
export interface IoContext {
  parts?: readonly IoPart[];
  colors?: readonly IoColor[];
  workspace?: Workspace;
  assets?: ProjectAssets;
  thumbnail?: Uint8Array;
  fileName?: string;
}
export interface ImportResult {
  doc: BrkDocument | null;
  workspace: Workspace;
  assets: ProjectAssets;
  parts: IoPart[];
  colors: IoColor[];
  report: IoReport;
}
export interface LDrawStepExtension {
  meta: string[];
  geometry: GeometryLine[];
  order: ModelStep['order'];
}
export interface LDrawExtension {
  fileName?: string;
  meta: string[];
  steps: Record<string, LDrawStepExtension>;
}
function ldrawExtension(model: ModelDef): LDrawExtension {
  const value = model.extensions.ldraw;
  return isRecord(value) ? (value as unknown as LDrawExtension) : { meta: [], steps: {} };
}
export function countDocument(doc: BrkDocument, report: IoReport): void {
  const models = Object.values(doc.models);
  report.counts.parts = expandInstances(doc).length;
  report.counts.models = models.length;
  report.counts.submodels = models.length - 1;
  report.counts.instances = models.reduce((n, m) => n + Object.keys(m.instances).length, 0);
  report.counts.steps = models.reduce((n, m) => n + m.stepIds.length, 0);
}
export function importLDraw(source: string, fileName: string, ctx: IoContext = {}): ImportResult {
  const report = createReport(),
    workspace = createWorkspace(),
    assets: ProjectAssets = {};
  const result: ImportResult = { doc: null, workspace, assets, parts: [], colors: [], report };
  try {
    const parsed = parseLDraw(source, fileName),
      model = readModel(source, fileName);
    for (const warning of parsed.warnings)
      report.warnings.push(issue('IO_PARSE_WARNING', fileName, warning, 'warning'));
    if (!model.submodels.length) throw new Error('No model definitions');
    const doc = createDocument({ title: fileName });
    doc.models = {};
    const definitions = new Map<string, ModelDef>();
    for (const [index, sub] of model.submodels.entries()) {
      const name = normalizeFileName(sub.fileName);
      if (definitions.has(name)) throw new Error(`Duplicate model: ${name}`);
      const def = createModel(sub.fileName, index === 0 ? 'main' : 'submodel');
      def.steps = {};
      def.stepIds = [];
      doc.models[def.id] = def;
      definitions.set(name, def);
      if (index === 0) doc.rootModelId = def.id;
    }
    const partMap = new Map<string, IoPart>();
    for (const part of ctx.parts ?? []) if (part.ldrawFile) partMap.set(normalizeFileName(part.ldrawFile), part);
    const colorMap = new Map((ctx.colors ?? []).filter((c) => c.ldrawCode !== null).map((c) => [c.ldrawCode!, c]));
    const seenParts = new Set<string>(),
      seenColors = new Set<number>();
    for (const [index, sub] of model.submodels.entries()) {
      const def = definitions.get(normalizeFileName(sub.fileName))!;
      const extension: LDrawExtension = { fileName: sub.fileName, meta: [], steps: {} };
      // readModel owns the step layout; parser references retain the source precision.
      const rawRefs = parsed.subfiles[index]!.lines.filter((line) => line.type === 1);
      let refIndex = 0;
      // A trailing `0 STEP` closes the last step; it must not become an extra empty step.
      const steps = sub.steps.filter(
        (step, i, all) => !(i === all.length - 1 && all.length > 1 && step.order.length === 0),
      );
      for (const step of steps) {
        const stepId = ulid();
        def.stepIds.push(stepId);
        def.steps[stepId] = { id: stepId, instanceIds: [] };
        extension.steps[stepId] = { meta: step.meta, geometry: step.geometry, order: step.order };
        extension.meta.push(...step.meta);
        for (const ref of step.instances) {
          const rawRef = rawRefs[refIndex++]!;
          const target = definitions.get(normalizeFileName(ref.fileName));
          const partName = normalizeFileName(ref.fileName);
          const mappedPart = partMap.get(partName);
          const partId = mappedPart?.id ?? `ld:${partName.replace(/\.dat$/i, '')}`;
          if (!target && !seenParts.has(partName)) {
            seenParts.add(partName);
            if (mappedPart) {
              result.parts.push(mappedPart);
              report.counts.mappedParts++;
            } else {
              result.parts.push({ id: partId, ldrawFile: partName });
              report.counts.unmappedParts++;
              report.warnings.push(issue('IO_PART_UNMAPPED', partName, partId, 'warning'));
            }
          }
          const mappedColor = colorMap.get(ref.color);
          const colorId = ref.color === 16 ? 'inherit' : (mappedColor?.id ?? `ld:${ref.color}`);
          if (ref.color !== 16 && !seenColors.has(ref.color)) {
            seenColors.add(ref.color);
            if (mappedColor) {
              result.colors.push(mappedColor);
              report.counts.mappedColors++;
            } else {
              result.colors.push({
                id: colorId,
                ldrawCode: ref.color,
                rgb: ref.color >= 0x2000000 ? `#${(ref.color & 0xffffff).toString(16).padStart(6, '0')}` : '#808080',
                legoName: null,
              });
              report.counts.unmappedColors++;
              report.warnings.push(issue('IO_COLOR_UNMAPPED', undefined, String(ref.color), 'warning'));
            }
          }
          const instance: Instance = {
            id: ulid(),
            ref: target ? { kind: 'model', modelId: target.id } : { kind: 'part', partId },
            colorId,
            transform: [...rawRef.transform],
            stepId,
            groupId: null,
          };
          def.instances[instance.id] = instance;
          def.steps[stepId]!.instanceIds.push(instance.id);
        }
      }
      def.extensions.ldraw = extension;
    }
    doc.extensions.ldraw = { data: model.data };
    const errors = validateDocument(doc).filter((x) => x.severity === 'error');
    if (errors.length) throw new Error(JSON.stringify(errors));
    countDocument(doc, report);
    result.doc = doc;
  } catch (error) {
    report.errors.push(issue('IO_MODEL_INVALID', fileName, String(error)));
  }
  return result;
}
function nearestColor(rgb: string, colors: readonly IoColor[]): IoColor | undefined {
  const channels = (value: string) => [1, 3, 5].map((p) => parseInt(value.slice(p, p + 2), 16));
  const wanted = channels(rgb);
  return colors
    .filter((c) => c.ldrawCode !== null)
    .map((color) => ({ color, distance: channels(color.rgb).reduce((sum, x, i) => sum + (x - wanted[i]!) ** 2, 0) }))
    .sort((a, b) => a.distance - b.distance)[0]?.color;
}
export function exchangeModel(
  doc: BrkDocument,
  ctx: IoContext,
  report: IoReport,
): { model: LDrawModel; instances: Instance[] } {
  const invalid = validateDocument(doc).filter((x) => x.severity === 'error');
  if (invalid.length) throw new Error(`IO_MODEL_INVALID: ${JSON.stringify(invalid)}`);
  countDocument(doc, report);
  const defs = [doc.models[doc.rootModelId]!, ...Object.values(doc.models).filter((d) => d.id !== doc.rootModelId)];
  const names = new Map<string, string>(),
    usedNames = new Set<string>();
  for (const def of defs) {
    const candidate =
      ldrawExtension(def).fileName ??
      (def.kind === 'main' ? (ctx.fileName ?? 'main.ldr') : `${def.name || def.id}.ldr`);
    let name = candidate.replace(/[\r\n\\:]/g, '_');
    try {
      normalizeFileName(name);
    } catch {
      name = `${def.id}.ldr`;
    }
    if (usedNames.has(name.toLowerCase())) name = `${def.id}.ldr`;
    usedNames.add(name.toLowerCase());
    names.set(def.id, name);
  }
  const colors = new Map((ctx.colors ?? []).map((c) => [c.id, c]));
  const parts = new Map((ctx.parts ?? []).map((p) => [p.id, p]));
  const reported = new Set<string>();
  function colorCode(id: string): number {
    if (id === 'inherit') return 16;
    if (/^ld:\d+$/.test(id)) return Number(id.slice(3));
    const color = colors.get(id);
    if (color?.ldrawCode !== null && color?.ldrawCode !== undefined) return color.ldrawCode;
    const nearest = color && nearestColor(color.rgb, ctx.colors ?? []);
    if (!reported.has(id)) {
      reported.add(id);
      report.degradations.push(issue('IO_COLOR_FALLBACK', undefined, `${id} → ${nearest?.ldrawCode ?? 7}`, 'warning'));
    }
    return nearest?.ldrawCode ?? 7;
  }
  const instances: Instance[] = [];
  const model: LDrawModel = { fileName: names.get(doc.rootModelId)!, isMpd: true, submodels: [], data: [] };
  if (isRecord(doc.extensions.ldraw) && Array.isArray(doc.extensions.ldraw.data))
    model.data = doc.extensions.ldraw.data as EmbeddedData[];
  for (const def of defs) {
    const ext = ldrawExtension(def);
    const steps: ModelStep[] = [];
    for (const stepId of def.stepIds) {
      const stored = ext.steps?.[stepId];
      const step: ModelStep = {
        instances: [],
        meta: [...(stored?.meta ?? [])],
        geometry: stored?.geometry ?? [],
        order: stored?.order ?? [],
      };
      for (const id of def.steps[stepId]!.instanceIds) {
        const instance = def.instances[id]!;
        let fileName: string;
        if (instance.ref.kind === 'model') fileName = names.get(instance.ref.modelId)!;
        else {
          const partId = instance.ref.partId;
          const embedded = doc.embeddedParts[partId];
          fileName =
            parts.get(partId)?.ldrawFile ??
            (typeof embedded?.fileName === 'string' ? embedded.fileName : `${partId.slice(3)}.dat`);
          fileName = normalizeFileName(fileName);
        }
        step.instances.push({
          type: 1,
          color: colorCode(instance.colorId),
          transform: instance.transform as Transform,
          fileName,
        });
        instances.push(instance);
      }
      steps.push(step);
    }
    // Support caller-added model meta as well as the per-step placement retained on import.
    const known = new Set(steps.flatMap((s) => s.meta));
    for (const meta of ext.meta ?? []) if (!known.has(meta)) steps[0]!.meta.push(meta);
    for (const group of Object.values(doc.groups).filter((g) => g.modelId === def.id))
      steps[0]!.meta.push(
        `0 // BRICKLOOP GROUP ${JSON.stringify({
          name: group.name,
          members: Object.values(def.instances)
            .filter((i) => i.groupId === group.id)
            .map((i) => i.id),
        })}`,
      );
    model.submodels.push({ fileName: names.get(def.id)!, steps });
  }
  if (Object.keys(doc.groups).length)
    report.degradations.push(
      issue('IO_GROUPS_AS_COMMENTS', undefined, String(Object.keys(doc.groups).length), 'warning'),
    );
  if (Object.keys(doc.extensions).some((k) => !['ldraw', 'studio'].includes(k)) || doc.catalogPack.id)
    report.omitted.push(issue('IO_PRIVATE_DATA_OMITTED', undefined, undefined, 'info'));
  return { model, instances };
}
export function exportLDraw(doc: BrkDocument, ctx: IoContext = {}): { text: string; report: IoReport } {
  const report = createReport();
  const { model } = exchangeModel(doc, ctx, report);
  return { text: writeModel(model), report };
}
export function attachEmbeddedPart(
  doc: BrkDocument,
  assets: ProjectAssets,
  fileName: string,
  bytes: Uint8Array,
  id = `cu:${fileName.replace(/\.dat$/i, '')}`,
): IoPart {
  const path = `assets/parts/${normalizeFileName(fileName)}`,
    hash = hashBytes(bytes);
  assets[path] = bytes;
  doc.embeddedParts[id] = { hash, path, fileName: normalizeFileName(fileName) };
  return { id, ldrawFile: normalizeFileName(fileName), geometry: { source: 'custom', ref: path, hash } };
}
