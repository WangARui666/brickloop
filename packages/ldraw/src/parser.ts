import type { ColourDefinition, EmbeddedData, LDrawFile, LDrawSubfile, Transform, Vec3 } from './types.js';

export function normalizeFileName(name: string): string {
  const normalized = name
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/')
    .replace(/^(\.\/)+/, '')
    .toLowerCase();
  if (!normalized || normalized.startsWith('/') || normalized.includes(':') || normalized.split('/').includes('..')) {
    throw new Error(`Invalid LDraw relative filename: ${name}`);
  }
  return normalized;
}

export function parseColour(value: string): ColourDefinition | undefined {
  const match = /^(\S+)\s+CODE\s+(\d+)\s+VALUE\s+(#|0x)([\da-f]{6})\s+EDGE\s+((?:#|0x)[\da-f]{6}|\d+)(.*)$/i.exec(
    value,
  );
  if (!match) return undefined;
  const tail = match[6]!.trim().split(/\s+/).filter(Boolean);
  let alpha = 255;
  let luminance = 0;
  const material: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const key = tail[i]!.toUpperCase();
    // MATERIAL parameters can contain ALPHA; those belong to the material, not the base colour.
    if (key === 'MATERIAL') {
      material.push(...tail.slice(i));
      break;
    }
    if (key === 'ALPHA' || key === 'LUMINANCE') {
      const n = Number(tail[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
      if (key === 'ALPHA') alpha = n;
      else luminance = n;
    } else material.push(tail[i]!);
  }
  const edge = match[5]!;
  return {
    code: Number(match[2]),
    name: match[1]!,
    value: `#${match[4]!.toUpperCase()}`,
    edge: /^(#|0x)/i.test(edge) ? `#${edge.replace(/^(#|0x)/i, '').toUpperCase()}` : Number(edge),
    alpha,
    luminance,
    material,
  };
}

function emptySubfile(fileName: string): LDrawSubfile {
  return {
    fileName: normalizeFileName(fileName),
    title: '',
    lines: [],
    meta: [],
    colours: [],
    category: '',
    keywords: [],
    ldrawOrg: '',
  };
}

/** Tolerant parser: bad operational lines are diagnosed and skipped, never partially consumed. */
export function parseLDraw(text: string, fileName: string): LDrawFile {
  const rawLines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const isMpd = rawLines.some((line) => /^\s*0\s+(FILE|!DATA)\s+\S/.test(line));
  const subfiles: LDrawSubfile[] = [];
  const data: EmbeddedData[] = [];
  const warnings: string[] = [];
  let current: LDrawSubfile | undefined = isMpd ? undefined : emptySubfile(fileName);
  let binary: EmbeddedData | undefined;
  if (current) subfiles.push(current);
  for (const [offset, raw] of rawLines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const warn = (message: string) => warnings.push(`${fileName}:${offset + 1}: ${message}`);
    const boundary = /^0\s+(FILE|!DATA)\s+(.+)$/.exec(line);
    if (boundary) {
      current = undefined;
      binary = undefined;
      try {
        if (boundary[1] === 'FILE') {
          current = emptySubfile(boundary[2]!);
          subfiles.push(current);
        } else {
          binary = { fileName: normalizeFileName(boundary[2]!), base64: '' };
          data.push(binary);
        }
      } catch (error) {
        warn(String(error));
      }
      continue;
    }
    if (/^0\s+NOFILE\s*$/.test(line)) {
      current = undefined;
      binary = undefined;
      continue;
    }
    if (binary) {
      const chunk = /^0\s+!:\s*([A-Za-z0-9+/]*={0,2})\s*$/.exec(line);
      if (chunk) binary.base64 += chunk[1];
      else warn('Invalid !DATA payload line');
      continue;
    }
    if (!current) continue;
    const tokens = line.match(/\S+/g)!;
    if (tokens[0] === '0') {
      const meta = /^0(?:\s+(\S+)(?:\s+(.*))?)?$/.exec(line)!;
      const command = meta[1] ?? '';
      const value = meta[2] ?? '';
      if (current.lines.length === 0 && command && !/^(BFC|STEP|!|Name:|Author:|\/\/)/.test(command)) {
        current.title = line.replace(/^0\s*/, '');
      }
      current.lines.push({ type: 0, raw, command, value });
      current.meta.push(raw);
      if (command === '!COLOUR') {
        const colour = parseColour(value);
        if (colour) current.colours.push(colour);
        else warn('Invalid !COLOUR definition');
      } else if (command === '!CATEGORY') current.category = value;
      else if (command === '!KEYWORDS')
        current.keywords.push(
          ...value
            .split(',')
            .map((word) => word.trim())
            .filter(Boolean),
        );
      else if (command === '!LDRAW_ORG') current.ldrawOrg = value;
      continue;
    }
    if (!/^[1-5]$/.test(tokens[0]!)) {
      warn(`Unknown line type ${tokens[0]}`);
      continue;
    }
    const type = Number(tokens[0]) as 1 | 2 | 3 | 4 | 5;
    const color = /^(\d+|0x[\da-f]+)$/i.test(tokens[1] ?? '') ? Number(tokens[1]) : NaN;
    const count = type === 1 ? 12 : type === 2 ? 6 : type === 3 ? 9 : 12;
    const numbers = tokens
      .slice(2, 2 + count)
      .map((token) => (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token) ? Number(token) : NaN));
    if (
      !Number.isSafeInteger(color) ||
      numbers.length !== count ||
      !numbers.every(Number.isFinite) ||
      (type === 1 ? tokens.length < 15 : tokens.length !== count + 2)
    ) {
      warn(`Invalid type-${type} line`);
      continue;
    }
    if (type === 1) {
      // Consume exactly 14 tokens; the filename remainder keeps its internal whitespace.
      const reference = /^(?:\S+\s+){14}(.+)$/.exec(line)![1]!;
      try {
        current.lines.push({ type, color, transform: numbers as Transform, fileName: normalizeFileName(reference) });
      } catch (error) {
        warn(String(error));
      }
    } else {
      const vertices: Vec3[] = [];
      for (let i = 0; i < count; i += 3) vertices.push([numbers[i]!, numbers[i + 1]!, numbers[i + 2]!]);
      current.lines.push({ type, color, vertices });
    }
  }
  const first = subfiles[0] ?? emptySubfile(fileName);
  if (subfiles.length === 0) subfiles.push(first);
  const names = new Set<string>();
  for (const file of subfiles) {
    if (names.has(file.fileName)) warnings.push(`Duplicate MPD file: ${file.fileName} (first definition wins)`);
    names.add(file.fileName);
  }
  return { ...first, isMpd, subfiles, data, warnings };
}
