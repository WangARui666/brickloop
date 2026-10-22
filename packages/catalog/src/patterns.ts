import { normalizeSearch } from './terms-zh';
import type { CatalogIndex, PartDef, PartId } from './types';

export const PATTERN_GROUP_IDS = ['faces', 'torsos', 'legs', 'screens', 'texts', 'controls', 'symbols'] as const;
export type PatternGroupId = (typeof PATTERN_GROUP_IDS)[number];
export interface PatternRule {
  groupId: PatternGroupId;
  /** Empty means any base. Otherwise both base and title conditions must match. */
  baseIds: PartId[];
  /** Case-insensitive whole words/phrases in the English title; empty means any title. */
  include: string[];
  exclude: string[];
  whitelist: PartId[];
  blacklist: PartId[];
}
export interface PatternRules {
  version: 1;
  /** Increment when the curated rules change, independently of the schema version. */
  revision: number;
  groups: PatternRule[];
}
export interface PatternGroup {
  groupId: PatternGroupId;
  parts: PartId[];
}

function phrase(title: string, keyword: string): boolean {
  const words = (text: string) =>
    ` ${text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()} `;
  return words(title).includes(words(keyword));
}
export function parsePatternRules(value: unknown): PatternRules {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((s: unknown) => typeof s === 'string' && s.trim().length > 0);
  const groups = record(value) && Array.isArray(value.groups) ? value.groups : [];
  if (
    !record(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    groups.length !== PATTERN_GROUP_IDS.length ||
    !PATTERN_GROUP_IDS.every(
      (groupId) => groups.filter((g: unknown) => record(g) && g.groupId === groupId).length === 1,
    ) ||
    !groups.every(
      (g: unknown) =>
        record(g) && ['baseIds', 'include', 'exclude', 'whitelist', 'blacklist'].every((key) => strings(g[key])),
    )
  )
    throw new TypeError('catalog.patterns.invalidRules');
  return value as unknown as PatternRules;
}

/** Exclusive first-match groups, with fixed group and PartId ordering. Never modifies the index. */
export function groupPatterns(index: Pick<CatalogIndex, 'parts'>, rules: PatternRules): PatternGroup[] {
  parsePatternRules(rules);
  const groups = PATTERN_GROUP_IDS.map((groupId): PatternGroup => ({ groupId, parts: [] }));
  const ordered = PATTERN_GROUP_IDS.map((id) => rules.groups.find((rule) => rule.groupId === id)!);
  const eligible = [
    ...new Map(
      index.parts.filter((part) => part.flags?.includes('printed') && part.baseOf).map((part) => [part.id, part]),
    ).values(),
  ];
  eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const part of eligible) {
    const match = ordered.findIndex(
      (rule) =>
        !rule.blacklist.includes(part.id) &&
        (rule.whitelist.includes(part.id) ||
          ((!rule.baseIds.length || rule.baseIds.includes(part.baseOf!)) &&
            (!rule.include.length || rule.include.some((word) => phrase(part.nameEn, word))) &&
            !rule.exclude.some((word) => phrase(part.nameEn, word)))),
    );
    if (match >= 0) groups[match]!.parts.push(part.id);
  }
  return groups;
}

/** Bind once per catalog/rule revision, then search without rebuilding groups. */
export class PatternCatalog {
  readonly groups: PatternGroup[];
  readonly unclassified: PartId[];
  private readonly entries: { part: PartDef; groupId: PatternGroupId; text: string }[];
  constructor(index: Pick<CatalogIndex, 'parts'>, rules: PatternRules) {
    this.groups = groupPatterns(index, rules);
    const parts = new Map(index.parts.map((part) => [part.id, part]));
    this.entries = this.groups.flatMap((group) =>
      group.parts.map((id) => {
        const part = parts.get(id)!;
        return {
          part,
          groupId: group.groupId,
          text: normalizeSearch([id, part.legoNo, part.nameEn, part.nameZh, ...part.keywords].join(' ')),
        };
      }),
    );
    const assigned = new Set(this.entries.map((entry) => entry.part.id));
    this.unclassified = [
      ...new Set(
        index.parts
          .filter((part) => part.flags?.includes('printed') && part.baseOf && !assigned.has(part.id))
          .map((part) => part.id),
      ),
    ].sort();
  }
  searchPatterns(query: string, group?: PatternGroupId): PartDef[] {
    const tokens = normalizeSearch(query).split(' ').filter(Boolean);
    return this.entries
      .filter((entry) => (!group || entry.groupId === group) && tokens.every((token) => entry.text.includes(token)))
      .map((entry) => entry.part);
  }
}
