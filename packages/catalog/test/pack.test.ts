import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repositoryRoot } from '../src/catalog-index';
import { CatalogService, impactOf } from '../src/catalog-service';
import { parseLDConfig } from '../src/colors';
import { diffPacks } from '../src/pack-diff';
import { importPack } from '../src/pack-import';
import { contentHash, readPackFiles, writePackFiles } from '../src/pack-files';
import { PackStore } from '../src/pack-store';
import { exportTemplate, packFiles, writePack } from '../src/pack-workbooks';
import { catalog, colors, fixturePack } from './fixtures';

let dir: string;
beforeEach(async () => {
  const base = path.join(repositoryRoot, '.devdata/catalog-tests');
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(path.join(base, 'pack-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const options = { catalog, colors };
async function edit(file: string, action: (sheet: ExcelJS.Worksheet) => void): Promise<void> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(file);
  action(book.worksheets[0]!);
  await book.xlsx.writeFile(file);
}

describe('模板与导入', () => {
  it('FAC-04 模板说明、下拉、颜色列表及填写五行再导入', async () => {
    await exportTemplate(dir);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(path.join(dir, 'parts.xlsx'));
    const sheet = book.getWorksheet('零件')!;
    expect(sheet.getCell('A1').text).toBe('工厂编号');
    expect(sheet.getCell('A2').font).toMatchObject({ italic: true, color: { argb: 'FF777777' } });
    expect(sheet.getCell('H3').dataValidation.formulae).toEqual(['"在产,停产,待确认"']);
    expect(sheet.getCell('G3').dataValidation.formulae).toEqual(['FactoryColors']);
    expect(book.getWorksheet('颜色列表')?.getCell('A2').text).toBe('EXAMPLE-RED');
    const numbers = ['3001', '3002', '3003', '3023b', '3068b'];
    numbers.forEach((number, i) => {
      sheet.getRow(i + 3).values = [
        `F${i}`,
        number,
        `${number}.dat`,
        '',
        `工厂件 ${i}`,
        '',
        'EXAMPLE-RED',
        '',
        '填写测试',
      ];
    });
    await book.xlsx.writeFile(path.join(dir, 'parts.xlsx'));
    const result = await importPack(dir, options);
    expect(result.report.errors).toEqual([]);
    expect(result.pack?.parts).toHaveLength(5);
    expect(result.pack?.parts.every((part) => part.status === 'active')).toBe(true);
    const colorBook = new ExcelJS.Workbook();
    await colorBook.xlsx.readFile(path.join(dir, 'colors.xlsx'));
    expect(colorBook.worksheets[0]?.getCell('F3').dataValidation.formulae?.[0]).toContain('橡胶');
  });

  it('FAC-02 一对多要求 LDraw 文件，指定文件后成功', async () => {
    await exportTemplate(dir, { from: fixturePack() });
    await edit(path.join(dir, 'parts.xlsx'), (sheet) => {
      sheet.getRow(3).values = ['F001', '3626', '', '', '人仔头', '', 'C1', '在产', ''];
    });
    const failed = await importPack(dir, options);
    expect(failed.pack).toBeUndefined();
    expect(failed.report.errors).toContainEqual(
      expect.objectContaining({ row: 3, column: 'LDraw 文件', reason: expect.stringContaining('多个零件') }),
    );
    await edit(path.join(dir, 'parts.xlsx'), (sheet) => {
      sheet.getCell('C3').value = '3626b.dat';
    });
    expect((await importPack(dir, options)).pack?.parts[0]?.partId).toBe('ld:3626b');
  });

  it('FAC-05 错误逐行报告、跳过错误行，坏颜色的依赖行也被拒绝', async () => {
    await exportTemplate(dir, { from: fixturePack() });
    await edit(path.join(dir, 'parts.xlsx'), (sheet) => {
      sheet.getRow(5).values = ['F001', '3002', '3002.dat', '', '重复编号', '', 'C1', '在产', ''];
      sheet.getRow(6).values = ['F003', '3003', '3003.dat', '', '未知色', '', 'UNKNOWN', '在产', ''];
      sheet.getRow(7).values = ['F004', '00000', '', '', '未知零件', '', 'C1', '在产', ''];
      sheet.getRow(8).values = ['F005', '3023b', '', '', '', '', 'C1', '错误状态', ''];
    });
    const result = await importPack(dir, options);
    expect(result.pack).toBeUndefined();
    expect(result.report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 5, column: '工厂编号', reason: '重复工厂编号：F001' }),
        expect.objectContaining({ row: 6, column: '可产颜色', reason: '未知色号：UNKNOWN' }),
        expect.objectContaining({ row: 7, column: '乐高编号', reason: '匹配不到零件：00000' }),
        expect.objectContaining({ row: 8, column: '名称', reason: '必填：名称' }),
      ]),
    );
    const skipped = await importPack(dir, { ...options, skipInvalidRows: true });
    expect(skipped.pack?.parts).toHaveLength(2);
    expect(skipped.report.skippedRows).toBe(4);
    await edit(path.join(dir, 'colors.xlsx'), (sheet) => {
      sheet.getCell('E3').value = 'red';
    });
    const invalidColor = await importPack(dir, { ...options, skipInvalidRows: true });
    expect(invalidColor.report.errors).toContainEqual(
      expect.objectContaining({ row: 3, column: '实测颜色值', reason: expect.stringContaining('#RRGGBB') }),
    );
    expect(invalidColor.pack?.parts).toHaveLength(0);
  });

  it('BS-09 内部材质名称不是乐高色名，报错并跳过该颜色行', async () => {
    const internalColors = parseLDConfig(`0 !COLOUR Main_Colour CODE 16 VALUE #FFFF80 EDGE #333333
0 !COLOUR Edge_Colour CODE 24 VALUE #7F7F7F EDGE #333333
0 !COLOUR Trans_Sticker CODE 10047 VALUE #FFFFFF EDGE #FFFFFF ALPHA 16`);
    const names = ['Main_Colour', 'Edge_Colour', 'Trans_Sticker'];
    const pack = fixturePack();
    await exportTemplate(dir, { from: pack });
    await edit(path.join(dir, 'colors.xlsx'), (sheet) => {
      names.forEach((name, index) => {
        sheet.getRow(index + 6).values = [`INTERNAL-${index}`, name, '', '', '#FFFFFF', '', '', ''];
      });
    });
    const result = await importPack(dir, {
      ...options,
      colors: [...colors, ...internalColors],
      skipInvalidRows: true,
    });
    expect(result.report.errors).toEqual(
      names.map((name, index) =>
        expect.objectContaining({
          file: 'colors.xlsx',
          row: index + 6,
          column: '乐高色名',
          reason: `未知乐高色名：${name}；请使用 LEGOID 注释中的名称`,
        }),
      ),
    );
    expect(result.report.skippedRows).toBe(3);
    expect(result.pack).toBeDefined();
    expect(result.pack!.colors.map((color) => color.colorId)).toEqual(pack.colors.map((color) => color.colorId));
    for (const id of ['ld:16', 'ld:24', 'ld:10047']) {
      expect(result.pack!.colors.some((color) => color.colorId === id)).toBe(false);
    }
  });

  it('校验色号重复、名称/ID 不一致、透明度、材质和缺失表头', async () => {
    await exportTemplate(dir, { from: fixturePack() });
    await edit(path.join(dir, 'colors.xlsx'), (sheet) => {
      sheet.getCell('A4').value = 'C1';
      sheet.getCell('C4').value = 21;
      sheet.getCell('F4').value = '木材';
      sheet.getCell('G4').value = 2;
    });
    const result = await importPack(dir, options);
    expect(result.report.errors.map((error) => error.column)).toEqual(
      expect.arrayContaining(['工厂色号', '乐高颜色 ID', '材质', '透明度']),
    );
    await edit(path.join(dir, 'parts.xlsx'), (sheet) => {
      sheet.getCell('A1').value = 'wrong';
    });
    expect((await importPack(dir, { ...options, skipInvalidRows: true })).pack).toBeUndefined();
  });

  it('自制件、独有颜色、可选分类树与资产无损往返', async () => {
    await exportTemplate(dir, { from: fixturePack() });
    await mkdir(path.join(dir, 'custom'));
    await mkdir(path.join(dir, 'images'));
    await writeFile(path.join(dir, 'custom/SL001.dat'), '0 Custom Part');
    await writeFile(path.join(dir, 'custom/SL001.step'), 'STEP fixture');
    await writeFile(path.join(dir, 'images/color.txt'), 'photo placeholder');
    await edit(path.join(dir, 'colors.xlsx'), (sheet) => {
      sheet.getRow(6).values = ['SPECIAL', '', '', '工厂紫', '#445566', '珠光', 1, '独有'];
    });
    await edit(path.join(dir, 'parts.xlsx'), (sheet) => {
      sheet.getRow(5).values = ['SELF', '', 'SL001.dat', 'SL001', '工厂自制件', '', 'SPECIAL', '', '自有几何'];
    });
    const imported = await importPack(dir, options);
    expect(imported.report.errors).toEqual([]);
    const pack = imported.pack!;
    expect(pack.parts[2]?.partId).toBe('cu:SL001');
    expect(pack.colors[3]?.colorId).toBe('cx:SPECIAL');
    pack.categories = [
      { id: 'root', nameZh: '根分类', nameEn: 'Root', parentId: null, order: 0 },
      { id: 'child', nameZh: '工厂分类', nameEn: 'Custom', parentId: 'root', order: 1 },
    ];
    pack.parts[2]!.categoryId = 'child';
    const destination = path.join(dir, 'export.brklpack');
    await writePack(destination, pack);
    const roundtrip = await importPack(destination, options);
    expect(roundtrip.pack?.categories).toEqual(pack.categories);
    expect(roundtrip.pack?.assets).toEqual(pack.assets);
    const service = new CatalogService(catalog, colors, roundtrip.pack!);
    expect(service.getPart('cu:SL001')?.geometry.ref).toBe('custom/SL001.dat');
    expect(service.availableColors('cu:SL001')[0]?.id).toBe('cx:SPECIAL');
  });

  it('循环分类和不存在的父分类给出行号', async () => {
    const pack = fixturePack();
    pack.categories = [
      { id: 'a', nameZh: '甲', nameEn: '', parentId: 'b', order: 0 },
      { id: 'b', nameZh: '乙', nameEn: '', parentId: 'a', order: 0 },
      { id: 'c', nameZh: '丙', nameEn: '', parentId: 'missing', order: 0 },
    ];
    await exportTemplate(dir, { from: pack });
    const result = await importPack(dir, options);
    expect(result.report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'categories.xlsx', row: 3, reason: '分类树存在循环' }),
        expect.objectContaining({ file: 'categories.xlsx', row: 5, reason: '父分类不存在：missing' }),
      ]),
    );
  });

  it('正式包内容哈希、防路径穿越、未知模板版本', async () => {
    await writePack(dir, fixturePack());
    const files = await readPackFiles(dir);
    expect(JSON.parse(Buffer.from(files['pack.json']!).toString()).contentHash).toBe(contentHash(files));
    await writeFile(path.join(dir, 'parts.xlsx'), 'corrupt');
    expect((await importPack(dir, { ...options, skipInvalidRows: true })).report.errors[0]?.reason).toContain(
      '哈希不匹配',
    );
    const malicious = zipSync({ '../escape.txt': Buffer.from('bad') });
    expect((await importPack(malicious, options)).report.errors[0]?.reason).toContain('非法路径');
    const manifest: unknown = JSON.parse(Buffer.from(files['pack.json']!).toString());
    files['pack.json'] = Buffer.from(JSON.stringify({ ...(manifest as object), templateVersion: 2 }));
    await writePackFiles(path.join(dir, 'bad-version.brklpack'), files);
    expect((await importPack(path.join(dir, 'bad-version.brklpack'), options)).report.errors[0]?.reason).toContain(
      '模板版本',
    );
  });

  it('同输入 XLSX/ZIP 确定性输出', async () => {
    const first = await packFiles(fixturePack());
    const second = await packFiles(fixturePack());
    expect(contentHash(first)).toBe(contentHash(second));
    expect(Buffer.from(first['parts.xlsx']!)).toEqual(Buffer.from(second['parts.xlsx']!));
  });
});

it('FAC-06 差异、包存储、新包启用与回滚、丢失包回退', async () => {
  const old = fixturePack('old');
  const next = fixturePack('new');
  next.parts = [next.parts[0]!];
  next.parts[0]!.factoryNo = 'NEW-001';
  next.parts[0]!.colors = ['c:bright-blue'];
  next.colors[0] = {
    colorId: 'cx:NEW',
    factoryCode: 'C1',
    measuredRgb: '#123456',
    definition: {
      ...next.colors[0]!.definition,
      id: 'cx:NEW',
      legoName: null,
      legoColorId: null,
      ldrawCode: null,
      rgb: '#123456',
    },
  };
  const diff = diffPacks(old, next);
  expect(diff.parts.removed).toHaveLength(1);
  expect(diff.parts.changed).toHaveLength(1);
  expect(diff.colors.changed[0]?.after.colorId).toBe('cx:NEW');
  await writePack(path.join(dir, 'old.brklpack'), old);
  await writePack(path.join(dir, 'new.brklpack'), next);
  const demo = fixturePack('demo');
  await writePack(path.join(dir, 'bundled'), demo);
  const store = new PackStore(path.join(dir, 'store'), { ...options, demoDir: path.join(dir, 'bundled') });
  expect((await store.import(path.join(dir, 'old.brklpack'))).report.errors).toEqual([]);
  expect((await store.import(path.join(dir, 'new.brklpack'))).report.errors).toEqual([]);
  expect(await store.list()).toHaveLength(2);
  expect((await store.resolveActive('new')).manifest.id).toBe('new');
  expect(
    impactOf([{ partId: 'ld:3001', colorId: 'c:bright-red' }], old, await store.resolveActive('new')).unavailableColors,
  ).toHaveLength(1);
  expect(
    impactOf([{ partId: 'ld:3001', colorId: 'c:bright-red' }], old, await store.resolveActive('old')).unavailableColors,
  ).toHaveLength(0);
  expect((await store.import(path.join(dir, 'old.brklpack'))).report.errors[0]?.reason).toContain('包 ID 已存在');
  await store.delete('new');
  expect(await store.list()).toHaveLength(1);
  expect((await store.resolveActive('new')).manifest.id).toBe('demo');
  await expect(store.delete('../outside')).rejects.toThrow('非法包 ID');
  expect(await readFile(path.join(dir, 'old.brklpack'))).toBeDefined();
});
