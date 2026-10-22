import { add, cross, dot, scale, sub, unit } from './math.js';
import type { PartMesh, Vec3 } from './types.js';
import { edgeCandidates } from './edge-index.js';

export interface Face {
  vertices: Vec3[];
  normal: Vec3;
  color: number | 'main';
}
const pointKey = (point: Vec3): string => point.map((n) => Math.round(n * 1e5)).join(',');
const edgeKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Newell normal: a quad contributes one normal and no artificial smoothing diagonal. */
export function faceNormal(vertices: Vec3[]): Vec3 {
  let normal: Vec3 = [0, 0, 0];
  for (let i = 0; i < vertices.length; i++)
    normal = add(normal, cross(vertices[i]!, vertices[(i + 1) % vertices.length]!));
  return unit(normal);
}

export function indexFaces(faces: Face[], hardEdges: [Vec3, Vec3][], angle: number): PartMesh['batches'] {
  const parents: number[] = [];
  const offsets: number[] = [];
  const edges = new Map<string, { face: number; a: number; b: number; aKey: string }[]>();
  const exactHard = new Set(hardEdges.map(([a, b]) => edgeKey(pointKey(a), pointKey(b))));
  const candidates = edgeCandidates(hardEdges);
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  const join = (a: number, b: number) => {
    parents[root(b)] = root(a);
  };
  for (const [fi, face] of faces.entries()) {
    const offset = parents.length;
    offsets.push(offset);
    for (let i = 0; i < face.vertices.length; i++) {
      parents.push(parents.length);
      const j = (i + 1) % face.vertices.length;
      const aKey = pointKey(face.vertices[i]!);
      const key = edgeKey(aKey, pointKey(face.vertices[j]!));
      const entries = edges.get(key) ?? [];
      entries.push({ face: fi, a: offset + i, b: offset + j, aKey });
      edges.set(key, entries);
    }
  }
  const threshold = Math.cos((angle * Math.PI) / 180);
  const isHard = (key: string, a: Vec3, b: Vec3): boolean => {
    if (exactHard.has(key)) return true;
    // Type-2 lines often span several polygon edges. Collinear overlap must remain a crease.
    return candidates(a, b, ([start, end]) => {
      const direction = sub(end, start);
      const length2 = dot(direction, direction);
      if (length2 < 1e-16) return false;
      if (
        dot(cross(sub(a, start), direction), cross(sub(a, start), direction)) > 1e-10 * length2 ||
        dot(cross(sub(b, start), direction), cross(sub(b, start), direction)) > 1e-10 * length2
      )
        return false;
      const ta = dot(sub(a, start), direction) / length2;
      const tb = dot(sub(b, start), direction) / length2;
      return Math.min(1, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb)) > 1e-7;
    });
  };
  for (const [key, entries] of edges) {
    if (entries.length < 2) continue;
    const first = entries[0]!;
    const f = faces[first.face]!;
    if (isHard(key, f.vertices[first.a - offsets[first.face]!]!, f.vertices[first.b - offsets[first.face]!]!)) continue;
    for (let i = 0; i < entries.length; i++)
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]!;
        const b = entries[j]!;
        if (dot(faces[a.face]!.normal, faces[b.face]!.normal) + 1e-12 < threshold) continue;
        join(a.a, a.aKey === b.aKey ? b.a : b.b);
        join(a.b, a.aKey === b.aKey ? b.b : b.a);
      }
  }
  const sums = new Map<number, Vec3>();
  for (const [fi, face] of faces.entries())
    for (let i = 0; i < face.vertices.length; i++) {
      const current = face.vertices[i]!;
      const before = unit(sub(face.vertices[(i + face.vertices.length - 1) % face.vertices.length]!, current));
      const after = unit(sub(face.vertices[(i + 1) % face.vertices.length]!, current));
      const weight = Math.acos(Math.max(-1, Math.min(1, dot(before, after))));
      const id = root(offsets[fi]! + i);
      sums.set(id, add(sums.get(id) ?? [0, 0, 0], scale(face.normal, weight)));
    }
  const batches = new Map<
    number | 'main',
    { positions: number[]; normals: number[]; indices: number[]; vertices: Map<string, number> }
  >();
  for (const [fi, face] of faces.entries()) {
    let batch = batches.get(face.color);
    if (!batch) {
      batch = { positions: [], normals: [], indices: [], vertices: new Map() };
      batches.set(face.color, batch);
    }
    const indices: number[] = [];
    for (const [i, point] of face.vertices.entries()) {
      const summed = unit(sums.get(root(offsets[fi]! + i))!);
      const normal = dot(summed, summed) > 0 ? summed : face.normal;
      const key = `${pointKey(point)}|${normal.map((n) => Math.round(n * 1e7)).join(',')}`;
      let index = batch.vertices.get(key);
      if (index === undefined) {
        index = batch.positions.length / 3;
        batch.vertices.set(key, index);
        batch.positions.push(...point);
        batch.normals.push(...normal);
      }
      indices.push(index);
    }
    batch.indices.push(indices[0]!, indices[1]!, indices[2]!);
    if (indices.length === 4) batch.indices.push(indices[0]!, indices[2]!, indices[3]!);
  }
  return Array.from(batches, ([color, batch]) => ({
    color,
    positions: new Float32Array(batch.positions),
    normals: new Float32Array(batch.normals),
    indices: new Uint32Array(batch.indices),
  }));
}
