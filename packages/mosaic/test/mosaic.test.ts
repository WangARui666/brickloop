import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import jpeg from 'jpeg-js';
import {
  createDocument,
  createUlidGenerator,
  DocumentSession,
  expandInstances,
  validateDocument,
} from '@brickloop/core';
import {
  decodeImage,
  deltaE2000,
  generateMosaic,
  mergeTiles,
  mosaicToOps,
  resizeImage,
  rgbToLab,
  type Lab,
  type MosaicOptions,
  type RgbaImage,
} from '../src/index.js';

const palette = [
  { id: 'ld:0', rgb: [0, 0, 0] as const },
  { id: 'ld:15', rgb: [255, 255, 255] as const },
  { id: 'ld:4', rgb: [200, 0, 0] as const },
];
const tiles = [
  { partId: 'ld:3070b', width: 1, height: 1, colorIds: palette.map((c) => c.id) },
  { partId: 'ld:3068b', width: 2, height: 2, colorIds: ['ld:4', 'ld:15'] },
  { partId: 'ld:3069b', width: 2, height: 1, colorIds: ['ld:4', 'ld:15'] },
];
function picture(width = 32, height = 32): RgbaImage {
  return {
    width,
    height,
    data: Uint8Array.from({ length: width * height * 4 }, (_, i) =>
      i % 4 === 3 ? 255 : (Math.floor(i / 4) * 17 + (i % 4) * 43) % 256,
    ),
  };
}
describe('color and decoding', () => {
  // Numerical examples from Sharma et al.'s published CIEDE2000 supplementary test data.
  it.each<[Lab, Lab, number]>([
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
  ])('matches reference Lab values %#', (a, b, expected) => {
    expect(deltaE2000(a, b)).toBeCloseTo(expected, 4);
    expect(deltaE2000(b, a)).toBeCloseTo(expected, 4);
  });
  it('uses D65 sRGB and zero distance for identical colors', () => {
    expect(rgbToLab([255, 255, 255])[0]).toBeCloseTo(100, 4);
    expect(deltaE2000(rgbToLab([80, 120, 250]), rgbToLab([80, 120, 250]))).toBe(0);
  });
  it('decodes lossless RGBA PNG and JPEG without browser APIs', () => {
    const source = picture(8, 8);
    expect(decodeImage(encode({ ...source, channels: 4, depth: 8 }))).toEqual(source);
    const decoded = decodeImage(jpeg.encode(source, 95).data);
    expect([decoded.width, decoded.height, decoded.data.length]).toEqual([8, 8, 256]);
    expect(decoded.data.filter((_, i) => i % 4 === 3).every((v) => v === 255)).toBe(true);
  });
  it('normalizes indexed, low-bit grayscale and 16-bit PNG', () => {
    const indexed = encode({
      width: 2,
      height: 1,
      data: new Uint8Array([0, 1]),
      channels: 1,
      depth: 8,
      palette: [
        [255, 0, 0, 0],
        [0, 0, 255, 255],
      ],
    });
    expect([...decodeImage(indexed).data]).toEqual([255, 0, 0, 0, 0, 0, 255, 255]);
    const gray = encode({ width: 3, height: 1, data: new Uint8Array([0b10100000]), channels: 1, depth: 1 });
    expect([...decodeImage(gray).data]).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    expect([
      ...decodeImage(
        encode({ width: 1, height: 1, data: new Uint16Array([65535, 32768, 0, 65535]), depth: 16, channels: 4 }),
      ).data,
    ]).toEqual([255, 128, 0, 255]);
  });
  it('area averages, flattens transparency, and rejects malformed input', () => {
    expect([
      ...resizeImage({ width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0]) }, 1, 1).data,
    ]).toEqual([128, 128, 128, 255]);
    expect(() => decodeImage(new Uint8Array([1, 2]))).toThrow();
    expect(() => resizeImage(picture(), 0, 32)).toThrow();
    expect(() => resizeImage({ width: 2, height: 2, data: new Uint8Array(1) }, 1, 1)).toThrow();
  });
});
describe('MOS-01 and insertion', () => {
  it.each([false, true])('maps 32x32 to only supplied pack colors deterministically (dither=%s)', (dither) => {
    const input = picture();
    const before = input.data.slice();
    const options: MosaicOptions = { width: 32, height: 32, palette, tiles, dither, merge: true };
    const a = generateMosaic(input, options),
      b = generateMosaic(input, { ...options, palette: [...palette].reverse(), tiles: [...tiles].reverse() });
    expect(a).toEqual(b);
    expect(a.cells).toHaveLength(1024);
    expect(new Set(a.cells.map((c) => c.colorId))).toEqual(new Set(palette.map((c) => c.id)));
    expect(a.pieces.reduce((n, p) => n + p.width * p.height, 0)).toBe(1024);
    expect(input.data).toEqual(before);
  });
  it('has deterministic exact-color ties and applies error diffusion only when enabled', () => {
    const mid = { width: 8, height: 8, data: new Uint8Array(256).fill(128) };
    for (let i = 3; i < 256; i += 4) mid.data[i] = 255;
    const options = { width: 8, height: 8, palette: palette.slice(0, 2), tiles };
    expect(new Set(generateMosaic(mid, options).cells.map((c) => c.colorId)).size).toBe(1);
    expect(new Set(generateMosaic(mid, { ...options, dither: true }).cells.map((c) => c.colorId)).size).toBe(2);
  });
  it('greedily covers rectangles without crossing color boundaries or unavailable combinations', () => {
    const cells = Array.from({ length: 12 }, (_, i) => ({ colorId: i % 4 === 3 ? 'ld:0' : 'ld:4' }));
    const pieces = mergeTiles(cells, 4, 3, tiles);
    expect(pieces[0]).toMatchObject({ x: 0, y: 0, width: 2, height: 2, partId: 'ld:3068b' });
    const covered = new Array<string | undefined>(12);
    for (const p of pieces)
      for (let y = p.y; y < p.y + p.height; y++)
        for (let x = p.x; x < p.x + p.width; x++) {
          expect(covered[y * 4 + x]).toBeUndefined();
          covered[y * 4 + x] = p.colorId;
        }
    expect(covered).toEqual(cells.map((c) => c.colorId));
    expect(pieces.filter((p) => p.colorId === 'ld:0').every((p) => p.width * p.height === 1)).toBe(true);
  });
  it('selects round pieces, disables rectangular merging, and rejects missing colors', () => {
    const round = {
      partId: 'ld:98138',
      width: 1,
      height: 1,
      colorIds: palette.map((c) => c.id),
      style: 'round' as const,
    };
    const mosaic = generateMosaic(picture(4, 4), {
      width: 4,
      height: 4,
      palette,
      tiles: [...tiles, round],
      style: 'round',
      merge: true,
    });
    expect(mosaic.pieces).toHaveLength(16);
    expect(mosaic.pieces.every((p) => p.partId === round.partId)).toBe(true);
    expect(() => generateMosaic(picture(), { width: 2, height: 2, palette, tiles: tiles.slice(1) })).toThrow();
  });
  it('inserts a valid submodel and undoes it in one transaction', () => {
    const doc = createDocument(),
      session = new DocumentSession(doc);
    const mosaic = generateMosaic(picture(4, 4), { width: 4, height: 4, palette, tiles });
    const insertion = () =>
      mosaicToOps(mosaic, {
        name: '马赛克',
        parentModelId: doc.rootModelId,
        parentStepId: doc.models[doc.rootModelId]!.stepIds[0]!,
        id: createUlidGenerator({ clock: () => 123, random: () => 0.3 }),
      });
    expect(insertion()).toEqual(insertion());
    expect(session.applyExternal(insertion().ops, '马赛克', 'import').ok).toBe(true);
    expect(validateDocument(session.document)).toEqual([]);
    expect(expandInstances(session.document)).toHaveLength(16);
    expect(session.history).toHaveLength(1);
    expect(session.undo().ok).toBe(true);
    expect(session.document.models).toEqual(doc.models);
  });
});
