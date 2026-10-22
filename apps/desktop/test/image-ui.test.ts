import { describe, expect, it } from 'vitest';
import { formatUsd } from '../src/renderer/src/ai-format';
import { mosaicPalette, mosaicTiles } from '../src/renderer/src/mosaic-catalog';
import type { LibraryColor, LibraryPart } from '../src/shared/library-api';
import { generateMosaic } from '@brickloop/mosaic';

describe('image and mosaic UI adapters', () => {
  it('formats small costs with up to two significant digits and normal costs in cents', () => {
    expect([0, 0.00243, 0.002, 0.00999, 0.01, 1.365, 0.00000024].map(formatUsd)).toEqual([
      '0.00',
      '0.0024',
      '0.002',
      '0.01',
      '0.01',
      '1.36',
      '0.00000024',
    ]);
  });
  it('MOS-01 only offers plain factory tiles and producible colors, independent of catalogue order', () => {
    const part = (id: LibraryPart['id'], nameEn: string, width: number): LibraryPart => ({
      id,
      nameEn,
      nameZh: nameEn,
      legoNo: id.slice(3),
      ldrawFile: `${id.slice(3)}.dat`,
      categoryId: 'tile',
      keywords: [],
      bboxLdu: [-10 * width, 0, -10, 10 * width, 8, 10],
      geometry: { source: 'ldraw', ref: '', hash: '' },
      connectorsRef: null,
      factoryNo: id,
    });
    const parts = [
      part('ld:3070b', 'Tile  1 x  1 with Groove', 1),
      part('ld:3069b', 'Tile 1 x 2 with Groove', 2),
      part('ld:pattern', 'Tile 1 x 2 with Pattern', 2),
      part('ld:free', 'Tile 1 x 1', 1),
    ];
    const catalog = {
      parts: parts.map((p) => ({ id: p.id, colors: ['c:red'], factory: p.id !== 'ld:free' })),
      colors: ['c:red', 'c:blue'],
    };
    const tiles = mosaicTiles(parts, catalog);
    expect(tiles.map((t) => t.partId)).toEqual(['ld:3070b', 'ld:3069b']);
    const colors: LibraryColor[] = [
      { id: 'c:red', rgb: '#C91A09' },
      { id: 'c:blue', rgb: '#0055BF' },
    ].map((c) => ({
      ...c,
      id: c.id as LibraryColor['id'],
      factoryCode: c.id,
      legoName: c.id,
      nameZh: c.id,
      legoColorId: null,
      ldrawCode: null,
      edgeRgb: '#333333',
      finish: 'solid',
      alpha: 1,
    }));
    const palette = mosaicPalette(colors, tiles, 'square');
    expect(palette.map((c) => c.id)).toEqual(['c:red']);
    const image = { width: 32, height: 32, data: new Uint8Array(32 * 32 * 4).fill(255) };
    const options = { width: 32, height: 32, palette, tiles, merge: true };
    const first = generateMosaic(image, options),
      second = generateMosaic(image, { ...options, tiles: [...tiles].reverse() });
    expect(first.pieces).toEqual(second.pieces);
    expect(first.pieces).toHaveLength(512);
    expect(new Set(first.cells.map((c) => c.colorId))).toEqual(new Set(['c:red']));
  });
});
