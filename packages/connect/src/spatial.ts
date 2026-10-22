import type { Vec3 } from '@brickloop/core';
import type { ConnectorInstance, WorldConnector } from './types';
import { instantiateConnectors, pathKey, segmentEnd } from './world';
import { add, clamp, distance, dot, scale, sub } from './vector';

export function nearestPoint(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const d = sub(b, a),
    den = dot(d, d);
  return den ? add(a, scale(d, clamp(dot(sub(p, a), d) / den, 0, 1))) : a;
}
export function segmentSamples(a: Vec3, b: Vec3, spacing: number): Vec3[] {
  if (distance(a, b) < 1e-12) return [a];
  const count = Math.max(1, Math.ceil(distance(a, b) / spacing));
  return Array.from({ length: count + 1 }, (_, i) => add(a, scale(sub(b, a), i / count)));
}
/** Segment samples are no farther than half a bucket apart. Query adds that
 * margin before exact point/segment filtering, including bucket boundaries. */
export class ConnectorIndex {
  readonly bucketSize: number;
  private buckets = new Map<string, Set<WorldConnector>>();
  private byPath = new Map<string, WorldConnector[]>();
  private membership = new Map<string, string[]>();
  constructor(instances: readonly ConnectorInstance[] = [], bucketSize = 10) {
    if (!Number.isFinite(bucketSize) || bucketSize <= 0) throw new RangeError('Invalid bucket size');
    this.bucketSize = bucketSize;
    for (const instance of instances) this.set(instance);
  }
  get size(): number {
    return this.byPath.size;
  }
  entriesOf(path: readonly string[]): readonly WorldConnector[] {
    return this.byPath.get(pathKey(path)) ?? [];
  }
  paths(): string[][] {
    return [...this.byPath.keys()].map((k) => JSON.parse(k) as string[]);
  }
  set(instance: ConnectorInstance): void {
    this.delete(instance.path);
    const entries = instantiateConnectors(instance);
    this.byPath.set(pathKey(instance.path), entries);
    for (const entry of entries) {
      const cells = [
        ...new Set(
          segmentSamples(entry.connector.frame.origin, segmentEnd(entry.connector), this.bucketSize / 2).map((p) =>
            p.map((v) => Math.floor(v / this.bucketSize)).join(','),
          ),
        ),
      ];
      this.membership.set(entry.key, cells);
      for (const cell of cells) {
        let set = this.buckets.get(cell);
        if (!set) this.buckets.set(cell, (set = new Set()));
        set.add(entry);
      }
    }
  }
  delete(path: readonly string[]): void {
    const key = pathKey(path);
    for (const entry of this.byPath.get(key) ?? []) {
      for (const cell of this.membership.get(entry.key) ?? []) {
        const set = this.buckets.get(cell)!;
        set.delete(entry);
        if (!set.size) this.buckets.delete(cell);
      }
      this.membership.delete(entry.key);
    }
    this.byPath.delete(key);
  }
  query(position: Vec3, radius: number): WorldConnector[] {
    if (!Number.isFinite(radius) || radius < 0) throw new RangeError('Invalid radius');
    const margin = radius + this.bucketSize / 2;
    const min = position.map((v) => Math.floor((v - margin) / this.bucketSize)),
      max = position.map((v) => Math.floor((v + margin) / this.bucketSize));
    const found = new Set<WorldConnector>();
    for (let x = min[0]!; x <= max[0]!; x++)
      for (let y = min[1]!; y <= max[1]!; y++)
        for (let z = min[2]!; z <= max[2]!; z++) {
          for (const entry of this.buckets.get(`${x},${y},${z}`) ?? []) {
            if (
              !found.has(entry) &&
              distance(position, nearestPoint(position, entry.connector.frame.origin, segmentEnd(entry.connector))) <=
                radius + 1e-9
            )
              found.add(entry);
          }
        }
    return [...found];
  }
  querySegment(a: Vec3, b: Vec3, radius: number): WorldConnector[] {
    const found = new Set<WorldConnector>();
    for (const point of segmentSamples(a, b, this.bucketSize))
      for (const entry of this.query(point, radius + this.bucketSize / 2)) found.add(entry);
    return [...found];
  }
}
