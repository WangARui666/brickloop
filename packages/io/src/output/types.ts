import type { InstancePath, Matrix4, Workspace } from '@brickloop/core';
import type { PartMesh } from '@brickloop/ldraw';
import type { IoIssue } from '../issues';

/** Structural catalog subsets: no Node/catalog runtime enters the Worker bundle. */
export interface OutputPart {
  id: string;
  legoNo: string | null;
  nameZh: string;
  nameEn: string;
  categoryId: string;
}
export interface OutputColor {
  id: string;
  rgb: string;
  alpha: number;
  ldrawCode: number | null;
  legoColorId: number | null;
  legoName: string | null;
  nameZh: string;
  edgeRgb: string;
}
export interface OutputFactoryPart {
  partId: string;
  factoryNo: string;
  factoryName?: string;
  categoryId?: string;
  status: 'active' | 'pending' | 'discontinued';
  colors: readonly string[];
}
export interface OutputFactoryColor {
  colorId: string;
  factoryCode: string;
  measuredRgb: string;
}
export interface OutputCatalog {
  parts?: readonly OutputPart[];
  colors?: readonly OutputColor[];
  factoryParts?: readonly OutputFactoryPart[];
  factoryColors?: readonly OutputFactoryColor[];
}
export type OutputScope =
  { kind: 'project' } | { kind: 'model'; path: InstancePath } | { kind: 'selection'; paths: InstancePath[] };
export interface ScopeOptions {
  scope?: OutputScope;
  workspace?: Pick<Workspace, 'hidden'>;
  includeHidden?: boolean;
  /** Used only for unresolved top-level `inherit`. */
  defaultColorId?: string;
}
export type ExportUnit = 'mm' | 'cm' | 'ldu';
export interface MeshExportOptions extends ScopeOptions {
  unit?: ExportUnit;
  includeEdges?: boolean;
  /** Square edge tube width in LDU; default 0.2 (0.08 mm). */
  edgeWidthLdu?: number;
}
export type MeshProvider = (partId: string) => PartMesh | undefined | Promise<PartMesh | undefined>;
export interface GeometryContext extends OutputCatalog {
  meshProvider: MeshProvider;
}
export interface OutputStats {
  byteLength: number;
  /** Triangles drawn, including repeated instances and optional edge tubes. */
  triangleCount: number;
  uniqueTriangleCount: number;
  partCount: number;
  meshCount: number;
  issues: IoIssue[];
}
export interface Occurrence {
  path: InstancePath;
  name: string;
  colorId: string;
  localMatrix: Matrix4;
  worldMatrix: Matrix4;
  ref: { kind: 'part'; partId: string } | { kind: 'model'; modelId: string };
  children: Occurrence[];
}
