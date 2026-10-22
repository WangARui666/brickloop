import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import {
  XmlBufferInputProvider,
  XmlDocument,
  XsdValidator,
  xmlCleanupInputProvider,
  xmlRegisterInputProvider,
} from 'libxml2-wasm';
import { describe, expect, it, vi } from 'vitest';
import { createDocument, fromLDraw, multiply, orderedInstances } from '@brickloop/core';
import { convertedMatrix } from '../src/output/geometry';
import { buildPartMesh } from '@brickloop/ldraw';
import { createLibraryResolver } from '@brickloop/ldraw/node';
import { calculateModelInfo, exportDae, exportGlb, exportObj, exportUnits } from '../src';
import { repo } from './helpers';
import { boxMesh, outputCatalog, outputContext, outputDoc, parseGlb, singleLdraw } from './output-helpers';

const validator = createRequire(import.meta.url)('gltf-validator') as {
  validateBytes(
    bytes: Uint8Array,
  ): Promise<{ issues: { numErrors: number; numWarnings: number; messages: unknown[] } }>;
};
const parseXml = (text: string) =>
  new DOMParser({
    onError: (_level, message) => {
      throw new Error(message);
    },
  }).parseFromString(text, 'application/xml');
const objVertices = (obj: string) =>
  obj
    .split('\n')
    .filter((line) => line.startsWith('v '))
    .map((line) => line.slice(2).split(' ').map(Number));

describe('M4-1a OBJ / MTL', () => {
  it('IO-03: measured display colors, alpha, expanded world transforms and instance names', async () => {
    const doc = outputDoc(),
      context = await outputContext();
    const result = await exportObj(doc, context);
    expect(result.mtl).toContain('Kd 0.8 0.266666666667 0.133333333333');
    expect(result.mtl).toContain('d 0.45');
    expect(result.obj.match(/^o /gm)).toHaveLength(4);
    expect(result.obj).toContain('o 3001_21_1');
    expect(result.obj).toContain('o 3001_24_4');
    const vertices = objVertices(result.obj);
    expect(Math.max(...vertices.map((v) => v[0]!))).toBe(56);
    expect(Math.max(...vertices.map((v) => v[1]!))).toBeCloseTo(11.2);
    expect(result.stats).toMatchObject({
      partCount: 4,
      meshCount: 2,
      triangleCount: 48,
      uniqueTriangleCount: 24,
      issues: [],
    });
    expect(result.stats.byteLength).toBe(Buffer.byteLength(result.obj) + Buffer.byteLength(result.mtl));
    expect((await exportObj(doc, context, { grouping: 'color' })).obj.match(/^o /gm)).toHaveLength(2);
  });
  it.each(['mm', 'cm', 'ldu'] as const)('IO-03: 3001 width is correct in %s', async (unit) => {
    const result = await exportObj(outputDoc(singleLdraw), await outputContext(), { unit });
    const xs = objVertices(result.obj).map((p) => p[0]!);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(80 * exportUnits[unit].perLdu);
  });
  it('excludes hidden paths by default, including descendants; keeps the other shared occurrence', async () => {
    const doc = outputDoc(),
      context = await outputContext();
    const root = orderedInstances(doc.models[doc.rootModelId]!);
    const hidden = [[root[0]!.id]];
    expect((await exportObj(doc, context, { workspace: { hidden } })).stats.partCount).toBe(2);
    expect((await exportObj(doc, context, { workspace: { hidden }, includeHidden: true })).stats.partCount).toBe(4);
  });
  it('exports fixed edge tubes only on request and caches geometry per PartId', async () => {
    const mesh = await boxMesh(),
      meshProvider = vi.fn(() => mesh),
      doc = outputDoc();
    const result = await exportObj(doc, { ...outputCatalog, meshProvider }, { includeEdges: true });
    expect(meshProvider).toHaveBeenCalledExactlyOnceWith('ld:3001');
    expect(result.stats.triangleCount).toBe(96);
    expect(result.mtl).toContain('0.2 0.2 0.2');
    expect(result.obj).not.toMatch(/^l /m);
    await expect(exportObj(doc, { meshProvider }, { edgeWidthLdu: 0, includeEdges: true })).rejects.toThrow(
      'edge width',
    );
  });
  it('keeps mirrored winding aligned with inverse-transpose normals under nonuniform scale', async () => {
    const doc = outputDoc('1 4 0 0 0 -2 0 0 0 3 0 0 0 1 3001.dat');
    const { obj } = await exportObj(doc, await outputContext());
    const vertices = objVertices(obj);
    const normals = obj
      .split('\n')
      .filter((line) => line.startsWith('vn '))
      .map((line) => line.slice(3).split(' ').map(Number));
    for (const face of obj.split('\n').filter((line) => line.startsWith('f '))) {
      const indices = face
        .slice(2)
        .split(' ')
        .map((token) => Number(token.split('//')[0]) - 1);
      const [a, b, c] = indices.map((index) => vertices[index]!);
      const ab = b!.map((v, i) => v - a![i]!),
        ac = c!.map((v, i) => v - a![i]!);
      const cross = [
        ab[1]! * ac[2]! - ab[2]! * ac[1]!,
        ab[2]! * ac[0]! - ab[0]! * ac[2]!,
        ab[0]! * ac[1]! - ab[1]! * ac[0]!,
      ];
      const normal = normals[indices[0]!]!;
      expect(cross.reduce((sum, value, i) => sum + value * normal[i]!, 0)).toBeGreaterThan(0);
      expect(Math.hypot(...normal)).toBeCloseTo(1);
    }
  });
  it('rejects unsafe MTL names and singular transforms; reports missing meshes without losing counts', async () => {
    await expect(exportObj(outputDoc(), await outputContext(), { materialFileName: '../x.mtl' })).rejects.toThrow(
      'basename',
    );
    const result = await exportObj(outputDoc(), { meshProvider: () => undefined });
    expect(result.stats).toMatchObject({ partCount: 4, triangleCount: 0 });
    expect(result.stats.issues.map((i) => i.code)).toEqual(['OUTPUT_GEOMETRY_MISSING']);
    await expect(exportObj(outputDoc('1 4 0 0 0 0 0 0 0 1 0 0 0 1 3001.dat'), await outputContext())).rejects.toThrow(
      'singular',
    );
  });
});

describe('M4-1a COLLADA', () => {
  it('IO-04: one geometry per part/color, one shared submodel definition, row-major node matrices', async () => {
    const { text, stats } = await exportDae(outputDoc(), await outputContext());
    const xml = parseXml(text);
    expect(xml.documentElement?.getAttribute('version')).toBe('1.4.1');
    expect(xml.getElementsByTagName('geometry').length).toBe(2);
    expect(xml.getElementsByTagName('instance_geometry').length).toBe(2);
    const refs = Array.from(xml.getElementsByTagName('instance_node'));
    expect(refs).toHaveLength(2);
    expect(refs[0]!.getAttribute('url')).toBe(refs[1]!.getAttribute('url'));
    const matrices = Array.from(xml.getElementsByTagName('matrix')).map((el) => el.textContent?.split(' ').map(Number));
    expect(matrices.some((m) => m?.[3] === 48 && m[7] === 9.6 && m[11] === -16)).toBe(true);
    expect(xml.getElementsByTagName('up_axis')[0]!.textContent).toBe('Y_UP');
    expect(xml.getElementsByTagName('phong').length).toBe(2);
    expect(xml.getElementsByTagName('transparency')[1]!.textContent).toBe('0.45');
    expect(stats.byteLength).toBe(Buffer.byteLength(text));
  });
  it.each(['mm', 'cm', 'ldu'] as const)('writes matching coordinates and meter metadata for %s', async (unit) => {
    const { text } = await exportDae(outputDoc(singleLdraw), await outputContext(), { unit });
    const xml = parseXml(text),
      meter = Number(xml.getElementsByTagName('unit')[0]!.getAttribute('meter'));
    const values = xml.getElementsByTagName('float_array')[0]!.textContent!.split(' ').map(Number);
    const xs = values.filter((_, i) => i % 3 === 0);
    expect((Math.max(...xs) - Math.min(...xs)) * meter).toBeCloseTo(0.032);
  });
  it('creates a shared-definition variant for visibility overrides and for inherited colors', async () => {
    const doc = outputDoc(),
      context = await outputContext(),
      roots = orderedInstances(doc.models[doc.rootModelId]!);
    const modelRef = roots[0]!.ref;
    if (modelRef.kind !== 'model') throw new Error('Expected model');
    const child = orderedInstances(doc.models[modelRef.modelId]!)[0]!;
    const hiddenResult = await exportDae(doc, context, { workspace: { hidden: [[roots[0]!.id, child.id]] } });
    expect(hiddenResult.stats.partCount).toBe(3);
    expect(parseXml(hiddenResult.text).getElementsByTagName('instance_geometry').length).toBe(3);
    roots[1]!.colorId = 'c:yellow';
    const xml = parseXml((await exportDae(doc, context)).text);
    expect(xml.getElementsByTagName('geometry').length).toBe(2);
    expect(xml.getElementsByTagName('instance_node')[0]!.getAttribute('url')).not.toBe(
      xml.getElementsByTagName('instance_node')[1]!.getAttribute('url'),
    );
  });
  const xsdPath = path.join(repo, '.devdata/io-schema/collada_schema_1_4_1.xsd');
  const xmlXsdPath = path.join(repo, '.devdata/io-schema/xml.xsd');
  const schemaAvailable = existsSync(xsdPath) && existsSync(xmlXsdPath);
  it.skipIf(!schemaAvailable)(
    `COLLADA 1.4.1 XSD: ${schemaAvailable ? 'official cached schema; valid and deliberately invalid documents' : 'SKIP: .devdata/io-schema missing; run node scripts/devenv.mjs pnpm --filter @brickloop/io schema:fetch'}`,
    async () => {
      xmlRegisterInputProvider(
        new XmlBufferInputProvider({ 'http://www.w3.org/2001/03/xml.xsd': await readFile(xmlXsdPath) }),
      );
      const schema = XmlDocument.fromBuffer(await readFile(xsdPath));
      let xsd: XsdValidator | undefined;
      try {
        xsd = XsdValidator.fromDoc(schema);
        const doc = outputDoc();
        doc.meta.title = '测试 & <模型> "名字"';
        for (const unit of ['mm', 'cm', 'ldu'] as const) {
          const { text } = await exportDae(doc, await outputContext(), { unit, includeEdges: true });
          const xml = XmlDocument.fromString(text);
          try {
            expect(() => xsd!.validate(xml)).not.toThrow();
          } finally {
            xml.dispose();
          }
        }
        const good = (await exportDae(doc, await outputContext())).text;
        for (const bad of [
          good.replace('version="1.4.1"', 'version="9.9.9"'),
          good.replace('<asset>', '<asset><invalid/>'),
          good.replace(/<created>.*?<\/created>/, ''),
        ]) {
          const xml = XmlDocument.fromString(bad);
          try {
            expect(() => xsd!.validate(xml)).toThrow();
          } finally {
            xml.dispose();
          }
        }
        const empty = XmlDocument.fromString((await exportDae(createDocument(), await outputContext())).text);
        try {
          expect(() => xsd!.validate(empty)).not.toThrow();
        } finally {
          empty.dispose();
        }
      } finally {
        xsd?.dispose();
        schema.dispose();
        xmlCleanupInputProvider();
      }
    },
  );
});

describe('M4-1a GLB', () => {
  it.each(['mm', 'cm', 'ldu'] as const)(
    'passes Khronos validator; shared mesh nodes and physical size for %s',
    async (unit) => {
      const result = await exportGlb(outputDoc(), await outputContext(), { unit });
      const report = await validator.validateBytes(result.bytes);
      expect(report.issues.numErrors, JSON.stringify(report.issues.messages)).toBe(0);
      expect(report.issues.numWarnings, JSON.stringify(report.issues.messages)).toBe(0);
      const glb = parseGlb(result.bytes);
      expect(glb.asset.version).toBe('2.0');
      expect(glb.extensionsUsed).toBeUndefined();
      expect(glb.meshes).toHaveLength(2);
      const instances = glb.nodes.filter((node) => node.mesh !== undefined);
      expect(instances).toHaveLength(4);
      expect(instances[0]!.mesh).toBe(instances[2]!.mesh);
      const accessor = glb.accessors![glb.meshes![0]!.primitives[0]!.attributes.POSITION]!;
      expect((accessor.max![0]! - accessor.min![0]!) * glb.nodes.at(-1)!.scale![0]!).toBeCloseTo(0.032);
      expect(glb.materials![0]!.pbrMetallicRoughness).toMatchObject({ metallicFactor: 0, roughnessFactor: 0.28 });
      expect(glb.materials![0]!.pbrMetallicRoughness.baseColorFactor[0]).toBeCloseTo(0.6038273);
      expect(glb.materials![1]!.alphaMode).toBe('BLEND');
      expect(glb.materials![1]!.pbrMetallicRoughness.baseColorFactor[3]).toBe(0.45);
      expect(result.stats.byteLength).toBe(result.bytes.length);
    },
  );
  it('validates empty, edge and mirrored exports', async () => {
    for (const doc of [createDocument(), outputDoc(), outputDoc('1 4 0 0 0 -1 0 0 0 1 0 0 0 1 3001.dat')]) {
      const { bytes } = await exportGlb(doc, await outputContext(), { includeEdges: true });
      const report = await validator.validateBytes(bytes);
      expect(report.issues.numErrors, JSON.stringify(report.issues.messages)).toBe(0);
    }
  });
  it.each(['10 -20 30 1 0.2 0 0 1 0 0 0 1', '40 24 -60 -2 0.7 0.3 0.4 3 -0.8 0.1 0.2 0.5'])(
    'represents shear with two valid TRS nodes sharing the original mesh: %s',
    async (transform) => {
      const { bytes } = await exportGlb(outputDoc(`1 4 ${transform} 3001.dat`), await outputContext());
      const report = await validator.validateBytes(bytes);
      expect(report.issues.numErrors, JSON.stringify(report.issues.messages)).toBe(0);
      expect(report.issues.numWarnings, JSON.stringify(report.issues.messages)).toBe(0);
      const glb = parseGlb(bytes);
      expect(glb.meshes).toHaveLength(1);
      expect(glb.nodes).toHaveLength(3);
      const actual = multiply(new Float64Array(glb.nodes[0]!.matrix!), new Float64Array(glb.nodes[1]!.matrix!));
      const expected = convertedMatrix(fromLDraw(transform.split(' ').map(Number)), 'mm');
      Array.from(actual).forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 8));
    },
  );
});

const library = path.join(repo, 'library/ldraw');
it.skipIf(!existsSync(path.join(library, 'parts/3001.dat')))(
  'IO-03 / INF-01: real read-only LDraw 3001 is 32 x 16 x 11.2 mm including studs',
  async () => {
    const mesh = await buildPartMesh('3001.dat', createLibraryResolver({ libraryDir: library }));
    expect(mesh.diagnostics.missing).toEqual([]);
    const context = { ...outputCatalog, meshProvider: () => mesh },
      doc = outputDoc(singleLdraw);
    const info = await calculateModelInfo(doc, context);
    expect(info.dimensions.mm).toEqual({ width: 32, depth: 16, height: 11.200000000000001 });
    const result = await exportObj(doc, context);
    const xs = objVertices(result.obj).map((point) => point[0]!);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(32);
  },
);
