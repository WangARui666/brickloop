import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLDrawHeader, partIdFromFile, printedBase } from './ldraw-headers';
import { pinyinKeywords, translateTitle } from './terms-zh';
import type { CatalogIndex, Category, PartDef, PartId } from './types';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const defaultLibraryDir = path.join(repositoryRoot, 'library/ldraw');
export const defaultCacheDir = path.join(repositoryRoot, '.devdata/cache/catalog');
const INDEX_REVISION = 'headers-zh-3';
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
export function categoryId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-');
}

export function createCatalogIndex(
  records: { file: string; source: string }[],
  libraryVersion = 'fixture',
): CatalogIndex {
  const parts: PartDef[] = [];
  const categoryNames = new Set<string>();
  const aliases: Record<string, PartId> = {};
  const legoNumbers: Record<string, PartId[]> = Object.create(null) as Record<string, PartId[]>;
  const addMapping = (number: string, id: PartId) => {
    const ids = (legoNumbers[number.toLowerCase()] ??= []);
    if (!ids.includes(id)) ids.push(id);
  };
  for (const { file, source } of [...records].sort((a, b) => a.file.localeCompare(b.file, 'en'))) {
    const header = parseLDrawHeader(source);
    if (header.alias && header.aliasTarget && !/[\\/]/.test(header.aliasTarget)) {
      aliases[partIdFromFile(file)] = partIdFromFile(header.aliasTarget);
    }
    if (header.excluded || header.alias || !header.title || /[\\/]/.test(file)) continue;
    const number = file.replace(/\.dat$/i, '').toLowerCase();
    const id = partIdFromFile(file);
    const category = header.category ?? header.title.replace(/^[_=]+/, '').split(/\s+/)[0]!;
    categoryNames.add(category);
    const nameZh = translateTitle(header.title);
    const baseOf = printedBase(file);
    const flags: NonNullable<PartDef['flags']> = [];
    if (baseOf) flags.push('printed');
    if (/\bSticker\b/i.test(header.title)) flags.push('sticker');
    if (/\bFlexible\b/i.test(header.title)) flags.push('flexible');
    if (/\bMinifig\b/i.test(header.title)) flags.push('minifig');
    if (/\b(Assembly|Shortcut)\b/i.test(`${header.title} ${header.organization}`)) flags.push('assembly');
    parts.push({
      id,
      legoNo: number,
      ldrawFile: file.toLowerCase(),
      nameZh,
      nameEn: header.title,
      categoryId: categoryId(category),
      keywords: [...header.keywords, ...pinyinKeywords(nameZh)],
      bboxLdu: null,
      geometry: { source: 'ldraw', ref: file.toLowerCase(), hash: sha256(source) },
      connectorsRef: null,
      ...(baseOf ? { baseOf } : {}),
      ...(flags.length ? { flags } : {}),
    });
    addMapping(number, id);
    for (const legoNo of header.legoIds) addMapping(legoNo, id);
    // Letter suffixes denote mold variants; printed suffixes remain separate designs.
    if (!baseOf && /^\d+[a-z]+$/.test(number)) addMapping(number.replace(/[a-z]+$/, ''), id);
  }
  const byId = new Map(parts.map((part) => [part.id, part]));
  for (const [alias, target] of Object.entries(aliases)) {
    let resolved = target;
    const visited = new Set([alias]);
    while (aliases[resolved] && !visited.has(resolved)) {
      visited.add(resolved);
      resolved = aliases[resolved]!;
    }
    if (byId.has(resolved)) {
      aliases[alias] = resolved;
      addMapping(alias.slice(3), resolved);
    } else delete aliases[alias];
  }
  for (const ids of Object.values(legoNumbers)) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      const part = byId.get(id)!;
      part.alternates = [...new Set([...(part.alternates ?? []), ...ids.filter((other) => other !== id)])].sort();
    }
  }
  const categories: Category[] = [...categoryNames].sort().map((nameEn, order) => ({
    id: categoryId(nameEn),
    nameEn,
    nameZh: translateTitle(nameEn),
    parentId: null,
    order,
  }));
  // Explicit category names such as "Technic Axle" retain the source category and get a parent.
  for (const category of [...categories]) {
    if (!category.nameEn.includes(' ')) continue;
    const parentName = category.nameEn.split(' ')[0]!;
    const parentId = categoryId(parentName);
    if (!categories.some((entry) => entry.id === parentId))
      categories.push({
        id: parentId,
        nameEn: parentName,
        nameZh: translateTitle(parentName),
        parentId: null,
        order: categories.length,
      });
    category.parentId = parentId;
  }
  return { schemaVersion: 1, libraryVersion, parts, categories, aliases, legoNumbers };
}

export function matchLegoNumber(index: CatalogIndex, number: string): PartId[] {
  const key = number
    .trim()
    .replace(/\.dat$/i, '')
    .toLowerCase();
  return Object.hasOwn(index.legoNumbers, key) ? [...index.legoNumbers[key]!] : [];
}

export async function buildCatalogIndex(
  options: { libraryDir?: string; cacheDir?: string; force?: boolean; libraryVersion?: string } = {},
): Promise<CatalogIndex> {
  const libraryDir = options.libraryDir ?? defaultLibraryDir;
  const cacheDir = options.cacheDir ?? defaultCacheDir;
  let config: string;
  try {
    config = await readFile(path.join(libraryDir, 'LDConfig.ldr'), 'utf8');
  } catch {
    throw new Error('找不到 LDraw 零件库，请先运行 pnpm ldraw:fetch（M1-1 提供）。');
  }
  const directory = path.join(libraryDir, 'parts');
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((file) => file.isFile() && /\.dat$/i.test(file.name))
    .map((file) => file.name)
    .sort();
  // Metadata fingerprint also detects partial library updates even if LDConfig is unchanged.
  const metadata: string[] = [];
  for (let offset = 0; offset < files.length; offset += 128) {
    metadata.push(
      ...(await Promise.all(
        files.slice(offset, offset + 128).map(async (file) => {
          const entry = await stat(path.join(directory, file));
          return `${file}:${entry.size}:${entry.mtimeMs}`;
        }),
      )),
    );
  }
  const label = options.libraryVersion ?? /Configuration\s+UPDATE\s+(\S+)/.exec(config)?.[1] ?? 'unversioned';
  const version = `${label.replace(/[^a-zA-Z0-9._-]/g, '-')}-${sha256(config + metadata.join('\n') + INDEX_REVISION).slice(0, 16)}`;
  const cacheFile = path.join(cacheDir, `${version}.json`);
  if (!options.force) {
    try {
      const cached: CatalogIndex = JSON.parse(await readFile(cacheFile, 'utf8')) as CatalogIndex;
      if (
        cached.schemaVersion === 1 &&
        cached.libraryVersion === version &&
        Array.isArray(cached.parts) &&
        cached.legoNumbers &&
        cached.aliases
      )
        return cached;
    } catch {
      /* Missing or interrupted cache is rebuilt from the library. */
    }
  }
  const records: { file: string; source: string }[] = [];
  for (let offset = 0; offset < files.length; offset += 64) {
    records.push(
      ...(await Promise.all(
        files
          .slice(offset, offset + 64)
          .map(async (file) => ({ file, source: await readFile(path.join(directory, file), 'utf8') })),
      )),
    );
  }
  const index = createCatalogIndex(records, version);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(index));
  return index;
}
