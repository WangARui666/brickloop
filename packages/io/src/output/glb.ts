import type { BrkDocument } from '@brickloop/core';
import { utf8 } from '../binary';
import { convertedMatrix, exportUnits, prepareGeometry } from './geometry';
import { gltfTransforms } from './gltf-transform';
import type { GeometryContext, MeshExportOptions, OutputStats } from './types';

export interface GlbResult {
  bytes: Uint8Array;
  stats: OutputStats;
}
interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC3';
  min?: number[];
  max?: number[];
}
const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
export async function exportGlb(
  doc: BrkDocument,
  context: GeometryContext,
  options: MeshExportOptions = {},
): Promise<GlbResult> {
  const scene = await prepareGeometry(doc, context, options);
  const chunks: Uint8Array[] = [];
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number; target: number }[] = [];
  const accessors: Accessor[] = [];
  let byteLength = 0;
  function accessor(values: number[], indices = false, bounds = false): number {
    const bytes = new Uint8Array(values.length * 4),
      view = new DataView(bytes.buffer);
    values.forEach((value, index) =>
      indices ? view.setUint32(index * 4, value, true) : view.setFloat32(index * 4, value, true),
    );
    const item: Accessor = {
      bufferView: bufferViews.length,
      componentType: indices ? 5125 : 5126,
      count: values.length / (indices ? 1 : 3),
      type: indices ? 'SCALAR' : 'VEC3',
    };
    if (bounds) {
      item.min = [Infinity, Infinity, Infinity];
      item.max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < values.length; i++) {
        const value = view.getFloat32(i * 4, true),
          axis = i % 3;
        item.min[axis] = Math.min(item.min[axis]!, value);
        item.max[axis] = Math.max(item.max[axis]!, value);
      }
    }
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target: indices ? 34963 : 34962 });
    chunks.push(bytes);
    byteLength += bytes.length;
    accessors.push(item);
    return accessors.length - 1;
  }
  const materialList = [...scene.materials.values()];
  const materialIndex = new Map(materialList.map((m, index) => [m.id, index]));
  const meshIndex = new Map<string, number>();
  const meshes = [...scene.meshes.values()].map((mesh, index) => {
    meshIndex.set(mesh.id, index);
    return {
      name: mesh.id,
      primitives: mesh.primitives.map((primitive) => ({
        attributes: { POSITION: accessor(primitive.positions, false, true), NORMAL: accessor(primitive.normals) },
        indices: accessor(primitive.indices, true),
        material: materialIndex.get(primitive.material.id)!,
        mode: 4,
      })),
    };
  });
  const doubleSidedMaterials = new Set(
    [...scene.meshes.values()]
      .filter((mesh) => mesh.doubleSided)
      .flatMap((mesh) => mesh.primitives.map((p) => p.material.id)),
  );
  const materials = materialList.map((m) => ({
    name: m.colorId,
    pbrMetallicRoughness: {
      baseColorFactor: [...m.rgb.map(linear), m.alpha],
      metallicFactor: 0,
      roughnessFactor: 0.28,
    },
    alphaMode: m.alpha < 1 ? 'BLEND' : 'OPAQUE',
    doubleSided: doubleSidedMaterials.has(m.id),
  }));
  const nodes: { name: string; mesh?: number; matrix?: number[]; children?: number[]; scale?: number[] }[] = [];
  const rootChildren: number[] = [];
  for (const node of scene.parts) {
    const mesh = scene.meshFor(node);
    if (!mesh) continue;
    const matrix = convertedMatrix(node.worldMatrix, scene.unit);
    const transforms = gltfTransforms(matrix);
    rootChildren.push(nodes.length);
    for (const [index, transform] of transforms.entries())
      nodes.push({
        name: node.path.join('/'),
        matrix: Array.from(transform),
        ...(index === transforms.length - 1 ? { mesh: meshIndex.get(mesh.id)! } : { children: [nodes.length + 1] }),
      });
  }
  const rootIndex = nodes.length;
  const root: (typeof nodes)[number] = {
    name: doc.meta.title,
    scale: Array(3).fill(exportUnits[scene.unit].meter) as number[],
  };
  if (nodes.length) root.children = rootChildren;
  nodes.push(root);
  const model = {
    asset: { version: '2.0', generator: 'Brickloop', extras: { sourceUnit: scene.unit } },
    scene: 0,
    scenes: [{ nodes: [rootIndex] }],
    nodes,
    ...(meshes.length ? { meshes, materials, accessors, bufferViews, buffers: [{ byteLength }] } : {}),
  };
  const json = utf8(JSON.stringify(model)),
    jsonLength = Math.ceil(json.length / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + jsonLength + (byteLength ? 8 + byteLength : 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(json, 20);
  if (byteLength) {
    let offset = 20 + jsonLength;
    view.setUint32(offset, byteLength, true);
    view.setUint32(offset + 4, 0x004e4942, true);
    offset += 8;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  }
  return { bytes, stats: { ...scene.stats, byteLength: bytes.length } };
}
