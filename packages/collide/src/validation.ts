import { axes, dot, length } from './math.js';
import type { Collider, ColliderOverride, ColliderShape, Vec3 } from './types.js';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const vector = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
export function isColliderShape(value: unknown): value is ColliderShape {
  if (!record(value) || !vector(value.center)) return false;
  if (value.kind === 'cylinder')
    return (
      vector(value.axis) &&
      Math.abs(length(value.axis) - 1) < 1e-6 &&
      positive(value.radius) &&
      positive(value.halfLength)
    );
  if (
    value.kind !== 'box' ||
    !vector(value.halfSize) ||
    !value.halfSize.every(positive) ||
    !Array.isArray(value.rotation) ||
    value.rotation.length !== 9 ||
    !value.rotation.every((v) => typeof v === 'number' && Number.isFinite(v))
  )
    return false;
  const basis = axes(value.rotation as Extract<ColliderShape, { kind: 'box' }>['rotation']);
  return (
    basis.every((axis) => Math.abs(length(axis) - 1) < 1e-6) &&
    Math.abs(dot(basis[0], basis[1])) < 1e-6 &&
    Math.abs(dot(basis[0], basis[2])) < 1e-6 &&
    Math.abs(dot(basis[1], basis[2])) < 1e-6
  );
}
export function parseColliderOverride(value: unknown, partId?: string): ColliderOverride {
  if (
    !record(value) ||
    value.schema !== 1 ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.partId !== 'string' ||
    (partId !== undefined && value.partId !== partId) ||
    typeof value.approximate !== 'boolean' ||
    !Array.isArray(value.shapes) ||
    value.shapes.length === 0 ||
    !value.shapes.every(isColliderShape) ||
    (value.notes !== undefined && typeof value.notes !== 'string')
  )
    throw new TypeError('Invalid collider override (schema, version, partId or shape)');
  return value as unknown as ColliderOverride;
}
export function isCollider(value: unknown): value is Collider {
  return (
    record(value) &&
    value.schema === 1 &&
    typeof value.partId === 'string' &&
    typeof value.generatorVersion === 'string' &&
    ['manual', 'generated', 'bbox'].includes(String(value.source)) &&
    typeof value.approximate === 'boolean' &&
    Array.isArray(value.shapes) &&
    value.shapes.every(isColliderShape) &&
    Array.isArray(value.bounds) &&
    value.bounds.length === 6 &&
    value.bounds.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    value.bounds.slice(0, 3).every((v, i) => (v as number) <= (value.bounds as number[])[i + 3]!) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every((s) => typeof s === 'string')
  );
}
