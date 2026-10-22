import { DOMParser } from '@xmldom/xmldom';
import type { BrkDocument, Matrix4 } from '@brickloop/core';
import { utf8 } from '../binary';
import { assertTransform, convertedMatrix, exportUnits, numbers, prepareGeometry } from './geometry';
import type { GeometryContext, MeshExportOptions, Occurrence, OutputStats } from './types';

export interface DaeOptions extends MeshExportOptions {
  createdAt?: string;
}
export interface DaeResult {
  text: string;
  stats: OutputStats;
}
const xml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!,
  );
// All name attributes are xs:NCName, including human-facing names and numeric ULIDs.
const xmlName = (value: string) => 'n_' + value.replace(/[^\p{L}\p{N}_.-]/gu, '_');
/** COLLADA serializes row-major matrices; core and glTF store column-major. */
const matrixText = (matrix: Matrix4) =>
  numbers(Array.from({ length: 16 }, (_, i) => matrix[(i % 4) * 4 + Math.floor(i / 4)]!));

export async function exportDae(
  doc: BrkDocument,
  context: GeometryContext,
  options: DaeOptions = {},
): Promise<DaeResult> {
  const scene = await prepareGeometry(doc, context, options);
  const date = options.createdAt ?? '2000-01-01T00:00:00.000Z';
  if (!Number.isFinite(Date.parse(date))) throw new RangeError('Invalid COLLADA creation date');
  const timestamp = new Date(date).toISOString();
  const effects = [...scene.materials.values()]
    .map(
      (m) =>
        `<effect id="${m.id}_effect"><profile_COMMON><technique sid="common"><phong><diffuse><color>${numbers(m.rgb)} 1</color></diffuse><specular><color>0.04 0.04 0.04 1</color></specular><shininess><float>60</float></shininess><transparent opaque="A_ONE"><color>1 1 1 1</color></transparent><transparency><float>${m.alpha}</float></transparency></phong></technique></profile_COMMON></effect>`,
    )
    .join('');
  const materials = [...scene.materials.values()]
    .map(
      (m) => `<material id="${m.id}" name="${xmlName(m.colorId)}"><instance_effect url="#${m.id}_effect"/></material>`,
    )
    .join('');
  const geometries = [...scene.meshes.values()]
    .map((mesh) => {
      const sources: string[] = [],
        triangles: string[] = [];
      const positions: number[] = [],
        normals: number[] = [];
      for (const primitive of mesh.primitives) {
        const offset = positions.length / 3;
        positions.push(...primitive.positions);
        normals.push(...primitive.normals);
        const indices = primitive.indices.flatMap((i) => [i + offset, i + offset]);
        triangles.push(
          `<triangles count="${primitive.indices.length / 3}" material="${primitive.material.id}"><input semantic="VERTEX" source="#${mesh.id}_vertices" offset="0"/><input semantic="NORMAL" source="#${mesh.id}_normals" offset="1"/><p>${indices.join(' ')}</p></triangles>`,
        );
      }
      for (const [suffix, values] of [
        ['positions', positions],
        ['normals', normals],
      ] as const) {
        const id = `${mesh.id}_${suffix}`;
        sources.push(
          `<source id="${id}"><float_array id="${id}_array" count="${values.length}">${numbers(values)}</float_array><technique_common><accessor source="#${id}_array" count="${values.length / 3}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>`,
        );
      }
      return `<geometry id="${mesh.id}"><mesh>${sources.join('')}<vertices id="${mesh.id}_vertices"><input semantic="POSITION" source="#${mesh.id}_positions"/></vertices>${triangles.join('')}</mesh></geometry>`;
    })
    .join('');
  const definitions = new Map<string, { id: string; text: string }>();
  function content(node: Occurrence): string {
    if (node.ref.kind === 'part') {
      const mesh = scene.meshFor(node);
      if (!mesh) return '';
      const bindings = [...new Set(mesh.primitives.map((p) => p.material.id))]
        .map((id) => `<instance_material symbol="${id}" target="#${id}"/>`)
        .join('');
      return `<instance_geometry url="#${mesh.id}"><bind_material><technique_common>${bindings}</technique_common></bind_material></instance_geometry>`;
    }
    const children = node.children.map((child) => nodeXml(child, child.localMatrix)).join('');
    // Visibility overrides and inherited colors form variants, without affecting other occurrences.
    const key = JSON.stringify([node.ref.modelId, children]);
    let definition = definitions.get(key);
    if (!definition) {
      const id = `model_${definitions.size}`;
      definition = { id, text: `<node id="${id}" name="${xmlName(node.name)}">${children}</node>` };
      definitions.set(key, definition);
    }
    return `<instance_node url="#${definition.id}"/>`;
  }
  function nodeXml(node: Occurrence, matrix: Matrix4): string {
    assertTransform(matrix);
    return `<node name="${xmlName(node.name)}"><matrix>${matrixText(convertedMatrix(matrix, scene.unit))}</matrix>${content(node)}</node>`;
  }
  const nodes = scene.roots.map((node) => nodeXml(node, node.worldMatrix)).join('');
  const library = (name: string, value: string) => (value ? `<library_${name}>${value}</library_${name}>` : '');
  const text = `<?xml version="1.0" encoding="utf-8"?>\n<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><asset><contributor><authoring_tool>Brickloop</authoring_tool></contributor><created>${timestamp}</created><modified>${timestamp}</modified><title>${xml(doc.meta.title)}</title><unit name="${scene.unit}" meter="${exportUnits[scene.unit].meter}"/><up_axis>Y_UP</up_axis></asset>${library('effects', effects)}${library('materials', materials)}${library('geometries', geometries)}${library('nodes', [...definitions.values()].map((value) => value.text).join(''))}<library_visual_scenes><visual_scene id="Scene"><node name="${xmlName(doc.meta.title)}">${nodes}</node></visual_scene></library_visual_scenes><scene><instance_visual_scene url="#Scene"/></scene></COLLADA>\n`;
  // Parse every generated file, including namespace correctness. XSD validation is in tests.
  new DOMParser({
    onError: (level, message) => {
      throw new Error(`COLLADA XML ${level}: ${message}`);
    },
  }).parseFromString(text, 'application/xml');
  return { text, stats: { ...scene.stats, byteLength: utf8(text).length } };
}
