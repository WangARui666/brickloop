import { isLDrawInternalColor } from '../../../../packages/catalog/src/ldraw-internal-colors';
import { standardPackingParts } from '../../../../packages/buildscript/src/standard-parts';
import type { BuildCatalog as EngineCatalog, CompactPart } from '../../../../packages/buildscript/src/types';
import type { LibraryColor, LibraryPart } from './library-api';

export type {
  BuildOptions,
  BuildResult,
  BuildError,
  BuildStats,
  BuildInstance,
  PartSize,
} from '../../../../packages/buildscript/src/types';
export type BuildCatalog = EngineCatalog & { boundsLdu?: Record<string, readonly number[]> };
export const rawPartId = (id: string) => id.replace(/^ld:/, '');
export const documentPartId = (id: string) => (id.includes(':') ? id : `ld:${id}`);
const sizes = new Map(standardPackingParts.map((p) => [p.id, p]));

/** Built once per active CatalogService. Never fetches meshes to index the full library. */
export function compactBuildCatalog(parts: LibraryPart[], colors: LibraryColor[]): BuildCatalog {
  return {
    parts: parts.map((part): CompactPart => {
      const standard = sizes.get(rawPartId(part.id)),
        b = part.bboxLdu;
      const size =
        standard?.size ?? (b ? { w: (b[3] - b[0]) / 20, d: (b[5] - b[2]) / 20, h: (b[4] - b[1]) / 8 } : undefined);
      return {
        id: rawPartId(part.id),
        name: part.nameEn,
        category: part.categoryId,
        kind: standard?.kind ?? 'other',
        ...(size ? { size } : {}),
        tags: part.keywords,
        factory: part.factoryNo !== null,
      };
    }),
    colors: colors
      .filter((c) => !isLDrawInternalColor(c))
      .map((c) => ({
        id: c.id,
        name: c.legoName ?? c.nameZh,
        rgb: c.rgb,
        alpha: c.alpha,
        factory: c.factoryCode !== null,
      })),
    boundsLdu: Object.fromEntries(parts.filter((p) => p.bboxLdu).map((p) => [rawPartId(p.id), p.bboxLdu!])),
  };
}
