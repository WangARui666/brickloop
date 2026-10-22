import { CONNECTOR_TYPES } from './types';
import type { ConnectorFile, ConnectorIssue } from './types';

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vector = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(finite);
const fields = [
  'id',
  'type',
  'frame',
  'grid',
  'cells',
  'length',
  'ends',
  'stops',
  'diameter',
  'studDepth',
  'rotation',
  'size',
  'tag',
  'role',
  'limits',
];

/** Accepts JSON text or an untrusted object; never returns an empty success on failure. */
export function parseConnectorFile(
  json: unknown,
  fileName?: string,
): { file: ConnectorFile | null; issues: ConnectorIssue[] } {
  const issues: ConnectorIssue[] = [];
  const issue = (path: string, message: string): void => {
    issues.push({ path, message, ...(fileName ? { file: fileName } : {}) });
  };
  let value: unknown = json;
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json);
    } catch {
      issue('$', 'Invalid JSON');
      return { file: null, issues };
    }
  }
  const keys = (obj: Record<string, unknown>, allowed: string[], path: string): void => {
    for (const key of Object.keys(obj)) if (!allowed.includes(key)) issue(`${path}.${key}`, 'Unknown field');
  };
  if (!record(value)) {
    issue('$', 'Expected object');
    return { file: null, issues };
  }
  keys(value, ['schema', 'partId', 'status', 'source', 'connectors'], '$');
  if (value.schema !== 1) issue('$.schema', 'Expected schema 1');
  if (typeof value.partId !== 'string' || !/^(ld|cu):[^\\/:\s]+$/.test(value.partId))
    issue('$.partId', 'Expected ld: or cu: PartId');
  if (!['inferred', 'draft', 'reviewed'].includes(String(value.status))) issue('$.status', 'Unknown status');
  if (typeof value.source !== 'string' || !value.source.trim()) issue('$.source', 'Expected nonempty source');
  if (!Array.isArray(value.connectors)) issue('$.connectors', 'Expected array');
  else {
    const ids = new Set<string>();
    value.connectors.forEach((item: unknown, i: number) => {
      const p = `$.connectors[${i}]`;
      if (!record(item)) {
        issue(p, 'Expected connector object');
        return;
      }
      keys(item, fields, p);
      if (typeof item.id !== 'string' || !item.id.trim()) issue(`${p}.id`, 'Expected nonempty id');
      else {
        if (ids.has(item.id)) issue(`${p}.id`, 'Duplicate connector id');
        ids.add(item.id);
      }
      if (!(CONNECTOR_TYPES as readonly unknown[]).includes(item.type)) issue(`${p}.type`, 'Unknown connector type');
      if (!record(item.frame)) issue(`${p}.frame`, 'Expected frame');
      else {
        keys(item.frame, ['origin', 'axis', 'ref'], `${p}.frame`);
        for (const key of ['origin', 'axis', 'ref']) {
          const v = item.frame[key];
          if (!vector(v)) issue(`${p}.frame.${key}`, 'Expected 3 finite numbers');
          else if (key !== 'origin' && Math.abs(Math.hypot(...v) - 1) > 1e-5)
            issue(`${p}.frame.${key}`, 'Expected unit vector');
        }
        const { axis, ref } = item.frame;
        if (vector(axis) && vector(ref) && Math.abs(axis[0] * ref[0] + axis[1] * ref[1] + axis[2] * ref[2]) > 1e-5)
          issue(`${p}.frame.ref`, 'Must be orthogonal to axis');
      }
      for (const key of ['length', 'diameter', 'studDepth'])
        if (key in item && (!finite(item[key]) || item[key] <= 0))
          issue(`${p}.${key}`, 'Expected positive finite number');
      const linear = [
        'bar',
        'bar.post',
        'bar.hole',
        'clip',
        'axle',
        'axle.hole',
        'pin',
        'pin.hole',
        'bar.thin',
        'bar.thin.hole',
        'wheel.pin',
        'wheel.hole',
        'slider',
        'rail',
      ].includes(String(item.type));
      if (linear && item.length === undefined) issue(`${p}.length`, 'Linear connector requires length');
      if (
        item.rotation !== undefined &&
        item.rotation !== 'free' &&
        (!finite(item.rotation) || item.rotation <= 0 || item.rotation > 360)
      )
        issue(`${p}.rotation`, 'Expected free or step in (0,360]');
      if (item.role !== undefined && item.role !== 'a' && item.role !== 'b') issue(`${p}.role`, 'Expected a or b');
      for (const key of ['tag', 'size'])
        if (
          item[key] !== undefined &&
          !(typeof item[key] === 'string' && item[key].trim()) &&
          !(key === 'size' && finite(item[key]) && item[key] > 0)
        )
          issue(`${p}.${key}`, 'Expected nonempty label or positive size');
      if (
        ['ball', 'ball.socket', 'hinge.click', 'wheel.pin', 'wheel.hole'].includes(String(item.type)) &&
        item.size === undefined
      )
        issue(`${p}.size`, 'Size required');
      if (['hinge.click', 'fixed'].includes(String(item.type)) && item.role === undefined)
        issue(`${p}.role`, 'Complementary role required');
      if (item.type === 'fixed' && item.tag === undefined) issue(`${p}.tag`, 'Pairing tag required');
      if (item.ends !== undefined) {
        if (!record(item.ends)) issue(`${p}.ends`, 'Expected ends object');
        else {
          keys(item.ends, ['start', 'end'], `${p}.ends`);
          for (const end of ['start', 'end'])
            if (!['open', 'closed'].includes(String(item.ends[end])))
              issue(`${p}.ends.${end}`, 'Expected open or closed');
        }
      }
      if (item.stops !== undefined) {
        if (!Array.isArray(item.stops)) issue(`${p}.stops`, 'Expected array');
        else
          item.stops.forEach((s: unknown, j: number) => {
            if (!finite(s) || s < 0 || !finite(item.length) || s > item.length)
              issue(`${p}.stops[${j}]`, 'Stop must lie within length');
          });
      }
      if (
        item.limits !== undefined &&
        (!Array.isArray(item.limits) ||
          item.limits.length !== 2 ||
          !item.limits.every(finite) ||
          item.limits[0]! > item.limits[1]!)
      )
        issue(`${p}.limits`, 'Expected finite [min,max] with min <= max');
      if (item.grid !== undefined) {
        const g = item.grid;
        if (!record(g)) issue(`${p}.grid`, 'Expected grid');
        else {
          keys(g, ['rows', 'cols', 'pitch', 'mask'], `${p}.grid`);
          for (const key of ['rows', 'cols'])
            if (!finite(g[key]) || !Number.isSafeInteger(g[key]) || g[key] <= 0)
              issue(`${p}.grid.${key}`, 'Expected positive safe integer');
          if (!finite(g.pitch) || g.pitch <= 0) issue(`${p}.grid.pitch`, 'Expected positive finite pitch');
          if (
            g.mask !== null &&
            (!Array.isArray(g.mask) ||
              g.mask.length !== g.rows ||
              g.mask.some(
                (row: unknown) =>
                  !Array.isArray(row) || row.length !== g.cols || row.some((v: unknown) => typeof v !== 'boolean'),
              ))
          )
            issue(`${p}.grid.mask`, 'Expected null or rows × cols boolean mask');
        }
      }
      if (item.cells !== undefined) {
        if (!record(item.cells) || !record(item.grid)) issue(`${p}.cells`, 'Cells require grid and subtype map');
        else
          for (const [kind, cells] of Object.entries(item.cells)) {
            if (!['ordinary', 'tube'].includes(kind)) issue(`${p}.cells.${kind}`, 'Unknown cell subtype');
            if (!Array.isArray(cells)) issue(`${p}.cells.${kind}`, 'Expected cell list');
            else
              cells.forEach((cell: unknown, j: number) => {
                const g = item.grid as Record<string, unknown>;
                if (
                  !Array.isArray(cell) ||
                  cell.length !== 2 ||
                  !cell.every((n: unknown) => finite(n) && Number.isSafeInteger(n) && n >= 0) ||
                  !finite(g.rows) ||
                  !finite(g.cols) ||
                  cell[0] >= g.rows ||
                  cell[1] >= g.cols
                )
                  issue(`${p}.cells.${kind}[${j}]`, 'Cell outside grid');
              });
          }
      }
    });
  }
  // This cast is the boundary after complete structural validation above.
  return { file: issues.length ? null : (JSON.parse(JSON.stringify(value)) as ConnectorFile), issues };
}
export class ConnectorDataError extends Error {
  constructor(readonly issues: ConnectorIssue[]) {
    super(issues.map((i) => `${i.file ?? ''}${i.path}: ${i.message}`).join('\n'));
    this.name = 'ConnectorDataError';
  }
}
export function writeConnectorFile(file: ConnectorFile): string {
  const parsed = parseConnectorFile(file);
  if (!parsed.file) throw new ConnectorDataError(parsed.issues);
  return JSON.stringify(parsed.file, null, 2) + '\n';
}
export async function readConnectorFile(
  fileName: string,
  read: (name: string) => Promise<string>,
): Promise<ConnectorFile> {
  let json: string;
  try {
    json = await read(fileName);
  } catch (error) {
    throw new ConnectorDataError([{ file: fileName, path: '$', message: String(error) }]);
  }
  const result = parseConnectorFile(json, fileName);
  if (!result.file) throw new ConnectorDataError(result.issues);
  return result.file;
}
