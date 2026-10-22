import { invert, multiply, transformDirection, transformPoint, translation } from '@brickloop/core';
import type { Matrix4, Vec3 } from '@brickloop/core';
import { insertionRange, slideOffset, solveRotation } from './constraints';
import { isCompatible, linearPair } from './rules';
import type { ConnectorIndex } from './spatial';
import { nearestPoint } from './spatial';
import type { ConnectorInstance, ConnectorRef, SnapCandidate, SnapResult, WorldConnector } from './types';
import { connectorKey, instantiateConnectors, pathKey, segmentEnd } from './world';
import { add, angle, clamp, compareText, distance, dot, scale, sub } from './vector';

export interface SnapConfig {
  screenRadius: number;
  searchRadius: number;
  captureDistance: number;
  captureAngle: number;
  slideStep: number;
  overlapTolerance: number;
  hysteresis: number;
  screenWeight: number;
  displacementWeight: number;
  rotationWeight: number;
  overlapBonus: number;
}
export const DEFAULT_SNAP_CONFIG: Readonly<SnapConfig> = {
  screenRadius: 32,
  searchRadius: 24,
  captureDistance: 12,
  captureAngle: 35,
  slideStep: 10,
  overlapTolerance: 0.5,
  hysteresis: 0.12,
  screenWeight: 1,
  displacementWeight: 0.5,
  rotationWeight: 0.15,
  overlapBonus: 0.04,
};
export type SnapPointer =
  | { screen: readonly [number, number]; viewProjection: Matrix4; viewport: readonly [number, number] }
  | { ray: { origin: Vec3; direction: Vec3 }; worldUnitsPerPixel: number };
export interface SnapRequest {
  selection: readonly ConnectorInstance[];
  primaryPath?: readonly string[];
  pointer?: SnapPointer;
  index: ConnectorIndex;
  previous?: SnapCandidate | null;
  continuous?: boolean;
  enabled?: boolean;
  gridStep?: number;
  config?: Partial<SnapConfig>;
  isOccupied?: (ref: ConnectorRef, other: WorldConnector, excludedPaths: readonly string[][]) => boolean;
}
function screenDistance(point: Vec3, end: Vec3, pointer: SnapPointer | undefined): number {
  if (!pointer) return 0;
  if ('ray' in pointer) {
    // Closest point on the target segment to the forward mouse ray.
    const { origin, direction } = pointer.ray;
    const len = Math.hypot(...direction);
    if (!len || pointer.worldUnitsPerPixel <= 0) throw new RangeError('Invalid ray');
    const d = scale(direction, 1 / len),
      seg = sub(end, point),
      v = sub(point, origin);
    const den = dot(seg, seg) - dot(seg, d) ** 2;
    const t = den > 1e-12 ? clamp((dot(seg, d) * dot(v, d) - dot(seg, v)) / den, 0, 1) : 0;
    const p = add(point, scale(seg, t)),
      along = dot(sub(p, origin), d);
    return along < 0 ? Infinity : distance(p, add(origin, scale(d, along))) / pointer.worldUnitsPerPixel;
  }
  const clip = (p: Vec3): number[] =>
    [0, 1, 2, 3].map(
      (row) =>
        pointer.viewProjection[row]! * p[0] +
        pointer.viewProjection[row + 4]! * p[1] +
        pointer.viewProjection[row + 8]! * p[2] +
        pointer.viewProjection[row + 12]!,
    );
  const a = clip(point),
    b = clip(end);
  let lo = 0,
    hi = 1;
  // Clip the segment before dividing by w. Long connectors crossing the near or
  // far plane remain selectable even when both original endpoints are clipped.
  for (const plane of [(v: number[]) => v[3]! - 1e-9, (v: number[]) => v[2]! + v[3]!, (v: number[]) => v[3]! - v[2]!]) {
    const start = plane(a),
      finish = plane(b);
    if (start < 0 && finish < 0) return Infinity;
    if (start < 0) lo = Math.max(lo, start / (start - finish));
    if (finish < 0) hi = Math.min(hi, start / (start - finish));
  }
  if (lo > hi) return Infinity;
  const project = (t: number): readonly [number, number] => {
    const v = a.map((n, i) => n + (b[i]! - n) * t);
    return [((v[0]! / v[3]! + 1) * pointer.viewport[0]) / 2, ((1 - v[1]! / v[3]!) * pointer.viewport[1]) / 2];
  };
  const p = project(lo),
    q = project(hi),
    d = [q[0] - p[0], q[1] - p[1]],
    v = [pointer.screen[0] - p[0], pointer.screen[1] - p[1]];
  const length = d[0]! ** 2 + d[1]! ** 2,
    t = length ? clamp((v[0]! * d[0]! + v[1]! * d[1]!) / length, 0, 1) : 0;
  return Math.hypot(v[0]! - t * d[0]!, v[1]! - t * d[1]!);
}
function candidateKey(c: Pick<SnapCandidate, 'source' | 'target'>): string {
  return connectorKey(c.target) + '|' + connectorKey(c.source);
}
function groupTransforms(selection: readonly ConnectorInstance[], delta: Matrix4): SnapCandidate['transforms'] {
  return selection.map((i) => ({ path: [...i.path], transform: Array.from(multiply(delta, i.worldMatrix)) }));
}
export function solveSnap(request: SnapRequest): SnapResult {
  const result: SnapResult = { chosen: null, candidates: [], rejected: [] };
  const primary =
    request.selection.find((i) => pathKey(i.path) === pathKey(request.primaryPath ?? [])) ?? request.selection[0];
  if (!primary) return result;
  const config = { ...DEFAULT_SNAP_CONFIG, ...request.config };
  for (const [key, value] of Object.entries(config))
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      (['screenRadius', 'captureDistance', 'captureAngle', 'slideStep'].includes(key) && value === 0)
    )
      throw new RangeError(`Invalid snap config: ${key}`);
  if (request.enabled === false) {
    result.gridTransforms = snapSelectionToGrid(
      [primary, ...request.selection.filter((i) => i !== primary)],
      request.gridStep ?? 20,
    );
    return result;
  }
  const selected = new Set(request.selection.map((i) => pathKey(i.path))),
    excluded = request.selection.map((i) => i.path);
  const sources = instantiateConnectors(primary),
    seen = new Map<string, SnapCandidate>(),
    rejects = new Set<string>();
  const reject = (target: ConnectorRef, reason: SnapResult['rejected'][number]['reason'], detail?: string): void => {
    const key = connectorKey(target) + reason + (detail ?? '');
    if (!rejects.has(key)) {
      rejects.add(key);
      result.rejected.push({ target, reason, ...(detail ? { detail } : {}) });
    }
  };
  for (const source of sources) {
    const a = source.connector;
    const targets = request.index.querySegment(a.frame.origin, segmentEnd(a), config.searchRadius);
    for (const target of targets) {
      if (selected.has(pathKey(target.ref.path))) continue;
      const b = target.connector,
        compatible = isCompatible(a, b);
      if (!compatible.ok) {
        reject(target.ref, 'incompatible', compatible.reason);
        continue;
      }
      const screen = screenDistance(b.frame.origin, segmentEnd(b), request.pointer);
      if (screen > config.screenRadius) {
        reject(target.ref, 'too_far', 'screen');
        continue;
      }
      const capture = angle(a.frame.axis, scale(b.frame.axis, -1));
      if (a.type !== 'ball' && b.type !== 'ball' && capture > config.captureAngle) {
        reject(target.ref, 'angle', 'axis');
        continue;
      }
      if (request.isOccupied?.(target.ref, source, excluded) || request.isOccupied?.(source.ref, target, excluded)) {
        reject(target.ref, 'occupied');
        continue;
      }
      const rotation = solveRotation(a, b);
      if (rotation.residual > 1e-6) {
        reject(target.ref, 'angle', 'limits');
        continue;
      }
      let desired = b.frame.origin;
      const pair = linearPair(a, b),
        range = insertionRange(a, b, config.slideStep);
      if (range && pair) {
        if (range.min > range.max) {
          reject(target.ref, 'blocked_end', 'no insertion interval');
          continue;
        }
        const offset = slideOffset(range, request.continuous ?? false);
        if (pair.maleIsA) desired = add(pair.hole.frame.origin, scale(pair.hole.frame.axis, offset));
        else {
          const holeAxis = scale(b.frame.axis, -1);
          desired = sub(
            sub(b.frame.origin, scale(holeAxis, offset)),
            transformDirection(rotation.matrix, sub(pair.hole.frame.origin, a.frame.origin)),
          );
        }
      }
      const displacement = distance(a.frame.origin, desired);
      if (displacement > config.captureDistance) {
        reject(target.ref, range ? 'blocked_end' : 'too_far', range ? 'insertion outside capture distance' : 'world');
        continue;
      }
      // Rotate around the chosen source cell, then translate that cell to its solution.
      const delta = multiply(multiply(translation(desired), rotation.matrix), translation(scale(a.frame.origin, -1)));
      const transformed = multiply(delta, primary.worldMatrix);
      let overlap = 1;
      if (a.grid && b.grid) {
        const mates = request.index
          .entriesOf(target.ref.path)
          .filter((e) => e.ref.connectorId === target.ref.connectorId);
        overlap = 0;
        let occupied = false;
        for (const cell of sources.filter((e) => e.ref.connectorId === source.ref.connectorId)) {
          const point = transformPoint(delta, cell.connector.frame.origin);
          const mate = mates.find((m) => distance(point, m.connector.frame.origin) <= config.overlapTolerance);
          if (mate) {
            if (request.isOccupied?.(mate.ref, cell, excluded) || request.isOccupied?.(cell.ref, mate, excluded))
              occupied = true;
            overlap++;
          }
        }
        if (occupied) {
          reject(target.ref, 'occupied', 'overlapping grid cell');
          continue;
        }
      }
      const total =
        (config.screenWeight * screen) / config.screenRadius +
        (config.displacementWeight * displacement) / config.captureDistance +
        (config.rotationWeight * rotation.change) / 180 -
        config.overlapBonus * overlap;
      const candidate: SnapCandidate = {
        source: source.ref,
        target: target.ref,
        transform: Array.from(transformed),
        delta: Array.from(delta),
        transforms: groupTransforms(request.selection, delta),
        constraint: { ok: true, residual: rotation.residual },
        collision: 'unknown',
        score: { screen, displacement, rotation: rotation.change, overlap, total },
      };
      const key = candidateKey(candidate);
      seen.set(key, candidate);
    }
  }
  result.candidates = [...seen.values()].sort(
    (a, b) =>
      a.score.total - b.score.total ||
      a.score.screen - b.score.screen ||
      a.score.displacement - b.score.displacement ||
      a.score.rotation - b.score.rotation ||
      compareText(candidateKey(a), candidateKey(b)),
  );
  result.chosen = result.candidates[0] ?? null;
  if (request.previous && result.chosen) {
    const previous = seen.get(candidateKey(request.previous));
    if (previous && previous.score.total <= result.chosen.score.total + config.hysteresis) result.chosen = previous;
  }
  result.rejected.sort((a, b) =>
    compareText(
      connectorKey(a.target) + a.reason + (a.detail ?? ''),
      connectorKey(b.target) + b.reason + (b.detail ?? ''),
    ),
  );
  return result;
}
export function snapSelectionToGrid(selection: readonly ConnectorInstance[], step = 20): SnapCandidate['transforms'] {
  if (!Number.isFinite(step) || step <= 0) throw new RangeError('Invalid grid step');
  const primary = selection[0];
  if (!primary) return [];
  const origin = transformPoint(primary.worldMatrix, [0, 0, 0]);
  const desired = origin.map((n) => Math.round(n / step) * step) as [number, number, number];
  return groupTransforms(selection, translation(sub(desired, origin)));
}
/** Useful for callers writing the chosen primary transform back in parent space. */
export function snapInParent(candidate: SnapCandidate, parentWorld: Matrix4): number[] {
  return Array.from(multiply(invert(parentWorld), new Float64Array(candidate.transform)));
}
export function connectorDistance(a: WorldConnector, b: WorldConnector): number {
  const ac = a.connector,
    bc = b.connector;
  return Math.min(
    distance(ac.frame.origin, nearestPoint(ac.frame.origin, bc.frame.origin, segmentEnd(bc))),
    distance(bc.frame.origin, nearestPoint(bc.frame.origin, ac.frame.origin, segmentEnd(ac))),
  );
}
