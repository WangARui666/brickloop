import { fromLDraw, identity, multiply, transformPoint } from '@brickloop/core';
import type { Matrix4, Vec3 } from '@brickloop/core';
import { normalizeFileName, parseLDraw } from '@brickloop/ldraw';
import type { LDrawFile, LibraryResolver } from '@brickloop/ldraw';
import primitiveJson from '../../../library/connectors/primitive-map.json';
import type { Connector, ConnectorFile } from './types';
import { cloneConnector, transformConnector, segmentEnd } from './world';
import { add, compareText, distance, dot, norm, scale, sub, unit } from './vector';
import { ConnectorDataError, parseConnectorFile } from './data';

export interface PrimitiveMap {
  schema: 1;
  primitives: Record<string, Omit<Connector, 'id'>[]>;
}
export function parsePrimitiveMap(json: unknown): PrimitiveMap {
  const value: unknown = typeof json === 'string' ? JSON.parse(json) : json;
  if (
    !value ||
    typeof value !== 'object' ||
    !('schema' in value) ||
    value.schema !== 1 ||
    !('primitives' in value) ||
    !value.primitives ||
    typeof value.primitives !== 'object'
  )
    throw new Error('Invalid primitive map schema');
  const primitives: PrimitiveMap['primitives'] = {};
  for (const [name, templates] of Object.entries(value.primitives)) {
    if (!Array.isArray(templates)) throw new Error(`Invalid primitive map: ${name}`);
    const parsed = parseConnectorFile(
      {
        schema: 1,
        partId: 'ld:primitive',
        status: 'inferred',
        source: 'primitive-map',
        connectors: templates.map((t: unknown, i: number) => ({
          ...(typeof t === 'object' && t ? t : {}),
          id: String(i),
        })),
      },
      name,
    );
    if (!parsed.file) throw new ConnectorDataError(parsed.issues);
    primitives[normalizeFileName(name)] = parsed.file.connectors;
  }
  return { schema: 1, primitives };
}
export const DEFAULT_PRIMITIVE_MAP = parsePrimitiveMap(primitiveJson);
export interface InferenceOptions {
  primitiveMap?: PrimitiveMap;
  maxDepth?: number;
  partId?: string;
}
export class InferenceError extends Error {
  constructor(
    readonly path: readonly string[],
    message: string,
  ) {
    super(`${message}: ${path.join(' -> ')}`);
    this.name = 'InferenceError';
  }
}
/** A resolver-local parser cache, collectible with its resolver. No global part data. */
const caches = new WeakMap<object, Map<string, Promise<LDrawFile>>>();
export async function inferConnectors(
  partFile: string | LDrawFile,
  resolver: Pick<LibraryResolver, 'resolve'>,
  options: InferenceOptions = {},
): Promise<ConnectorFile> {
  let cache = caches.get(resolver);
  if (!cache) caches.set(resolver, (cache = new Map()));
  const load = (name: string): Promise<LDrawFile> => {
    const key = normalizeFileName(name);
    let value = cache!.get(key);
    if (!value) {
      value = resolver.resolve(key).then((found) => {
        if (!found) throw new InferenceError([key], 'Missing LDraw file');
        return parseLDraw(found.text, key);
      });
      cache!.set(key, value);
      void value.catch(() => cache!.delete(key));
    }
    return value;
  };
  const root = typeof partFile === 'string' ? await load(partFile) : partFile;
  const namespace = new Map(root.subfiles.map((f) => [normalizeFileName(f.fileName), f]));
  const mapping = (options.primitiveMap ?? DEFAULT_PRIMITIVE_MAP).primitives;
  const connectors: Connector[] = [],
    cavities: { matrix: Matrix4 }[] = [];
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const faces: [Vec3, Vec3, Vec3][] = [];
  const barCylinders: { start: Vec3; end: Vec3; radius: number; capped: boolean }[] = [];
  let title = root.title;
  const visit = async (
    file: Pick<LDrawFile, 'fileName' | 'lines' | 'title' | 'warnings'>,
    matrix: Matrix4,
    chain: string[],
    detect: boolean,
    inverted = false,
  ): Promise<void> => {
    const name = normalizeFileName(file.fileName);
    if (chain.includes(name)) throw new InferenceError([...chain, name], 'Cyclic reference');
    if (chain.length > (options.maxDepth ?? 64)) throw new InferenceError([...chain, name], 'Depth limit');
    if (file.warnings.length) throw new InferenceError([...chain, name], file.warnings.join('; '));
    if (/^~Moved to/.test(title) && !/^~Moved to/.test(file.title)) title = file.title;
    let invertNext = false;
    for (const line of file.lines) {
      if (line.type === 0 && line.raw.trim() === '0 BFC INVERTNEXT') invertNext = true;
      if (line.type === 1) {
        const childName = normalizeFileName(line.fileName),
          childMatrix = multiply(matrix, fromLDraw(line.transform));
        const mapped = detect ? mapping[childName.replace(/^(8|48)\//, '')] : undefined;
        if (mapped)
          for (const template of mapped) connectors.push(transformConnector({ id: '', ...template }, childMatrix));
        if (detect && childName === 'box5.dat') cavities.push({ matrix: childMatrix });
        // Only complete, outward-facing cylinders are candidates. Do not re-read
        // the side surface inside a capped cylinder as a separate collar.
        if (
          detect &&
          !inverted &&
          !invertNext &&
          !/4-4cyl[ic]\.dat$/.test(name) &&
          /^(?:8\/|48\/)?4-4cyl[ic]\.dat$/.test(childName)
        ) {
          const start = transformPoint(childMatrix, [0, 0, 0]);
          const x = sub(transformPoint(childMatrix, [1, 0, 0]), start);
          const y = sub(transformPoint(childMatrix, [0, 1, 0]), start);
          const z = sub(transformPoint(childMatrix, [0, 0, 1]), start);
          if (
            norm(y) > 0 &&
            Math.abs(norm(x) - norm(z)) < 1e-4 &&
            Math.abs(dot(x, y)) + Math.abs(dot(y, z)) + Math.abs(dot(x, z)) < 1e-4
          )
            barCylinders.push({ start, end: add(start, y), radius: norm(x), capped: childName.endsWith('cylc.dat') });
        }
        const embedded = namespace.get(childName);
        const child = embedded ? { ...embedded, warnings: [] } : await load(childName);
        await visit(child, childMatrix, [...chain, name], detect && !mapped, inverted !== invertNext);
        invertNext = false;
      } else if (line.type !== 0) {
        const vertices = (line.type === 5 ? line.vertices.slice(0, 2) : line.vertices).map((vertex) =>
          transformPoint(matrix, vertex),
        );
        if (line.type === 3 || line.type === 4) {
          faces.push([vertices[0]!, vertices[1]!, vertices[2]!]);
          if (line.type === 4) faces.push([vertices[0]!, vertices[2]!, vertices[3]!]);
        }
        for (const p of vertices) {
          for (let i = 0; i < 3; i++) {
            bounds[i] = Math.min(bounds[i]!, p[i]!);
            bounds[i + 3] = Math.max(bounds[i + 3]!, p[i]!);
          }
        }
      }
    }
  };
  await visit(root, identity(), [], true);
  // Stopped bars have two capped Ø8 shafts terminating at the two ends of
  // one coaxial wider collar. Each usable segment points away from its stop.
  // Requiring both shafts and the collar avoids inferring arbitrary tubes.
  if (/^Bar\s+\d.*\bwith (?:Thick )?Stop\b/i.test(title)) {
    const shafts = barCylinders.filter((s) => s.capped && Math.abs(s.radius - 4) < 1e-4);
    for (const collar of barCylinders.filter((s) => !s.capped && s.radius > 4)) {
      const collarAxis = unit(sub(collar.end, collar.start));
      const pair = [collar.start, collar.end].map((seat, i) => {
        const outward = scale(collarAxis, i === 0 ? -1 : 1);
        for (const shaft of shafts) {
          const tip =
            distance(shaft.start, seat) < 1e-4 ? shaft.end : distance(shaft.end, seat) < 1e-4 ? shaft.start : undefined;
          if (tip && distance(unit(sub(tip, seat)), outward) < 1e-4) return { seat, tip, outward };
        }
        return undefined;
      });
      if (pair.some((s) => !s)) continue;
      for (const s of pair)
        if (s) {
          const reference: Vec3 = Math.abs(s.outward[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
          connectors.push({
            id: 'bar',
            type: 'bar',
            frame: {
              origin: s.seat,
              axis: s.outward,
              ref: unit(sub(reference, scale(s.outward, dot(reference, s.outward)))),
            },
            length: distance(s.seat, s.tip),
            diameter: 8,
            stops: [0],
            ends: { start: 'closed', end: 'open' },
            rotation: 'free',
          });
        }
    }
  }
  // Open rectangular underside cavities provide a footprint independently of
  // top stud count (tiles/jumpers) and decorations protruding from the body.
  if (/^(?:Technic )?(?:Brick|Plate|Tile)\s+\d+\s*x\s*\d+/i.test(title) && !/Round|Quarter|Half Round/i.test(title)) {
    const grids: Connector[] = [];
    for (const { matrix: m } of cavities) {
      if (m[5]! >= 0 || Math.abs(m[1]!) + Math.abs(m[9]!) + Math.abs(m[4]!) + Math.abs(m[6]!) > 1e-5) continue;
      const corners = [
        [-1, 0, -1],
        [-1, 0, 1],
        [1, 0, -1],
        [1, 0, 1],
      ].map((p) => transformPoint(m, p as [number, number, number]));
      const minX = Math.min(...corners.map((p) => p[0])) - 4,
        maxX = Math.max(...corners.map((p) => p[0])) + 4;
      const minZ = Math.min(...corners.map((p) => p[2])) - 4,
        maxZ = Math.max(...corners.map((p) => p[2])) + 4;
      const cols = (maxX - minX) / 20,
        rows = (maxZ - minZ) / 20;
      if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) continue;
      grids.push({
        id: 'bottom',
        type: 'antistud',
        frame: { origin: [minX + 10, m[13]!, minZ + 10], axis: [0, 1, 0], ref: [1, 0, 0] },
        grid: { rows, cols, pitch: 20, mask: null },
        rotation: 90,
      });
    }
    // Simple unadorned and corner parts sometimes spell the cavity with faces
    // instead of box5. Project those faces to obtain an actual masked footprint.
    if (!grids.length && /^(?:Brick|Plate|Tile)\s+\d+\s*x\s*\d+(?:\s+Corner)?(?:\s+with Groove)?$/i.test(title)) {
      const cols = (bounds[3]! - bounds[0]!) / 20,
        rows = (bounds[5]! - bounds[2]!) / 20;
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        const origin: Vec3 = [bounds[0]! + 10, bounds[4]!, bounds[2]! + 10];
        const bodyFaces = faces.filter((f) => f.every((v) => v[1] >= -1e-6 && v[1] <= bounds[4]!));
        const mask = Array.from({ length: rows }, (_, r) =>
          Array.from({ length: cols }, (_, c) =>
            [-7, 7].every((dx) =>
              [-7, 7].every((dz) =>
                bodyFaces.some((f) => insideFootprint(origin[0] + c * 20 + dx, origin[2] + r * 20 + dz, f)),
              ),
            ),
          ),
        );
        if (mask.some((row) => row.some(Boolean)))
          grids.push({
            id: 'bottom',
            type: 'antistud',
            frame: { origin, axis: [0, 1, 0], ref: [1, 0, 0] },
            grid: { rows, cols, pitch: 20, mask: mask.every((row) => row.every(Boolean)) ? null : mask },
            rotation: 90,
          });
      }
    }
    for (const grid of grids) {
      const tube: [number, number][] = [];
      for (const c of connectors.filter(
        (c) => c.type === 'antistud.tube' && distance(c.frame.axis, [0, 1, 0]) < 1e-4,
      )) {
        const r = Math.floor((c.frame.origin[2] - grid.frame.origin[2]) / 20),
          col = Math.round((c.frame.origin[0] - grid.frame.origin[0]) / 20);
        if (r >= 0 && r < grid.grid!.rows && col >= 0 && col < grid.grid!.cols) tube.push([r, col]);
      }
      if (tube.length) grid.cells = { tube: tube.sort((a, b) => a[0] - b[0] || a[1] - b[1]) };
      connectors.push(grid);
    }
  }
  // A simple plain bar is a cylinder with no dedicated connection primitive.
  if (/^Bar\s+\d/i.test(title) && connectors.length === 0 && bounds.every(Number.isFinite)) {
    const spans = [0, 1, 2].map((i) => bounds[i + 3]! - bounds[i]!);
    const along = spans.indexOf(Math.max(...spans));
    const radial = spans.filter((_, i) => i !== along);
    if (radial.every((v) => Math.abs(v - 8) < 0.2)) {
      const origin = [0, 1, 2].map((i) => (i === along ? bounds[i]! : (bounds[i]! + bounds[i + 3]!) / 2)) as [
        number,
        number,
        number,
      ];
      const axis = [0, 0, 0] as [number, number, number];
      axis[along] = 1;
      connectors.push({
        id: 'bar',
        type: 'bar',
        frame: { origin, axis, ref: along === 0 ? [0, 1, 0] : [1, 0, 0] },
        length: spans[along]!,
        diameter: 8,
        ends: { start: 'open', end: 'open' },
        rotation: 'free',
      });
    }
  }
  const unique = [...new Map(connectors.map((c) => [JSON.stringify({ ...c, id: '' }), c])).values()];
  const packed = packStudGrids(mergeSegments(unique));
  packed.sort(
    (a, b) =>
      compareText(a.type, b.type) ||
      a.frame.origin[1] - b.frame.origin[1] ||
      a.frame.origin[2] - b.frame.origin[2] ||
      a.frame.origin[0] - b.frame.origin[0],
  );
  const counts = new Map<string, number>();
  for (const c of packed) {
    const prefix = c.type === 'antistud' ? 'bottom' : c.type === 'stud' || c.type === 'stud.hollow' ? 'top' : c.type;
    const count = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, count);
    c.id = count === 1 ? prefix : `${prefix}-${count}`;
    c.frame.origin = c.frame.origin.map((n) => Number(n.toFixed(6)) || 0) as [number, number, number];
  }
  return {
    schema: 1,
    partId: options.partId ?? `ld:${normalizeFileName(root.fileName).replace(/\.dat$/, '')}`,
    status: 'inferred',
    source: 'LDraw primitives + underside cavity footprint; Brickloop inference v1',
    connectors: packed,
  };
}
function insideFootprint(x: number, z: number, [a, b, c]: [Vec3, Vec3, Vec3]): boolean {
  const denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
  if (Math.abs(denominator) < 1e-9) return false;
  const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator;
  const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator;
  return u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8;
}
function mergeSegments(connectors: Connector[]): Connector[] {
  const result = connectors.map(cloneConnector);
  for (let i = 0; i < result.length; i++) {
    const a = result[i]!;
    if (!['bar', 'pin', 'axle'].includes(a.type) || !a.length) continue;
    let merged = true;
    while (merged) {
      merged = false;
      for (let j = 0; j < result.length; j++) {
        const b = result[j]!;
        if (
          i === j ||
          b.type !== a.type ||
          !b.length ||
          a.rotation !== b.rotation ||
          a.diameter !== b.diameter ||
          a.ends?.end === 'closed' ||
          b.ends?.start === 'closed'
        )
          continue;
        if (distance(a.frame.axis, b.frame.axis) > 1e-6 || distance(segmentEnd(a), b.frame.origin) > 1e-5) continue;
        if (a.stops || b.stops) a.stops = [...(a.stops ?? []), ...(b.stops ?? []).map((s) => s + a.length!)];
        a.length += b.length;
        a.ends = { start: a.ends?.start ?? 'open', end: b.ends?.end ?? 'open' };
        result.splice(j, 1);
        if (j < i) i--;
        merged = true;
        break;
      }
    }
  }
  return result;
}
function packStudGrids(connectors: Connector[]): Connector[] {
  const result: Connector[] = [],
    groups = new Map<string, Connector[]>();
  for (const c of connectors) {
    if (
      !['stud', 'stud.hollow'].includes(c.type) ||
      distance(c.frame.axis, [0, -1, 0]) > 1e-5 ||
      distance(c.frame.ref, [1, 0, 0]) > 1e-5
    ) {
      result.push(c);
      continue;
    }
    const key = JSON.stringify([c.type, c.frame.origin[1], c.diameter, c.length]);
    const group = groups.get(key) ?? [];
    group.push(c);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const first = group[0]!,
      minX = Math.min(...group.map((c) => c.frame.origin[0])),
      minZ = Math.min(...group.map((c) => c.frame.origin[2]));
    const cols = (Math.max(...group.map((c) => c.frame.origin[0])) - minX) / 20 + 1,
      rows = (Math.max(...group.map((c) => c.frame.origin[2])) - minZ) / 20 + 1;
    if (
      !Number.isInteger(rows) ||
      !Number.isInteger(cols) ||
      !group.every(
        (c) => Number.isInteger((c.frame.origin[0] - minX) / 20) && Number.isInteger((c.frame.origin[2] - minZ) / 20),
      )
    ) {
      result.push(...group);
      continue;
    }
    const mask = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));
    for (const c of group) mask[(c.frame.origin[2] - minZ) / 20]![(c.frame.origin[0] - minX) / 20] = true;
    const merged = cloneConnector(first);
    merged.frame.origin = [minX, first.frame.origin[1], minZ];
    merged.grid = { rows, cols, pitch: 20, mask: mask.every((row) => row.every(Boolean)) ? null : mask };
    merged.rotation = 90;
    result.push(merged);
  }
  return result;
}
