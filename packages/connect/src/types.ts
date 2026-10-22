import type { InstancePath, Matrix4, Vec3 } from '@brickloop/core';

export const CONNECTOR_TYPES = [
  'stud',
  'stud.hollow',
  'antistud',
  'antistud.tube',
  'bar',
  'bar.post',
  'bar.hole',
  'clip',
  'axle',
  'axle.hole',
  'pin',
  'pin.hole',
  'ball',
  'ball.socket',
  'hinge.click',
  'bar.thin',
  'bar.thin.hole',
  'wheel.pin',
  'wheel.hole',
  'fixed',
  'hinge.plain',
  'slider',
  'rail',
] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];
export interface Frame {
  origin: Vec3;
  axis: Vec3;
  ref: Vec3;
}
export type Cell = [number, number];
export interface Connector {
  id: string;
  type: ConnectorType;
  frame: Frame;
  grid?: { rows: number; cols: number; pitch: number; mask: boolean[][] | null };
  cells?: Record<string, Cell[]>;
  length?: number;
  ends?: { start: 'open' | 'closed'; end: 'open' | 'closed' };
  stops?: number[];
  diameter?: number;
  studDepth?: number;
  rotation?: 'free' | number;
  size?: string | number;
  tag?: string;
  role?: 'a' | 'b';
  limits?: [number, number];
}
export interface ConnectorFile {
  schema: 1;
  partId: string;
  status: 'inferred' | 'draft' | 'reviewed';
  source: string;
  connectors: Connector[];
}
export interface ConnectorIssue {
  path: string;
  message: string;
  file?: string;
}
export interface ConnectorRef {
  path: InstancePath;
  connectorId: string;
  cell?: Cell;
}
export interface ConnectorInstance {
  path: InstancePath;
  worldMatrix: Matrix4;
  connectors: readonly Connector[];
}
/** One physical point/grid cell or one whole linear segment. */
export interface WorldConnector {
  key: string;
  ref: ConnectorRef;
  connector: Connector;
}
export type OccupancyChannel = 'outer' | 'inner' | 'main';
export interface SnapCandidate {
  source: ConnectorRef;
  target: ConnectorRef;
  /** Column-major 4×4 world matrix of the primary instance. */
  transform: number[];
  /** The same world-space delta applies to every selected instance. */
  delta: number[];
  transforms: { path: InstancePath; transform: number[] }[];
  constraint: { ok: boolean; residual: number };
  collision: 'none' | 'hit' | 'unknown';
  score: { screen: number; displacement: number; rotation: number; overlap: number; total: number };
}
export interface SnapResult {
  chosen: SnapCandidate | null;
  candidates: SnapCandidate[];
  gridTransforms?: { path: InstancePath; transform: number[] }[];
  rejected: {
    target: ConnectorRef;
    reason: 'incompatible' | 'too_far' | 'angle' | 'blocked_end' | 'occupied' | 'collision';
    detail?: string;
  }[];
}
