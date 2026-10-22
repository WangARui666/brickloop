import { normalizeSearch, pinyinKeywords } from './terms-zh';
import { sha256 } from './catalog-index';
import type { CatalogIndex, Category, ColorDef, ColorId, FactoryPartInfo, Pack, PartDef, PartId } from './types';

export interface SearchOptions {
  includeAll?: boolean;
  limit?: number;
  categoryId?: string;
}
export interface DocumentReference {
  partId: PartId;
  colorId: ColorId | 'inherit';
}
export type DocumentReferences =
  | readonly DocumentReference[]
  | {
      partIds?: readonly PartId[];
      colorIds?: readonly ColorId[];
      instances?: readonly DocumentReference[];
    };
export interface PackImpact {
  nonFactoryParts: PartId[];
  nonFactoryColors: ColorId[];
  unavailableColors: { partId: PartId; colorId: ColorId }[];
}
interface SearchEntry {
  part: PartDef;
  numbers: string[];
  names: string[];
  keywords: string;
  text: string;
  factory: boolean;
}

function isActive(part: FactoryPartInfo | undefined): boolean {
  return !!part && part.status !== 'discontinued';
}
function subsequence(query: string, text: string): boolean {
  let position = 0;
  for (const letter of query) {
    position = text.indexOf(letter, position);
    if (position < 0) return false;
    position++;
  }
  return true;
}

export class CatalogService {
  private readonly byId: Map<PartId, PartDef>;
  private readonly factories: Map<PartId, FactoryPartInfo>;
  private readonly colorMap: Map<ColorId, ColorDef>;
  private readonly factoryColorIds: Set<ColorId>;
  private readonly entries: SearchEntry[];
  readonly categories: Category[];

  constructor(
    readonly catalog: CatalogIndex,
    colors: readonly ColorDef[],
    readonly pack: Pack,
  ) {
    this.factories = new Map(pack.parts.map((part) => [part.partId, part]));
    this.byId = new Map(catalog.parts.map((part) => [part.id, part]));
    this.colorMap = new Map(colors.map((color) => [color.id, color]));
    this.factoryColorIds = new Set(pack.colors.map((color) => color.colorId));
    for (const color of pack.colors) this.colorMap.set(color.colorId, { ...color.definition, rgb: color.measuredRgb });
    for (const info of pack.parts) {
      const base = this.byId.get(info.partId);
      const part: PartDef = base ?? {
        id: info.partId,
        legoNo: info.legoNo,
        ldrawFile: info.ldrawFile,
        nameZh: info.factoryName ?? info.factoryNo,
        nameEn: info.factoryName ?? info.factoryNo,
        categoryId: info.categoryId ?? 'custom',
        keywords: [],
        bboxLdu: null,
        connectorsRef: null,
        geometry: {
          source: 'custom',
          ref: info.ldrawFile ? `custom/${info.ldrawFile}` : `custom/${info.customCode}.dat`,
          hash:
            info.ldrawFile && pack.assets[`custom/${info.ldrawFile}`]
              ? sha256(pack.assets[`custom/${info.ldrawFile}`]!)
              : '',
        },
      };
      this.byId.set(part.id, {
        ...part,
        nameZh: info.factoryName || part.nameZh,
        categoryId: info.categoryId ?? part.categoryId,
      });
    }
    this.categories = pack.categories.length ? [...pack.categories] : [...catalog.categories];
    const aliasesByTarget = new Map<PartId, string[]>();
    for (const [alias, target] of Object.entries(catalog.aliases)) {
      const aliases = aliasesByTarget.get(target) ?? [];
      aliases.push(alias.slice(3));
      aliasesByTarget.set(target, aliases);
    }
    this.entries = [...this.byId.values()].map((part) => {
      const info = this.factories.get(part.id);
      const numbers = [
        part.legoNo ?? '',
        part.id,
        part.id.slice(3),
        info?.factoryNo ?? '',
        ...(aliasesByTarget.get(part.id) ?? []),
      ]
        .filter(Boolean)
        .map(normalizeSearch);
      const names = [part.nameZh, part.nameEn, ...pinyinKeywords(part.nameZh)].map(normalizeSearch);
      const keywords = normalizeSearch(part.keywords.join(' '));
      return {
        part,
        numbers,
        names,
        keywords,
        text: [...numbers, ...names, keywords].join('\n'),
        factory: isActive(info),
      };
    });
  }

  getPart(id: PartId): PartDef | undefined {
    return this.byId.get(this.catalog.aliases[id] ?? id);
  }
  getColor(id: ColorId): ColorDef | undefined {
    return this.colorMap.get(id);
  }
  factoryInfo(id: PartId): FactoryPartInfo | undefined {
    return this.factories.get(this.catalog.aliases[id] ?? id);
  }
  isFactoryPart(id: PartId): boolean {
    return isActive(this.factoryInfo(id));
  }
  isFactoryColor(id: ColorId): boolean {
    return this.factoryColorIds.has(id);
  }
  availableColors(id: PartId): ColorDef[] {
    if (!this.isFactoryPart(id)) return [];
    return (this.factoryInfo(id)?.colors ?? []).flatMap((colorId) => {
      const definition = this.colorMap.get(colorId);
      return definition && this.isFactoryColor(colorId) ? [definition] : [];
    });
  }

  search(query: string, options: SearchOptions = {}): PartDef[] {
    const normalized = normalizeSearch(query);
    const tokens = normalized.split(' ').filter(Boolean);
    const matches: { part: PartDef; score: number }[] = [];
    for (const entry of this.entries) {
      if (!options.includeAll && !entry.factory) continue;
      if (options.categoryId && entry.part.categoryId !== options.categoryId) continue;
      let fuzzy = false;
      let found = true;
      for (const token of tokens) {
        if (entry.text.includes(token)) continue;
        if (
          token.length >= 3 &&
          token.length <= 24 &&
          entry.names.some((name) => subsequence(token, name.slice(0, 64)))
        )
          fuzzy = true;
        else {
          found = false;
          break;
        }
      }
      if (!found) continue;
      const score = !normalized
        ? 0
        : entry.numbers.includes(normalized)
          ? 400
          : entry.names.some((name) => name.startsWith(normalized))
            ? 300
            : !fuzzy && tokens.every((token) => entry.keywords.includes(token))
              ? 200
              : 100;
      matches.push({ part: entry.part, score });
    }
    matches.sort((a, b) => b.score - a.score || (a.part.id < b.part.id ? -1 : a.part.id > b.part.id ? 1 : 0));
    return matches.slice(0, options.limit ?? 100).map((match) => match.part);
  }

  impactOf(references: DocumentReferences, oldPack: Pack, newPack: Pack): PackImpact {
    return impactOf(references, oldPack, newPack);
  }
}

export function impactOf(references: DocumentReferences, oldPack: Pack, newPack: Pack): PackImpact {
  const structured = references as Exclude<DocumentReferences, readonly DocumentReference[]>;
  const instances: readonly DocumentReference[] = Array.isArray(references) ? references : (structured.instances ?? []);
  const partIds = new Set<PartId>([...(structured.partIds ?? []), ...instances.map((ref) => ref.partId)]);
  const colorIds = new Set<ColorId>([
    ...(structured.colorIds ?? []),
    ...instances.flatMap((ref) => (ref.colorId === 'inherit' ? [] : [ref.colorId])),
  ]);
  const oldParts = new Map(oldPack.parts.map((part) => [part.partId, part]));
  const newParts = new Map(newPack.parts.map((part) => [part.partId, part]));
  const oldColors = new Set(oldPack.colors.map((color) => color.colorId));
  const newColors = new Set(newPack.colors.map((color) => color.colorId));
  const available = (parts: typeof oldParts, colors: Set<ColorId>, ref: DocumentReference) =>
    isActive(parts.get(ref.partId)) &&
    ref.colorId !== 'inherit' &&
    colors.has(ref.colorId) &&
    !!parts.get(ref.partId)?.colors.includes(ref.colorId);
  const seen = new Set<string>();
  return {
    nonFactoryParts: [...partIds].filter((id) => isActive(oldParts.get(id)) && !isActive(newParts.get(id))),
    nonFactoryColors: [...colorIds].filter((id) => oldColors.has(id) && !newColors.has(id)),
    unavailableColors: instances.flatMap((ref) => {
      const key = `${ref.partId}/${ref.colorId}`;
      if (
        ref.colorId === 'inherit' ||
        seen.has(key) ||
        !available(oldParts, oldColors, ref) ||
        available(newParts, newColors, ref)
      )
        return [];
      seen.add(key);
      return [{ partId: ref.partId, colorId: ref.colorId }];
    }),
  };
}
