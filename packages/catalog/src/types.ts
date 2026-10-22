export type PartId = `ld:${string}` | `cu:${string}`;
export type ColorId = `c:${string}` | `cx:${string}` | `ld:${number}`;
export type Finish =
  'solid' | 'transparent' | 'chrome' | 'metallic' | 'pearl' | 'glitter' | 'speckle' | 'rubber' | 'glow';

export interface PartDef {
  id: PartId;
  legoNo: string | null;
  ldrawFile: string | null;
  nameZh: string;
  nameEn: string;
  categoryId: string;
  keywords: string[];
  /** Header indexing does not evaluate geometry. null means not measured yet. */
  bboxLdu: [number, number, number, number, number, number] | null;
  geometry: { source: 'ldraw' | 'custom'; ref: string; hash: string };
  connectorsRef: string | null;
  baseOf?: PartId;
  alternates?: PartId[];
  flags?: ('printed' | 'sticker' | 'flexible' | 'minifig' | 'assembly')[];
}

export interface Category {
  id: string;
  nameZh: string;
  nameEn: string;
  parentId: string | null;
  order: number;
  icon?: string;
}

export interface ColorDef {
  id: ColorId;
  legoName: string | null;
  legoColorId: number | null;
  nameZh: string;
  ldrawCode: number | null;
  rgb: string;
  edgeRgb: string;
  finish: Finish;
  alpha: number;
}

export interface FactoryPartInfo {
  partId: PartId;
  factoryNo: string;
  factoryName?: string;
  categoryId?: string;
  status: 'active' | 'discontinued' | 'pending';
  colors: ColorId[];
}

export interface FactoryColorInfo {
  colorId: ColorId;
  factoryCode: string;
  measuredRgb: string;
  note?: string;
}

export interface PackManifest {
  id: string;
  name: string;
  version: string;
  source: string;
  createdAt: string;
  templateVersion: 1;
  /** SHA-256 of sorted payload paths and file bytes; empty on editable templates. */
  contentHash: string;
}

export interface PackPart extends FactoryPartInfo {
  legoNo: string | null;
  ldrawFile: string | null;
  customCode?: string;
  note?: string;
}

export interface PackColor extends FactoryColorInfo {
  definition: ColorDef;
}

export interface Pack {
  manifest: PackManifest;
  parts: PackPart[];
  colors: PackColor[];
  categories: Category[];
  /** Relative custom/ and images/ members, preserved through import/export. */
  assets: Record<string, Uint8Array>;
}

export interface ImportIssue {
  file: string;
  sheet: string;
  row: number;
  column: string;
  reason: string;
}

export interface ImportReport {
  errors: ImportIssue[];
  warnings: ImportIssue[];
  acceptedParts: number;
  acceptedColors: number;
  skippedRows: number;
}

export interface CatalogIndex {
  schemaVersion: 1;
  libraryVersion: string;
  parts: PartDef[];
  categories: Category[];
  aliases: Record<string, PartId>;
  legoNumbers: Record<string, PartId[]>;
}
