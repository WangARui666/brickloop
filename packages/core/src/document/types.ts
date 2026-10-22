import type { Vec3 } from '../math';

export type Id = string;
export type DocumentId = Id;
export type ModelId = Id;
export type InstanceId = Id;
export type StepId = Id;
export type GroupId = Id;
export type TxId = Id;
export type PartId = string;
export type ColorId = string;
export type InstancePath = InstanceId[];
export interface UnknownFields {
  [key: string]: unknown;
}
export interface CameraHint extends UnknownFields {
  position?: Vec3;
  target?: Vec3;
  up?: Vec3;
  fov?: number;
}
export interface Step extends UnknownFields {
  id: StepId;
  instanceIds: InstanceId[];
  description?: string;
  camera?: CameraHint;
}
export interface Instance extends UnknownFields {
  id: InstanceId;
  ref: ({ kind: 'part'; partId: PartId } | { kind: 'model'; modelId: ModelId }) & UnknownFields;
  colorId: ColorId | 'inherit';
  transform: number[];
  stepId: StepId;
  groupId: GroupId | null;
}
export interface Group extends UnknownFields {
  id: GroupId;
  name: string;
  modelId: ModelId;
  parentGroupId: GroupId | null;
}
export interface ModelDef extends UnknownFields {
  id: ModelId;
  name: string;
  kind: 'main' | 'submodel';
  stepIds: StepId[];
  steps: Record<StepId, Step>;
  instances: Record<InstanceId, Instance>;
  extensions: Record<string, unknown>;
}
// Asset payloads remain opaque to core; IO/catalog own their resource metadata.
export interface EmbeddedPartRef extends UnknownFields {
  hash: string;
}
export interface RefImage extends UnknownFields {
  hash: string;
}
export interface DocumentMeta extends UnknownFields {
  title: string;
  author: string;
  createdAt: string;
  notes: string;
}
export interface BrkDocument extends UnknownFields {
  /** Current writers use 1; readers retain higher versions for read-only opening. */
  schemaVersion: number;
  documentId: DocumentId;
  revision: number;
  rootModelId: ModelId;
  models: Record<ModelId, ModelDef>;
  groups: Record<GroupId, Group>;
  embeddedParts: Record<PartId, EmbeddedPartRef>;
  referenceImages: Record<Id, RefImage>;
  meta: DocumentMeta;
  catalogPack: { id: string; version: string } & UnknownFields;
  extensions: Record<string, unknown>;
}
export interface Workspace extends UnknownFields {
  activeModelPath: InstancePath;
  selection: InstancePath[];
  hidden: InstancePath[];
  camera: { mode: 'perspective' | 'ortho'; position: Vec3; target: Vec3; up: Vec3; fov: number };
  grid: { horizontal: 1 | 0.5 | 0.25; vertical: 'plate' | 'brick' | 'free' };
  snapEnabled: boolean;
  collisionEnabled: boolean;
  panelState: Record<string, unknown>;
}
export interface EditContext {
  activeModelPath: InstancePath;
  selection: InstancePath[];
  activeGroupId?: GroupId | null;
  stepId?: StepId;
  primaryPath?: InstancePath;
  hidden?: InstancePath[];
}
export interface DocumentIssue {
  code: string;
  path: string;
  messageKey: string;
  severity: 'error' | 'warning';
}
