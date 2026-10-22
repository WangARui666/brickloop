import { createCatalogIndex } from '../src/catalog-index';
import { parseLDConfig } from '../src/colors';
import type { Pack } from '../src/types';

export const catalog = createCatalogIndex([
  { file: '3001.dat', source: '0 Brick 2 x 4\n0 !LDRAW_ORG Part\n0 !CATEGORY Brick\n0 !KEYWORDS basic, rectangle' },
  { file: '3002.dat', source: '0 Brick 2 x 3\n0 !LDRAW_ORG Part' },
  { file: '3003.dat', source: '0 Brick 2 x 2\n0 !LDRAW_ORG Part' },
  { file: '3023b.dat', source: '0 Plate 1 x 2\n0 !LDRAW_ORG Part' },
  { file: '3068b.dat', source: '0 Tile 2 x 2\n0 !LDRAW_ORG Part' },
  { file: '3626a.dat', source: '0 Minifig Head\n0 !LDRAW_ORG Part' },
  { file: '3626b.dat', source: '0 Minifig Head Hollow\n0 !LDRAW_ORG Part' },
  { file: '3626bpr0001.dat', source: '0 Minifig Head with Pattern\n0 !LDRAW_ORG Part' },
  { file: '999.dat', source: '0 Brick Alias\n0 !LDRAW_ORG Part Alias\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat' },
  { file: 'excluded.dat', source: '0 ~Brick Internal\n0 !LDRAW_ORG Subpart' },
  { file: 'moved.dat', source: '0 Moved to 3001\n0 !LDRAW_ORG Part' },
  { file: 'primitive.dat', source: '0 Circle\n0 !LDRAW_ORG Primitive' },
]);

export const colors = parseLDConfig(`0 // LEGOID 21 - Bright Red
0 !COLOUR Red CODE 4 VALUE #B40000 EDGE #333333
0 // LEGOID 23 - Bright Blue
0 !COLOUR Blue CODE 1 VALUE #1E5AA8 EDGE #333333
0 // LEGOID 40 - Transparent
0 !COLOUR Trans_Clear CODE 47 VALUE #FCFCFC EDGE #C9C9C9 ALPHA 128
0 !COLOUR Mystery CODE 999 VALUE #123456 EDGE 4 METAL
`);

export function fixturePack(id = 'fixture'): Pack {
  return {
    manifest: {
      id,
      name: '测试工厂',
      version: '1.0',
      source: '测试夹具',
      createdAt: '2026-05-29T00:00:00.000Z',
      templateVersion: 1,
      contentHash: '',
    },
    parts: [
      {
        partId: 'ld:3001',
        factoryNo: 'F001',
        factoryName: '砖 2×4',
        legoNo: '3001',
        ldrawFile: '3001.dat',
        status: 'active',
        colors: ['c:bright-red', 'c:bright-blue'],
      },
      {
        partId: 'ld:3068b',
        factoryNo: 'F002',
        factoryName: '平滑板 2×2',
        legoNo: '3068b',
        ldrawFile: '3068b.dat',
        status: 'pending',
        colors: ['c:bright-red'],
      },
    ],
    colors: colors
      .filter((color) => color.legoName !== null)
      .map((color, i) => ({
        colorId: color.id,
        factoryCode: `C${i + 1}`,
        measuredRgb: color.rgb,
        definition: { ...color },
      })),
    categories: [],
    assets: {},
  };
}
