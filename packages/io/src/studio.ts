import { isRecord, normalizeForSave, orderedInstances, ulid, validateDocument } from '@brickloop/core';
import type { BrkDocument, Instance, Workspace } from '@brickloop/core';
import { normalizeFileName, writeModel } from '@brickloop/ldraw';
import { hashBytes, readZip, text, utf8, writeZip } from './binary';
import type { ProjectAssets } from './binary';
import { attachEmbeddedPart, exchangeModel, importLDraw } from './exchange';
import type { ImportResult, IoContext, IoPart } from './exchange';
import { createReport, issue } from './issues';
import type { IoReport } from './issues';

export const STUDIO_INFO_VERSION = '2.25.11_3';
export const STUDIO_PARTS_DB_VERSION = 200;
export interface StudioContext extends IoContext {
  version?: string;
  partsDbVersion?: number;
}
interface StudioInstance {
  uid: string;
  hidden: boolean;
  originalTransform: number[];
  normalizedTransform: number[];
}
function studioInstance(instance: Instance): Partial<StudioInstance> {
  return isRecord(instance.extensions) && isRecord(instance.extensions.studio) ? instance.extensions.studio : {};
}
function convertStudioLines(source: string): {
  text: string;
  ids: Map<string, { uid: string; hidden: boolean }[]>;
  omitted: string[];
} {
  const ids = new Map<string, { uid: string; hidden: boolean }[]>();
  let file = 'model.ldr';
  const omitted: string[] = [];
  const lines = source
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const boundary = /^\s*0\s+FILE\s+(.+)$/i.exec(line);
      if (boundary) file = normalizeFileName(boundary[1]!);
      if (/^\s*0\s+(?:Flexible\S*|!FLEX\b)/i.test(line)) {
        omitted.push(line);
        return '';
      }
      if (/^\s*11\s/.test(line)) {
        const match = /^\s*11\s+(\S+)\s+(\S+)\s+(True|False)\s+0\s+((?:\S+\s+){12})(.+)$/i.exec(line);
        if (!match) throw new Error(`Invalid type 11: ${line}`);
        const list = ids.get(file) ?? [];
        list.push({ uid: match[2]!, hidden: match[3]!.toLowerCase() === 'true' });
        ids.set(file, list);
        return `1 ${match[1]} ${match[4]}${match[5]}`;
      }
      if (/^\s*1\s/.test(line)) {
        const list = ids.get(file) ?? [];
        list.push({ uid: '', hidden: false });
        ids.set(file, list);
      }
      return line;
    });
  return { text: lines.join('\n'), ids, omitted };
}
export function importIo(bytes: Uint8Array, ctx: IoContext = {}, fileName?: string): ImportResult {
  const archive = readZip(bytes);
  const empty = (): ImportResult => ({
    ...importLDraw('0 Empty', 'empty.ldr', ctx),
    doc: null,
    report: createReport(),
  });
  if (archive.issues.some((i) => i.code === 'IO_ENCRYPTED_UNSUPPORTED')) {
    const result = empty();
    result.report.errors.push(...archive.issues);
    return result;
  }
  const members = archive.members;
  const embedded: { file: string; bytes: Uint8Array; part: IoPart }[] = [];
  for (const [name, payload] of Object.entries(members)) {
    const match = /^(?:CustomParts\/)?((?:p\/|s\/).*\.dat)$|^CustomParts\/(.+\.dat)$/i.exec(name);
    if (match) {
      const file = normalizeFileName(match[1] ?? match[2]!);
      embedded.push({ file, bytes: payload, part: { id: `cu:${file.replace(/\.dat$/i, '')}`, ldrawFile: file } });
    }
  }
  let result = empty();
  const fallbacks: string[] = [];
  for (const name of ['modelv2.ldr', 'modelv1.ldr', 'model.ldr']) {
    if (!members[name]) continue;
    try {
      if (archive.issues.some((i) => i.file === name && i.severity === 'error'))
        throw new Error('Corrupt model member');
      const converted = convertStudioLines(text(members[name]));
      const candidate = importLDraw(converted.text, 'model.ldr', {
        ...ctx,
        parts: [...(ctx.parts ?? []), ...embedded.map((e) => e.part)],
      });
      if (!candidate.doc || candidate.report.warnings.some((i) => i.code === 'IO_PARSE_WARNING'))
        throw new Error('Invalid model lines');
      result = candidate;
      for (const def of Object.values(result.doc!.models)) {
        const list = converted.ids.get(normalizeFileName(def.name)) ?? [];
        for (const [index, instance] of orderedInstances(def).entries()) {
          const external = list[index];
          if (external)
            instance.extensions = {
              studio: {
                ...external,
                originalTransform: [...instance.transform],
                normalizedTransform: normalizeForSave(instance.transform),
              },
            };
        }
      }
      if (converted.omitted.length)
        result.report.omitted.push(
          issue('IO_STUDIO_DATA_OMITTED', name, `Flexible parameters: ${converted.omitted.length}`, 'info'),
        );
      break;
    } catch (error) {
      fallbacks.push(`${name}: ${String(error)}`);
    }
  }
  if (fallbacks.length)
    result.report.warnings.push(issue('IO_MODEL_FALLBACK', undefined, fallbacks.join('; '), 'warning'));
  result.report.warnings.push(...archive.issues.filter((i) => i.code !== 'ZIP_INVALID'));
  if (!result.doc) {
    result.report.errors.push(issue('IO_MODEL_MISSING'));
    result.report.errors.push(...archive.issues);
    return result;
  }
  const doc = result.doc;
  if (fileName !== undefined) doc.meta.title = fileName;
  for (const item of embedded) attachEmbeddedPart(doc, result.assets, item.file, item.bytes, item.part.id);
  for (const [name, payload] of Object.entries(members)) {
    if (/^ReferenceImages\//i.test(name)) {
      const hash = hashBytes(payload),
        path = `assets/images/${hash}`;
      result.assets[path] = payload;
      doc.referenceImages[ulid()] = { hash, path, fileName: name };
      result.report.warnings.push(issue('IO_REFERENCE_IMAGE', name, undefined, 'info'));
    } else if (name === 'referenceImages.json') {
      try {
        doc.extensions.studio = { referenceImages: JSON.parse(text(payload)) as unknown };
      } catch {
        result.report.warnings.push(issue('IO_PARSE_WARNING', name, undefined, 'warning'));
      }
    } else if (/^(model\.ins|model2\.ldr|model\.lxfml)$|^CustomParts\/(connectivity|collider)\//i.test(name))
      result.report.omitted.push(issue('IO_STUDIO_DATA_OMITTED', name, undefined, 'info'));
  }
  function visit(modelId: string, path: string[], depth: number): void {
    if (depth > 64) throw new Error('Model depth exceeds 64');
    for (const instance of orderedInstances(doc.models[modelId]!)) {
      const here = [...path, instance.id];
      if (studioInstance(instance).hidden) result.workspace.hidden.push(here);
      if (instance.ref.kind === 'model') visit(instance.ref.modelId, here, depth + 1);
    }
  }
  try {
    visit(doc.rootModelId, [], 0);
  } catch (error) {
    result.report.errors.push(issue('IO_MODEL_INVALID', undefined, String(error)));
    result.doc = null;
  }
  return result;
}
function uidMap(instances: Instance[], report: IoReport): Map<string, string> {
  const result = new Map<string, string>(),
    used = new Set<string>();
  for (const instance of instances) {
    const uid = studioInstance(instance).uid;
    if (uid && /^\d+$/.test(uid) && Number(uid) <= 2147483647 && !used.has(String(Number(uid)))) {
      result.set(instance.id, uid);
      used.add(String(Number(uid)));
    } else if (uid) report.warnings.push(issue('IO_UID_REASSIGNED', undefined, instance.id, 'warning'));
  }
  for (const instance of [...instances].sort((a, b) => a.id.localeCompare(b.id)))
    if (!result.has(instance.id)) {
      let uid = parseInt(hashBytes(utf8(instance.id)).slice(0, 8), 16) & 0x7fffffff || 1;
      while (used.has(String(uid))) uid = uid === 2147483647 ? 1 : uid + 1;
      result.set(instance.id, String(uid));
      used.add(String(uid));
    }
  return result;
}
function hiddenIds(doc: BrkDocument, workspace: Workspace | undefined, report: IoReport): Set<string> {
  if (!workspace)
    return new Set(
      Object.values(doc.models).flatMap((m) =>
        Object.values(m.instances)
          .filter((i) => studioInstance(i).hidden)
          .map((i) => i.id),
      ),
    );
  const counts = new Map<string, { total: number; hidden: number }>();
  const hidden = new Set(workspace.hidden.map((p) => JSON.stringify(p)));
  function walk(modelId: string, path: string[]): void {
    for (const i of orderedInstances(doc.models[modelId]!)) {
      const here = [...path, i.id],
        entry = counts.get(i.id) ?? { total: 0, hidden: 0 };
      entry.total++;
      if (hidden.has(JSON.stringify(here))) entry.hidden++;
      counts.set(i.id, entry);
      if (i.ref.kind === 'model') walk(i.ref.modelId, here);
    }
  }
  walk(doc.rootModelId, []);
  for (const [id, count] of counts)
    if (count.hidden > 0 && count.hidden < count.total)
      report.degradations.push(issue('IO_HIDDEN_DOWNGRADE', undefined, id, 'warning'));
  return new Set([...counts].filter(([, c]) => c.hidden === c.total).map(([id]) => id));
}
export function exportIo(doc: BrkDocument, ctx: StudioContext = {}): { bytes: Uint8Array; report: IoReport } {
  const report = createReport();
  const { model, instances } = exchangeModel(doc, ctx, report);
  const uids = uidMap(instances, report),
    hidden = hiddenIds(doc, ctx.workspace, report);
  let index = 0;
  // writeModel owns MPD/meta/STEP layout. Replace only reference rows to avoid its 4-decimal translation normalization.
  const standard = writeModel(model)
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith('1 ')) return line;
      const instance = instances[index++]!;
      const ext = studioInstance(instance);
      const same = (saved: number[] | undefined) =>
        saved?.length === instance.transform.length &&
        saved.every((n, i) => Math.abs(n - instance.transform[i]!) < 1e-12);
      const unchanged = same(ext.originalTransform) || same(ext.normalizedTransform);
      const transform = unchanged && ext.originalTransform ? ext.originalTransform : instance.transform;
      const numbers = transform.map((n, i) => (i < 3 && !unchanged ? Math.round(n * 1e5) / 1e5 : n).toFixed(6));
      const match = /^1 (\S+) (?:\S+ ){12}(.+)$/.exec(line)!;
      return `1 ${match[1]} ${numbers.join(' ')} ${match[2]}`;
    })
    .join('\r\n');
  index = 0;
  const extended = standard
    .split('\r\n')
    .map((line) => {
      if (!line.startsWith('1 ')) return line;
      const instance = instances[index++]!;
      return line.replace(
        /^1 (\S+) /,
        `11 $1 ${uids.get(instance.id)} ${hidden.has(instance.id) ? 'True' : 'False'} 0 `,
      );
    })
    .join('\r\n');
  const members: ProjectAssets = {
    'model.ldr': utf8(standard),
    'modelv2.ldr': utf8(extended),
    '.info': utf8(
      JSON.stringify({
        version: ctx.version ?? STUDIO_INFO_VERSION,
        total_parts: report.counts.parts,
        parts_db_version: ctx.partsDbVersion ?? STUDIO_PARTS_DB_VERSION,
      }),
    ),
    'errorPartList.err': utf8('[]'),
  };
  if (ctx.thumbnail) members['thumbnail.png'] = ctx.thumbnail;
  const assets = ctx.assets ?? {};
  for (const [path, bytes] of Object.entries(assets))
    if (path.startsWith('assets/parts/')) members[`CustomParts/${path.slice('assets/parts/'.length)}`] = bytes;
  const referenced = new Set(instances.flatMap((i) => (i.ref.kind === 'part' ? [i.ref.partId] : [])));
  for (const id of referenced) {
    const part = ctx.parts?.find((p) => p.id === id),
      embedded = doc.embeddedParts[id];
    const file = part?.ldrawFile ?? (typeof embedded?.fileName === 'string' ? embedded.fileName : `${id.slice(3)}.dat`);
    const path = typeof embedded?.path === 'string' ? embedded.path : part?.geometry?.ref;
    if (path && assets[path]) members[`CustomParts/${normalizeFileName(file)}`] = assets[path];
    if (id.startsWith('cu:') && !members[`CustomParts/${normalizeFileName(file)}`])
      report.errors.push(issue('IO_PART_GEOMETRY_MISSING', file, id));
  }
  for (const image of Object.values(doc.referenceImages))
    if (typeof image.path === 'string' && assets[image.path]) {
      const name =
        typeof image.fileName === 'string' && image.fileName.startsWith('ReferenceImages/')
          ? image.fileName
          : `ReferenceImages/${image.hash}.png`;
      members[name] = assets[image.path]!;
    }
  if (isRecord(doc.extensions.studio) && doc.extensions.studio.referenceImages !== undefined)
    members['referenceImages.json'] = utf8(JSON.stringify(doc.extensions.studio.referenceImages));
  if (validateDocument(doc).some((i) => i.severity === 'error')) throw new Error('IO_MODEL_INVALID');
  return { bytes: writeZip(members), report };
}
