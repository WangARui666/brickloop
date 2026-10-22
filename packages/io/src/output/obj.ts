import { determinant, transformPoint } from '@brickloop/core';
import type { BrkDocument } from '@brickloop/core';
import { utf8 } from '../binary';
import { assertTransform, convertedMatrix, normalTransform, numbers, pointAt, prepareGeometry } from './geometry';
import type { GeometryContext, MeshExportOptions, OutputStats } from './types';

export interface ObjOptions extends MeshExportOptions {
  grouping?: 'instance' | 'color';
  /** Basename of the accompanying MTL file; whitespace and path separators are rejected. */
  materialFileName?: string;
}
export interface ObjResult {
  obj: string;
  mtl: string;
  stats: OutputStats;
}
const token = (value: string) => value.replace(/[^\p{L}\p{N}_.-]/gu, '_');
export async function exportObj(
  doc: BrkDocument,
  context: GeometryContext,
  options: ObjOptions = {},
): Promise<ObjResult> {
  const filename = options.materialFileName ?? 'model.mtl';
  if (!/^[^\s/\\#]+\.mtl$/i.test(filename)) throw new RangeError('Expected a safe MTL basename');
  const scene = await prepareGeometry(doc, context, options);
  const lines = [`# Brickloop OBJ; Y up; unit ${scene.unit}`, `mtllib ${filename}`];
  const groups = new Map<string, string[]>();
  const partById = new Map(context.parts?.map((part) => [part.id, part]));
  const colorById = new Map(context.colors?.map((color) => [color.id, color]));
  let vertexOffset = 1;
  for (const [ordinal, node] of scene.parts.entries()) {
    const mesh = scene.meshFor(node);
    if (!mesh || node.ref.kind !== 'part') continue;
    const matrix = convertedMatrix(node.worldMatrix, scene.unit);
    assertTransform(matrix);
    const mirrored = determinant(matrix) < 0;
    const convertNormal = normalTransform(matrix);
    const part = partById.get(node.ref.partId),
      color = colorById.get(node.colorId);
    const name = `${token(part?.legoNo ?? node.ref.partId)}_${token(String(color?.legoColorId ?? color?.ldrawCode ?? node.colorId))}_${ordinal + 1}`;
    for (const primitive of mesh.primitives) {
      for (let i = 0; i < primitive.positions.length; i += 3)
        lines.push(`v ${numbers(transformPoint(matrix, pointAt(primitive.positions, i)))}`);
      for (let i = 0; i < primitive.normals.length; i += 3)
        lines.push(`vn ${numbers(convertNormal(pointAt(primitive.normals, i)))}`);
      const groupName = options.grouping === 'color' ? primitive.material.id : name;
      let faces = groups.get(groupName);
      if (!faces) {
        faces = [];
        groups.set(groupName, faces);
      }
      faces.push(`usemtl ${primitive.material.id}`);
      for (let i = 0; i < primitive.indices.length; i += 3) {
        const indices = [
          primitive.indices[i]!,
          primitive.indices[i + (mirrored ? 2 : 1)]!,
          primitive.indices[i + (mirrored ? 1 : 2)]!,
        ];
        faces.push(`f ${indices.map((index) => `${index + vertexOffset}//${index + vertexOffset}`).join(' ')}`);
      }
      vertexOffset += primitive.positions.length / 3;
    }
  }
  for (const [name, faces] of groups) lines.push(`o ${name}`, ...faces);
  const obj = lines.join('\n') + '\n';
  const mtl = [...scene.materials.values()]
    .map((material) =>
      [
        `newmtl ${material.id}`,
        `# ${token(material.colorId)}`,
        `Kd ${numbers(material.rgb)}`,
        'Ka 0 0 0',
        'Ks 0.04 0.04 0.04',
        'Ns 60',
        `d ${material.alpha}`,
        'illum 2',
        '',
      ].join('\n'),
    )
    .join('\n');
  return { obj, mtl, stats: { ...scene.stats, byteLength: utf8(obj).length + utf8(mtl).length } };
}
