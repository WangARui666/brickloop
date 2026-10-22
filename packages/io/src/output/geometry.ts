import { determinant, identity, invert, multiply, transformPoint } from '@brickloop/core';
import type { Matrix4, Vec3 } from '@brickloop/core';
import type { BrkDocument } from '@brickloop/core';
import type { IoIssue } from '../issues';
import { collectScene } from './scene';
import type { ExportUnit, GeometryContext, MeshExportOptions, Occurrence, OutputStats } from './types';

export const exportUnits = {
  mm: { perLdu: 0.4, meter: 0.001 },
  cm: { perLdu: 0.04, meter: 0.01 },
  ldu: { perLdu: 1, meter: 0.0004 },
} as const;
export const pairKey = (part: string, color: string) => JSON.stringify([part, color]);
export const numberText = (value: number) => {
  if (!Number.isFinite(value)) throw new RangeError('Non-finite geometry');
  return String(Number(value.toPrecision(12)) || 0);
};
export const numbers = (values: ArrayLike<number>) => Array.from(values, numberText).join(' ');
export function outputIssue(code: string, detail: string): IoIssue {
  return { code, messageKey: `io.${code}`, severity: 'warning', detail };
}
export function basis(unit: ExportUnit): Matrix4 {
  const matrix = identity(),
    scale = exportUnits[unit].perLdu;
  matrix[0] = scale;
  matrix[5] = -scale;
  matrix[10] = -scale;
  return matrix;
}
export function convertedMatrix(matrix: Matrix4, unit: ExportUnit): Matrix4 {
  const c = basis(unit);
  return multiply(multiply(c, matrix), invert(c));
}
export function normalTransform(matrix: Matrix4): (normal: Vec3) => Vec3 {
  const inverse = invert(matrix);
  return (normal) => {
    const v = [0, 1, 2].map(
      (i) => inverse[i * 4]! * normal[0] + inverse[i * 4 + 1]! * normal[1] + inverse[i * 4 + 2]! * normal[2],
    );
    const length = Math.hypot(...v);
    return length ? [v[0]! / length, v[1]! / length, v[2]! / length] : [0, 1, 0];
  };
}
export const pointAt = (values: ArrayLike<number>, offset: number): Vec3 => [
  values[offset]!,
  values[offset + 1]!,
  values[offset + 2]!,
];
export interface Material {
  id: string;
  colorId: string;
  rgb: [number, number, number];
  alpha: number;
}
export interface Primitive {
  material: Material;
  positions: number[];
  normals: number[];
  indices: number[];
}
export interface PreparedMesh {
  id: string;
  primitives: Primitive[];
  doubleSided: boolean;
  triangleCount: number;
}
export async function prepareGeometry(doc: BrkDocument, context: GeometryContext, options: MeshExportOptions) {
  const scene = collectScene(doc, options);
  const unit = options.unit ?? 'mm';
  const conversion = basis(unit);
  const convertNormal = normalTransform(conversion);
  const meshes = new Map<string, PreparedMesh>();
  const materials = new Map<string, Material>();
  const issues: IoIssue[] = [];
  const colors = new Map(context.colors?.map((color) => [color.id, color]));
  const byCode = new Map(context.colors?.map((color) => [color.ldrawCode, color]));
  const measured = new Map(context.factoryColors?.map((color) => [color.colorId, color.measuredRgb]));
  function material(colorId: string, edge = false): Material {
    const key = pairKey(colorId, edge ? 'edge' : 'face');
    const existing = materials.get(key);
    if (existing) return existing;
    const color = colors.get(colorId);
    const direct = /^#([\da-f]{6})$/i.test(colorId);
    const rgb = edge
      ? (color?.edgeRgb ?? '#333333')
      : (measured.get(colorId) ?? color?.rgb ?? (direct ? colorId : '#808080'));
    if (!/^#[\da-f]{6}$/i.test(rgb)) throw new RangeError(`Invalid display RGB: ${rgb}`);
    if (!color && !direct && !edge) issues.push(outputIssue('OUTPUT_COLOR_UNMAPPED', colorId));
    const alpha = edge ? 1 : (color?.alpha ?? 1);
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new RangeError('Invalid color alpha');
    const result: Material = {
      id: `material_${materials.size}`,
      colorId: edge ? `${colorId}:edge` : colorId,
      rgb: [1, 3, 5].map((i) => parseInt(rgb.slice(i, i + 2), 16) / 255) as [number, number, number],
      alpha,
    };
    materials.set(key, result);
    return result;
  }
  function batchMaterial(code: number | 'main' | 'edge', inherited: string): Material {
    if (code === 'main' || code === 16) return material(inherited);
    if (code === 'edge' || code === 24) return material(inherited, true);
    const color = byCode.get(code);
    return material(
      color?.id ??
        (code >= 0x2000000 && code <= 0x2ffffff ? `#${(code & 0xffffff).toString(16).padStart(6, '0')}` : `ld:${code}`),
    );
  }
  const sourceMeshes = new Map<string, Awaited<ReturnType<GeometryContext['meshProvider']>>>();
  const edgeWidth = options.edgeWidthLdu ?? 0.2;
  if (options.includeEdges && (!Number.isFinite(edgeWidth) || edgeWidth <= 0))
    throw new RangeError('Invalid edge width');
  for (const item of scene.parts) {
    if (item.ref.kind !== 'part') continue;
    const partId = item.ref.partId,
      key = pairKey(partId, item.colorId);
    if (meshes.has(key)) continue;
    if (!sourceMeshes.has(partId)) {
      const source = await context.meshProvider(partId);
      sourceMeshes.set(partId, source);
      if (!source) issues.push(outputIssue('OUTPUT_GEOMETRY_MISSING', partId));
      else if (
        source.diagnostics.missing.length ||
        source.diagnostics.cycles.length ||
        source.diagnostics.warnings.length
      )
        issues.push(outputIssue('OUTPUT_GEOMETRY_INCOMPLETE', partId));
    }
    const source = sourceMeshes.get(partId);
    if (!source) continue;
    const primitives: Primitive[] = [];
    for (const batch of source.batches) {
      if (!batch.indices.length) continue;
      if (batch.positions.length % 3 || batch.normals.length !== batch.positions.length || batch.indices.length % 3)
        throw new RangeError(`Invalid mesh arrays: ${partId}`);
      const primitive: Primitive = {
        material: batchMaterial(batch.color, item.colorId),
        positions: [],
        normals: [],
        indices: Array.from(batch.indices),
      };
      for (let i = 0; i < batch.positions.length; i += 3) {
        primitive.positions.push(...transformPoint(conversion, pointAt(batch.positions, i)));
        primitive.normals.push(...convertNormal(pointAt(batch.normals, i)));
      }
      if (primitive.indices.some((index) => index >= batch.positions.length / 3))
        throw new RangeError('Mesh index out of range');
      if (![...primitive.positions, ...primitive.normals].every(Number.isFinite))
        throw new RangeError('Non-finite mesh');
      primitives.push(primitive);
    }
    if (options.includeEdges) {
      for (const edge of source.edges) {
        const primitive: Primitive = {
          material: batchMaterial(edge.color, item.colorId),
          positions: [],
          normals: [],
          indices: [],
        };
        for (let i = 0; i < edge.positions.length; i += 6)
          addTube(primitive, pointAt(edge.positions, i), pointAt(edge.positions, i + 3), edgeWidth, conversion);
        if (primitive.indices.length) primitives.push(primitive);
      }
      // Conditional lines describe silhouettes dependent on the camera, not fixed physical edges.
      if (source.conditionalEdges.positions.length)
        issues.push(outputIssue('OUTPUT_CONDITIONAL_EDGES_OMITTED', partId));
    }
    if (primitives.length)
      meshes.set(key, {
        id: `geometry_${meshes.size}`,
        primitives,
        doubleSided: source.doubleSided,
        triangleCount: primitives.reduce((sum, p) => sum + p.indices.length / 3, 0),
      });
  }
  const meshFor = (node: Occurrence) =>
    node.ref.kind === 'part' ? meshes.get(pairKey(node.ref.partId, node.colorId)) : undefined;
  const stats: OutputStats = {
    byteLength: 0,
    triangleCount: scene.parts.reduce((sum, node) => sum + (meshFor(node)?.triangleCount ?? 0), 0),
    uniqueTriangleCount: [...meshes.values()].reduce((sum, mesh) => sum + mesh.triangleCount, 0),
    partCount: scene.parts.length,
    meshCount: meshes.size,
    issues,
  };
  return { ...scene, unit, meshes, materials, meshFor, stats };
}

function addTube(primitive: Primitive, a: Vec3, b: Vec3, width: number, conversion: Matrix4) {
  const cross = (u: Vec3, v: Vec3): Vec3 => [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const delta: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    length = Math.hypot(...delta);
  if (!length) return;
  const direction = delta.map((v) => v / length) as [number, number, number];
  const raw = cross(direction, Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
  const u = raw.map((v) => ((v / Math.hypot(...raw)) * width) / 2) as [number, number, number];
  const v = cross(direction, u);
  const vertices: Vec3[] = [a, b].flatMap((end) =>
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([x, y]) => [0, 1, 2].map((i) => end[i]! + x! * u[i]! + y! * v[i]!) as [number, number, number]),
  );
  for (const face of [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ]) {
    const points = face.map((i) => transformPoint(conversion, vertices[i]!));
    const p = points[0]!,
      q = points[1]!,
      r = points[2]!;
    const n = cross([q[0] - p[0], q[1] - p[1], q[2] - p[2]], [r[0] - p[0], r[1] - p[1], r[2] - p[2]]);
    const normal = n.map((x) => x / Math.hypot(...n));
    const base = primitive.positions.length / 3;
    primitive.positions.push(...points.flat());
    for (let i = 0; i < 4; i++) primitive.normals.push(...normal);
    primitive.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}
export function assertTransform(matrix: Matrix4) {
  if (!matrix.every(Number.isFinite) || Math.abs(determinant(matrix)) < 1e-12)
    throw new RangeError('Invalid or singular instance transform');
}
