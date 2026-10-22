import type {
  Category,
  ColorDef,
  ColorId,
  ImportReport,
  PackDiff,
  PackManifest,
  PartDef,
  PartId,
  PackImpact,
  DocumentReference,
} from '@brickloop/catalog';
import type { PartMesh } from '@brickloop/ldraw';
import type { PatternGroupId } from '@brickloop/catalog';
import type { BuildCatalog } from './buildscript-catalog';
const patternGroupIds: PatternGroupId[] = ['faces', 'torsos', 'legs', 'screens', 'texts', 'controls', 'symbols'];

export interface PatternPart extends LibraryPart {
  factory: boolean;
  patternGroup: PatternGroupId;
}

export interface LibraryPart extends PartDef {
  factoryNo: string | null;
}
export interface LibraryColor extends ColorDef {
  factoryCode: string | null;
}
export interface LibraryStatus {
  state: 'ready' | 'missing' | 'error';
  pack: PackManifest | null;
  startupMs: number;
}
export interface PackSummary extends PackManifest {
  partCount: number;
  colorCount: number;
  active: boolean;
}
export interface MeshResult {
  mesh: PartMesh;
  key: string;
  cacheHit: boolean;
  durationMs: number;
  timing?: { queueMs: number; deliveryMs: number };
}
export interface ImportRequest {
  action: 'choose' | 'review' | 'commit' | 'cancel';
  kind?: 'file' | 'directory';
  token?: string;
  skipInvalidRows?: boolean;
  activate?: boolean;
  file?: string;
}
export interface ImportReview {
  token: string;
  report: ImportReport;
  manifest: PackManifest | null;
  diff: PackDiff | null;
  imported: boolean;
}
export interface LibraryApi {
  buildScriptCatalog(): Promise<BuildCatalog>;
  packsImpact(
    target: { id?: string; token?: string },
    documents: { title: string; references: DocumentReference[] }[],
  ): Promise<{ title: string; impact: PackImpact }[]>;
  patternGroups(): Promise<{ groupId: PatternGroupId; count: number }[]>;
  patternSearch(query: string, group?: PatternGroupId): Promise<PatternPart[]>;
  catalogStatus(): Promise<LibraryStatus>;
  catalogSearch(query: string, options: { includeAll: boolean; categoryId?: string }): Promise<LibraryPart[]>;
  catalogCategories(): Promise<Category[]>;
  catalogPart(id: PartId): Promise<LibraryPart | null>;
  catalogColors(): Promise<{ factory: LibraryColor[]; all: LibraryColor[] }>;
  packsList(): Promise<PackSummary[]>;
  packsImport(request: ImportRequest): Promise<ImportReview | null>;
  packsExportTemplate(id?: string): Promise<string | null>;
  packsActivate(id: string): Promise<void>;
  packsRemove(id: string): Promise<void>;
  packsDiff(id: string): Promise<PackDiff>;
  meshGet(id: PartId): Promise<MeshResult>;
  thumbGet(partId: PartId, colorId: ColorId, colored?: boolean): Promise<{ key: string; png: string | null }>;
  thumbPut(key: string, png: string): Promise<void>;
  setFavoriteColors(ids: ColorId[]): Promise<ColorId[]>;
}
export const LIBRARY_CHANNELS = {
  buildScriptCatalog: 'catalog.buildScript',
  packsImpact: 'packs.impact',
  patternGroups: 'patterns.groups',
  patternSearch: 'patterns.search',
  catalogStatus: 'catalog.status',
  catalogSearch: 'catalog.search',
  catalogCategories: 'catalog.categories',
  catalogPart: 'catalog.part',
  catalogColors: 'catalog.colors',
  packsList: 'packs.list',
  packsImport: 'packs.import',
  packsExportTemplate: 'packs.exportTemplate',
  packsActivate: 'packs.activate',
  packsRemove: 'packs.remove',
  packsDiff: 'packs.diff',
  meshGet: 'mesh.get',
  thumbGet: 'thumb.get',
  thumbPut: 'thumb.put',
  setFavoriteColors: 'settings.favoriteColors',
} as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length <= max;
export const isPartId = (value: unknown): value is PartId =>
  text(value) &&
  /^(ld|cu):[^/\\:]+$/.test(value) &&
  [...value].every((letter) => letter.charCodeAt(0) >= 32) &&
  !value.includes('..');
export const isColorId = (value: unknown): value is ColorId =>
  text(value) && /^(c|cx|ld):[^/\\:]+$/.test(value) && [...value].every((letter) => letter.charCodeAt(0) >= 32);
const packId = (value: unknown) =>
  text(value, 80) && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
export function validLibraryArguments(channel: string, args: readonly unknown[]): boolean {
  const [a, b] = args;
  switch (channel) {
    case LIBRARY_CHANNELS.patternGroups:
      return args.length === 0;
    case LIBRARY_CHANNELS.patternSearch:
      return (
        args.length >= 1 &&
        args.length <= 2 &&
        text(a, 200) &&
        (b === undefined || patternGroupIds.some((id) => id === b))
      );
    case LIBRARY_CHANNELS.catalogStatus:
    case LIBRARY_CHANNELS.buildScriptCatalog:
    case LIBRARY_CHANNELS.catalogCategories:
    case LIBRARY_CHANNELS.catalogColors:
    case LIBRARY_CHANNELS.packsList:
      return args.length === 0;
    case LIBRARY_CHANNELS.catalogPart:
    case LIBRARY_CHANNELS.meshGet:
      return args.length === 1 && isPartId(a);
    case LIBRARY_CHANNELS.catalogSearch:
      return (
        args.length === 2 &&
        text(a, 200) &&
        record(b) &&
        keys(b, ['includeAll', 'categoryId']) &&
        typeof b.includeAll === 'boolean' &&
        (b.categoryId === undefined || text(b.categoryId))
      );
    case LIBRARY_CHANNELS.packsActivate:
    case LIBRARY_CHANNELS.packsRemove:
    case LIBRARY_CHANNELS.packsDiff:
      return args.length === 1 && packId(a);
    case LIBRARY_CHANNELS.packsExportTemplate:
      return args.length === 0 || (args.length === 1 && (a === undefined || packId(a)));
    case LIBRARY_CHANNELS.packsImport:
      if (
        args.length !== 1 ||
        !record(a) ||
        !keys(a, ['action', 'kind', 'token', 'skipInvalidRows', 'activate', 'file'])
      )
        return false;
      if (a.file !== undefined && (!text(a.file, 32768) || a.file.includes('\0') || !/\.brklpack$/i.test(a.file)))
        return false;
      if (a.skipInvalidRows !== undefined && typeof a.skipInvalidRows !== 'boolean') return false;
      if (a.activate !== undefined && typeof a.activate !== 'boolean') return false;
      return a.action === 'choose'
        ? a.kind === 'file' || a.kind === 'directory'
        : ['review', 'commit', 'cancel'].includes(String(a.action)) &&
            text(a.token, 36) &&
            /^[a-f0-9-]{36}$/.test(a.token);
    case LIBRARY_CHANNELS.packsImpact:
      return (
        args.length === 2 &&
        record(a) &&
        keys(a, ['id', 'token']) &&
        (packId(a.id) || (text(a.token, 36) && /^[a-f0-9-]{36}$/.test(a.token))) &&
        Array.isArray(b) &&
        b.every(
          (doc) =>
            record(doc) &&
            text(doc.title, 512) &&
            Array.isArray(doc.references) &&
            doc.references.every(
              (ref) => record(ref) && isPartId(ref.partId) && (ref.colorId === 'inherit' || isColorId(ref.colorId)),
            ),
        )
      );
    case LIBRARY_CHANNELS.thumbGet:
      return (args.length === 2 || (args.length === 3 && typeof args[2] === 'boolean')) && isPartId(a) && isColorId(b);
    case LIBRARY_CHANNELS.thumbPut:
      return (
        args.length === 2 &&
        text(a, 64) &&
        /^[a-f0-9]{64}$/.test(a) &&
        text(b, 512_000) &&
        /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(b)
      );
    case LIBRARY_CHANNELS.setFavoriteColors:
      return args.length === 1 && Array.isArray(a) && a.length <= 512 && a.every(isColorId);
    default:
      return false;
  }
}
