import type { Pack, PackColor, PackPart } from './types';

export interface Changes<T> {
  added: T[];
  removed: T[];
  changed: { before: T; after: T }[];
}
export interface PackDiff {
  parts: Changes<PackPart>;
  colors: Changes<PackColor>;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).sort().join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? '';
}
function changes<T>(before: readonly T[], after: readonly T[], key: (value: T) => string): Changes<T> {
  const old = new Map(before.map((item) => [key(item), item]));
  const next = new Map(after.map((item) => [key(item), item]));
  return {
    added: after.filter((item) => !old.has(key(item))),
    removed: before.filter((item) => !next.has(key(item))),
    changed: after.flatMap((item) => {
      const previous = old.get(key(item));
      return previous && stable(previous) !== stable(item) ? [{ before: previous, after: item }] : [];
    }),
  };
}
export function diffPacks(a: Pack, b: Pack): PackDiff {
  return {
    parts: changes(a.parts, b.parts, (part) => part.partId),
    // Factory code is the comparison key so remapping a code to another LEGO colour is a change.
    colors: changes(a.colors, b.colors, (color) => color.factoryCode),
  };
}
