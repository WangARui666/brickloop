import { expandInstances } from '@brickloop/core';
import type { Pack } from '@brickloop/catalog/types';
import type { MacroPackage } from './types';

export interface MacroAvailability {
  missingParts: string[];
  missingColors: string[];
  unavailableColors: { partId: string; colorId: string }[];
}
export function macroAvailability(pkg: MacroPackage, pack: Pick<Pack, 'parts' | 'colors'>): MacroAvailability {
  const parts = new Map<string, Pack['parts'][number]>(
    pack.parts.filter((part) => part.status !== 'discontinued').map((part) => [part.partId, part]),
  );
  const colors = new Set<string>(pack.colors.map((color) => color.colorId));
  const rows = expandInstances(pkg.document);
  const combinations = new Map(
    rows.map((row) => [JSON.stringify([row.partId, row.colorId]), { partId: row.partId, colorId: row.colorId }]),
  );
  return {
    missingParts: [...new Set(rows.map((row) => row.partId))].filter((id) => !parts.has(id)).sort(),
    missingColors: [...new Set(rows.map((row) => row.colorId))].filter((id) => !colors.has(id)).sort(),
    unavailableColors: [...combinations.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([, row]) => {
        const part = parts.get(row.partId);
        return part && colors.has(row.colorId) && !part.colors.some((color) => color === row.colorId) ? [row] : [];
      }),
  };
}
