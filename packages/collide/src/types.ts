import type { InstancePath, Matrix4 } from '@brickloop/core';

export type Vec3 = [number, number, number];
/** Column-major orthonormal axes; reflections are allowed. */
export type Rotation = [number, number, number, number, number, number, number, number, number];
export type Aabb = [number, number, number, number, number, number];
export type ColliderShape =
  | { kind: 'box'; center: Vec3; halfSize: Vec3; rotation: Rotation }
  | { kind: 'cylinder'; center: Vec3; axis: Vec3; radius: number; halfLength: number };
export const GENERATOR_VERSION = '1.1.0';
export const IDENTITY_ROTATION: Rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export interface Collider {
  schema: 1;
  partId: string;
  generatorVersion: string;
  source: 'generated' | 'manual' | 'bbox';
  approximate: boolean;
  shapes: ColliderShape[];
  /** Original geometry bounds, before contact inset. */
  bounds: Aabb;
  diagnostics: string[];
}
/** Manual shapes are already inset; the loader never shrinks them a second time. */
export interface ColliderOverride {
  schema: 1;
  version: number;
  partId: string;
  approximate: boolean;
  shapes: ColliderShape[];
  notes?: string;
}
export interface ColliderBuildOptions {
  partId?: string;
  resolution?: number;
  inset?: number;
  maxVoxels?: number;
  maxDepth?: number;
  /** Use resolver-compatible primitive resolution (e.g. the mesh's high-res setting). */
  highResPrimitives?: boolean;
  loadOverride?: (partId: string) => Promise<unknown | undefined>;
}
export type CollisionStatus = 'none' | 'hit' | 'unknown';
export type UnknownReason = 'missing-proxy' | 'approximate' | 'budget' | 'numerical';
export interface CollisionPair {
  a: InstancePath;
  b: InstancePath;
  status: 'hit' | 'unknown';
  /** Indices into the two instances' world-space shapes. */
  shapes: { a: number; b: number }[];
  reason?: UnknownReason;
}
export interface CollisionResult {
  /** Unknown takes precedence over hit; already confirmed hits remain in pairs. */
  status: CollisionStatus;
  pairs: CollisionPair[];
  /** Unfinished/unbounded instances, including those with no enumerable pair. */
  unknownPaths: InstancePath[];
  reasons: UnknownReason[];
  testedPairs: number;
}
export interface CollisionInstance {
  path: InstancePath;
  transform: Matrix4;
  collider?: Collider;
  /** Local geometry bounds when the proxy is missing. */
  bounds?: Aabb;
}
export interface CollisionPreview {
  path?: InstancePath;
  /** World-space, already inset shapes. */
  shapes: readonly ColliderShape[];
  approximate?: boolean;
  excludePaths?: readonly InstancePath[];
}
export interface QueryOptions {
  enabled?: boolean;
  budgetMs?: number;
}
