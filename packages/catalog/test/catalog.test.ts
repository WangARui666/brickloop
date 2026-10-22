import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCatalogIndex, createCatalogIndex, matchLegoNumber, repositoryRoot } from '../src/catalog-index';
import { CatalogService, impactOf } from '../src/catalog-service';
import { COLOR_NAMES_ZH, colorNameZh } from '../src/color-names-zh';
import { legoColorIdFromName, parseLDConfig } from '../src/colors';
import { parseLDrawHeader, printedBase } from '../src/ldraw-headers';
import { translateTitle } from '../src/terms-zh';
import { catalog, colors, fixturePack } from './fixtures';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('LDraw 目录和中文术语', () => {
  it('头信息、类别优先、别名、过滤与印刷基础件', () => {
    const header = parseLDrawHeader(
      '0 Tile Round\n0 !CATEGORY Plate\n0 !KEYWORDS round, smooth\n0 !KEYWORDS disk\n0 // LEGOID 123 / 456\n0 !LDRAW_ORG Part',
    );
    expect(header).toMatchObject({ category: 'Plate', keywords: ['round', 'smooth', 'disk'], legoIds: ['123', '456'] });
    expect(createCatalogIndex([{ file: 'XYZ.dat', source: '0 Tile Round\n0 !CATEGORY Plate' }]).parts[0]).toMatchObject(
      { id: 'ld:xyz', categoryId: 'plate' },
    );
    expect(catalog.parts).toHaveLength(8);
    expect(catalog.aliases['ld:999']).toBe('ld:3001');
    expect(matchLegoNumber(catalog, '999')).toEqual(['ld:3001']);
    expect(printedBase('3626bpr0001.dat')).toBe('ld:3626b');
    expect(printedBase('3001p01.dat')).toBe('ld:3001');
    expect(catalog.parts.find((part) => part.id === 'ld:3626bpr0001')?.flags).toContain('printed');
  });

  it.each([
    ['Brick 2 x 4', '砖 2×4'],
    ['Plate 1 x 2 with Clip', '板 1×2 带夹'],
    ['Slope 45 2 x 1', '斜面 45° 2×1'],
    ['Tile 1 x 1 Round', '圆形平滑板 1×1'],
    ['Brick Mystery with Studs on Side', '砖 Mystery 带 侧面凸点'],
  ])('翻译 %s', (title, expected) => expect(translateTitle(title)).toBe(expected));

  it('FAC-02 一对多设计编号保留 alternates', () => {
    expect(matchLegoNumber(catalog, '3626')).toEqual(['ld:3626a', 'ld:3626b']);
    expect(catalog.parts.find((part) => part.id === 'ld:3626a')?.alternates).toEqual(['ld:3626b']);
    expect(matchLegoNumber(catalog, '3626bpr0001')).toEqual(['ld:3626bpr0001']);
  });

  it('缓存复用、版本更新和损坏缓存重建', async () => {
    const base = path.join(repositoryRoot, '.devdata/catalog-tests');
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(path.join(base, 'index-'));
    dirs.push(dir);
    const libraryDir = path.join(dir, 'library');
    const cacheDir = path.join(dir, 'cache');
    await mkdir(path.join(libraryDir, 'parts'), { recursive: true });
    await writeFile(path.join(libraryDir, 'LDConfig.ldr'), '0 !LDRAW_ORG Configuration UPDATE 2026-01');
    await writeFile(path.join(libraryDir, 'parts/3001.dat'), '0 Brick 2 x 4\n0 !LDRAW_ORG Part');
    const first = await buildCatalogIndex({ libraryDir, cacheDir });
    expect(await buildCatalogIndex({ libraryDir, cacheDir })).toEqual(first);
    await writeFile(path.join(cacheDir, `${first.libraryVersion}.json`), '{broken');
    expect(await buildCatalogIndex({ libraryDir, cacheDir })).toEqual(first);
    await writeFile(path.join(libraryDir, 'LDConfig.ldr'), '0 !LDRAW_ORG Configuration UPDATE 2026-02');
    const updated = await buildCatalogIndex({ libraryDir, cacheDir });
    expect(updated.libraryVersion).not.toBe(first.libraryVersion);
    expect(await readdir(cacheDir)).toHaveLength(2);
  });
});

describe('颜色', () => {
  it('LEGOID 多编号、稳定短名、中文回退与颜色代码边线', () => {
    const parsed = parseLDConfig(
      '0 // LEGOID 1 / 426 - White\n0 !COLOUR Arbitrary CODE 15 VALUE #FFFFFF EDGE #000000\n0 !COLOUR Mystery CODE 999 VALUE #123456 EDGE 15',
    );
    expect(parsed[0]).toMatchObject({ id: 'c:white', legoColorId: 1, nameZh: '白色' });
    expect(parsed[1]).toMatchObject({ id: 'ld:999', legoColorId: null, nameZh: 'Mystery', edgeRgb: '#FFFFFF' });
    expect(legoColorIdFromName('  Bright Red  ')).toBe('c:bright-red');
    expect(Object.keys(COLOR_NAMES_ZH).length).toBeGreaterThanOrEqual(60);
    expect(colorNameZh('Unknown English')).toBe('Unknown English');
  });
  it.each([
    ['CHROME', 'chrome'],
    ['METAL', 'metallic'],
    ['PEARLESCENT', 'pearl'],
    ['RUBBER', 'rubber'],
    ['MATERIAL GLITTER VALUE #FFFFFF', 'glitter'],
    ['MATERIAL SPECKLE VALUE #FFFFFF', 'speckle'],
    ['LUMINANCE 15', 'glow'],
    ['ALPHA 128', 'transparent'],
  ])('材质 %s', (material, finish) => {
    expect(parseLDConfig(`0 !COLOUR Test CODE 123 VALUE #AABBCC EDGE #333333 ${material}`)[0]?.finish).toBe(finish);
  });
});

describe('搜索与换包', () => {
  it('FAC-03 / UI-03 默认工厂件、全部件、尺寸、拼音、工厂编号、同义词与排序', () => {
    const service = new CatalogService(catalog, colors, fixturePack());
    expect(service.search('')).toHaveLength(2);
    expect(service.search('', { includeAll: true })).toHaveLength(8);
    for (const query of ['2x4 砖', '2×4 砖块', '2*4 砖', '2 x 4 砖', '3001', 'F001', 'zhuan', 'zk', '999']) {
      expect(service.search(query)[0]?.id, query).toBe('ld:3001');
    }
    for (const query of ['phb', 'pinghuaban', '光面板', '平滑板'])
      expect(service.search(query)[0]?.id, query).toBe('ld:3068b');
    expect(service.search('rectangle')[0]?.id).toBe('ld:3001');
    expect(service.search('bick', { includeAll: true }).length).toBeGreaterThan(0);
    const pack = fixturePack();
    pack.parts[0]!.status = 'discontinued';
    expect(new CatalogService(catalog, colors, pack).isFactoryPart('ld:3001')).toBe(false);
    expect(new CatalogService(catalog, colors, pack).availableColors('ld:3001')).toEqual([]);
  });

  it('工厂名称与实测值优先，基础目录不变', () => {
    const pack = fixturePack();
    pack.parts[0]!.factoryName = '工厂特别砖';
    pack.colors[0]!.measuredRgb = '#ABCDEF';
    const service = new CatalogService(catalog, colors, pack);
    expect(service.getPart('ld:3001')?.nameZh).toBe('工厂特别砖');
    expect(service.getColor('c:bright-red')?.rgb).toBe('#ABCDEF');
    expect(catalog.parts.find((part) => part.id === 'ld:3001')?.nameZh).toBe('砖 2×4');
    expect(service.isFactoryColor('ld:999')).toBe(false);
  });

  it('FAC-07 文档引用保持逐字节不变，回滚解除影响', () => {
    const document = {
      partIds: ['ld:3001', 'ld:3068b'] as const,
      colorIds: ['c:bright-red'] as const,
      instances: [
        { partId: 'ld:3001', colorId: 'c:bright-red' },
        { partId: 'ld:3068b', colorId: 'inherit' },
      ] as const,
    };
    const original = JSON.stringify(document);
    const old = fixturePack();
    const next = fixturePack('new');
    next.parts[0]!.colors = ['c:bright-blue'];
    next.parts[1]!.status = 'discontinued';
    next.colors.shift();
    const impact = impactOf(document, old, next);
    expect(impact).toEqual({
      nonFactoryParts: ['ld:3068b'],
      nonFactoryColors: ['c:bright-red'],
      unavailableColors: [{ partId: 'ld:3001', colorId: 'c:bright-red' }],
    });
    expect(JSON.stringify(document)).toBe(original);
    expect(impactOf(document, next, old)).toEqual({ nonFactoryParts: [], nonFactoryColors: [], unavailableColors: [] });
    expect(impactOf([{ partId: 'ld:3001', colorId: 'c:bright-red' }], old, next).unavailableColors).toHaveLength(1);
  });
});
