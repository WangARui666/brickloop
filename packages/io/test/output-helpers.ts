import { buildPartMesh, createMemorySource, LibraryResolver } from '@brickloop/ldraw';
import { importLDraw } from '../src';
import type { GeometryContext, OutputCatalog } from '../src';

export const outputCatalog: OutputCatalog = {
  parts: [{ id: 'ld:3001', legoNo: '3001', nameZh: '砖 2×4', nameEn: 'Brick 2 x 4', categoryId: '砖' }],
  colors: [
    {
      id: 'c:red',
      rgb: '#C91A09',
      edgeRgb: '#333333',
      alpha: 1,
      ldrawCode: 4,
      legoColorId: 21,
      legoName: 'Bright Red',
      nameZh: '亮红色',
    },
    {
      id: 'c:yellow',
      rgb: '#F2CD37',
      edgeRgb: '#444444',
      alpha: 0.45,
      ldrawCode: 14,
      legoColorId: 24,
      legoName: 'Bright Yellow',
      nameZh: '亮黄色',
    },
  ],
  factoryParts: [{ partId: 'ld:3001', factoryNo: '0001', status: 'active', colors: ['c:red'] }],
  factoryColors: [{ colorId: 'c:red', factoryCode: '001', measuredRgb: '#CC4422' }],
};
export const singleLdraw = '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat';
export const sharedLdraw = `0 FILE main.ldr
1 4 0 0 0 1 0 0 0 1 0 0 0 1 pair.ldr
1 4 120 -24 40 0 0 1 0 1 0 -1 0 0 pair.ldr
0 NOFILE
0 FILE pair.ldr
1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
1 14 80 0 0 1 0 0 0 1 0 0 0 1 3001.dat
0 NOFILE`;
export function outputDoc(text = sharedLdraw) {
  const doc = importLDraw(text, 'output.mpd', {
    parts: [{ id: 'ld:3001', ldrawFile: '3001.dat' }],
    colors: outputCatalog.colors!,
  }).doc;
  if (!doc) throw new Error('Invalid output fixture');
  return doc;
}
// Authored here: a closed box with 3001's outside extents, plus one hard edge.
// Real official 3001 geometry is checked separately when the read-only library is available.
export async function boxMesh() {
  const text = `0 Export fixture
0 BFC CERTIFY CCW
4 16 -40 -4 -20 -40 -4 20 40 -4 20 40 -4 -20
4 16 -40 24 -20 40 24 -20 40 24 20 -40 24 20
4 16 -40 -4 -20 40 -4 -20 40 24 -20 -40 24 -20
4 16 40 -4 20 -40 -4 20 -40 24 20 40 24 20
4 16 -40 -4 20 -40 -4 -20 -40 24 -20 -40 24 20
4 16 40 -4 -20 40 -4 20 40 24 20 40 24 -20
2 24 -40 -4 -20 40 -4 -20`;
  return buildPartMesh(
    'box.dat',
    new LibraryResolver({ library: createMemorySource('output-test', { 'parts/box.dat': text }) }),
  );
}
export async function outputContext(): Promise<GeometryContext> {
  const mesh = await boxMesh();
  return { ...outputCatalog, meshProvider: (partId) => (partId === 'ld:3001' ? mesh : undefined) };
}
/** A valid 1x1 PNG; tests don't call a renderer or use copyrighted thumbnails. */
export const fakePng = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'),
);

export interface ParsedGlb {
  asset: { version: string; extras: { sourceUnit: string } };
  meshes?: { primitives: { attributes: { POSITION: number; NORMAL: number }; indices: number; material: number }[] }[];
  materials?: {
    pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number; roughnessFactor: number };
    alphaMode: string;
  }[];
  accessors?: { bufferView: number; count: number; min?: number[]; max?: number[] }[];
  nodes: { mesh?: number; matrix?: number[]; scale?: number[]; children?: number[] }[];
  buffers?: { byteLength: number }[];
  extensionsUsed?: string[];
}
export function parseGlb(bytes: Uint8Array): ParsedGlb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.length
  )
    throw new Error('Invalid GLB header');
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || length % 4) throw new Error('Invalid JSON chunk');
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as ParsedGlb;
}
