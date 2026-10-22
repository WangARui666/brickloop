import rulesJson from '../../../library/connectors/rules.json';
import type { Connector, ConnectorType, OccupancyChannel } from './types';
import { add, scale } from './vector';
export interface CompatibilityRule {
  a: ConnectorType;
  b: ConnectorType;
  diameter?: boolean;
  size?: boolean;
  role?: boolean;
  tag?: boolean;
  studDepth?: boolean;
}
export interface ConnectorRules {
  schema: 1;
  pairs: readonly CompatibilityRule[];
  defaults: { studLength: number; hollowDepth: number; tubeDepth: number };
}
export const DEFAULT_RULES = rulesJson as ConnectorRules;
export type CompatibilityReason = 'compatible' | 'type' | 'diameter' | 'size' | 'role' | 'tag' | 'stud_depth';
export function isCompatible(
  a: Connector,
  b: Connector,
  rules: ConnectorRules = DEFAULT_RULES,
): { ok: boolean; reason: CompatibilityReason } {
  const rule = rules.pairs.find((r) => (r.a === a.type && r.b === b.type) || (r.a === b.type && r.b === a.type));
  if (!rule) return { ok: false, reason: 'type' };
  if (rule.size && (a.size === undefined || a.size !== b.size)) return { ok: false, reason: 'size' };
  if (rule.tag && (!a.tag || a.tag !== b.tag)) return { ok: false, reason: 'tag' };
  if (rule.role && (!a.role || !b.role || a.role === b.role)) return { ok: false, reason: 'role' };
  if (rule.diameter) {
    const male = isMale(a) ? a : b,
      hole = male === a ? b : a;
    if (male.diameter === undefined || hole.diameter === undefined || male.diameter > hole.diameter + 1e-6)
      return { ok: false, reason: 'diameter' };
  }
  if (rule.studDepth) {
    const stud = a.type === 'stud' ? a : b,
      hole = stud === a ? b : a;
    if (hole.studDepth === undefined || (stud.length ?? rules.defaults.studLength) > hole.studDepth)
      return { ok: false, reason: 'stud_depth' };
  }
  return { ok: true, reason: 'compatible' };
}
export const isMale = (c: Connector): boolean =>
  ['bar', 'bar.post', 'bar.thin', 'axle', 'pin', 'wheel.pin', 'stud', 'stud.hollow'].includes(c.type);
export function occupancyChannel(c: Connector, other: Connector): OccupancyChannel {
  if (c.type === 'stud.hollow') return ['bar', 'bar.post'].includes(other.type) ? 'inner' : 'outer';
  return 'main';
}
/** Hollow studs act as a hole for bars and as a stud for antistuds. */
export function linearPair(
  a: Connector,
  b: Connector,
): { male: Connector; hole: Connector; maleIsA: boolean; length: number; depth: number } | null {
  const rods: readonly ConnectorType[] = ['bar', 'bar.post', 'bar.thin', 'axle', 'pin', 'wheel.pin'];
  const male = rods.includes(a.type) ? a : rods.includes(b.type) ? b : null;
  if (!male) return null;
  let hole = male === a ? b : a;
  if (!isCompatible(a, b).ok) return null;
  if (hole.type === 'stud.hollow')
    hole = {
      ...hole,
      frame: {
        ...hole.frame,
        origin: add(hole.frame.origin, scale(hole.frame.axis, DEFAULT_RULES.defaults.studLength)),
      },
    };
  return {
    male,
    hole,
    maleIsA: male === a,
    length: male.length!,
    depth:
      hole.length ??
      (hole.type === 'stud.hollow' ? DEFAULT_RULES.defaults.hollowDepth : DEFAULT_RULES.defaults.tubeDepth),
  };
}
export function rotationStep(a: Connector, b: Connector): number | 'free' {
  if ((a.type === 'axle' && b.type === 'pin.hole') || (b.type === 'axle' && a.type === 'pin.hole')) return 'free';
  if (a.type === 'ball' || b.type === 'ball') return 'free';
  const steps = [a.rotation, b.rotation].filter((v): v is number => typeof v === 'number');
  if (steps.length) {
    // Intersection of the two angular lattices, including fractional degree steps.
    const gcd = (x: number, y: number): number => {
      while (y) [x, y] = [y, x % y];
      return x;
    };
    return steps.reduce((x, y) => {
      const u = Math.round(x * 1e6),
        v = Math.round(y * 1e6);
      return ((u / gcd(u, v)) * v) / 1e6;
    });
  }
  if (a.grid || b.grid || a.type === 'axle' || b.type === 'axle') return 90;
  if (a.rotation === 'free' || b.rotation === 'free') return 'free';
  if (a.type === 'fixed') return 360;
  return 'free';
}
