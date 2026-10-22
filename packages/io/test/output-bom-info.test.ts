import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import { createDocument, createModel, orderedInstances } from '@brickloop/core';
import { aggregateBom, calculateModelInfo, exportBomCsv, exportObj } from '../src';
import { exportBomXlsx } from '../src/node';
import { readZip } from '../src/binary';
import { cleanup, temporary } from './helpers';
import { fakePng, outputCatalog, outputContext, outputDoc, singleLdraw } from './output-helpers';

describe('M4-1a BOM', () => {
  it('BOM-01: shared submodels expand by occurrence and inherited colors are resolved', () => {
    const result = aggregateBom(outputDoc(), outputCatalog);
    expect(result.rows.map((row) => [row.partId, row.colorId, row.quantity])).toEqual([
      ['ld:3001', 'c:red', 2],
      ['ld:3001', 'c:yellow', 2],
    ]);
    expect(result.summary).toEqual({
      partTypes: 1,
      totalParts: 4,
      colorCount: 2,
      lineCount: 2,
      unmappedParts: 0,
      unmappedColors: 0,
      unmappedRows: 0,
      unmappedQuantity: 0,
    });
    expect(result.rows[0]).toMatchObject({
      factoryPart: true,
      producible: true,
      factoryNo: '0001',
      factoryColor: '001',
    });
    expect(result.rows[1]).toMatchObject({ factoryPart: true, producible: false });
  });
  it('supports project/model/selection scopes, hidden parents, overlap deduplication and empty selection', () => {
    const doc = outputDoc(),
      roots = orderedInstances(doc.models[doc.rootModelId]!);
    const ref = roots[0]!.ref;
    if (ref.kind !== 'model') throw new Error('Expected model');
    const child = orderedInstances(doc.models[ref.modelId]!)[0]!;
    const hidden = [[roots[0]!.id]];
    expect(aggregateBom(doc, outputCatalog, { workspace: { hidden } }).summary.totalParts).toBe(4);
    expect(aggregateBom(doc, outputCatalog, { workspace: { hidden }, includeHidden: false }).summary.totalParts).toBe(
      2,
    );
    expect(
      aggregateBom(doc, outputCatalog, { scope: { kind: 'model', path: [roots[1]!.id] } }).rows.map(
        (row) => row.quantity,
      ),
    ).toEqual([1, 1]);
    expect(
      aggregateBom(doc, outputCatalog, {
        scope: { kind: 'selection', paths: [[roots[0]!.id], [roots[0]!.id, child.id]] },
      }).summary.totalParts,
    ).toBe(2);
    expect(aggregateBom(doc, outputCatalog, { scope: { kind: 'selection', paths: [] } }).summary.totalParts).toBe(0);
    expect(() => aggregateBom(doc, outputCatalog, { scope: { kind: 'model', path: ['absent'] } })).toThrow('scope');
    roots[1]!.colorId = 'c:yellow';
    expect(aggregateBom(doc, outputCatalog).rows.map((row) => row.quantity)).toEqual([1, 3]);
  });
  it('counts unknown references without stopping export, including repeated unknown pairs', () => {
    const doc = outputDoc(
      singleLdraw + '\n' + singleLdraw.replace('3001.dat', '999999.dat').replace('1 4', '1 1234567'),
    );
    const result = aggregateBom(doc, outputCatalog);
    expect(result.summary).toMatchObject({
      totalParts: 2,
      partTypes: 2,
      colorCount: 2,
      unmappedParts: 1,
      unmappedColors: 1,
      unmappedRows: 1,
      unmappedQuantity: 1,
    });
    expect(result.rows[1]).toMatchObject({
      unmappedPart: true,
      unmappedColor: true,
      factoryPart: false,
      producible: false,
    });
    expect(result.issues.map((issue) => issue.messageKey)).toEqual(['io.BOM_PART_UNMAPPED', 'io.BOM_COLOR_UNMAPPED']);
  });
  it('handles pending/discontinued parts and empty documents consistently', () => {
    const factory = outputCatalog.factoryParts![0]!;
    expect(
      aggregateBom(outputDoc(), { ...outputCatalog, factoryParts: [{ ...factory, status: 'pending' }] }).rows[0]!
        .producible,
    ).toBe(true);
    expect(
      aggregateBom(outputDoc(), { ...outputCatalog, factoryParts: [{ ...factory, status: 'discontinued' }] }).rows[0]!
        .factoryPart,
    ).toBe(false);
    expect(aggregateBom(createDocument()).summary).toMatchObject({ totalParts: 0, partTypes: 0, colorCount: 0 });
  });
  it('BOM-02: UTF-8 BOM, Chinese text, CRLF, CSV escaping and English headers', () => {
    const bom = aggregateBom(outputDoc(), outputCatalog);
    bom.rows[0]!.partName = '砖,"红"\n第二行';
    bom.rows[0]!.factoryNo = '=HYPERLINK("bad")';
    const csv = exportBomCsv(bom);
    expect([...csv.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(Buffer.from(csv.bytes).toString('utf8')).toBe(csv.text);
    expect(csv.text).toContain('"砖,""红""\n第二行"');
    expect(csv.text).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv.text).toContain('亮红色');
    expect(csv.text.split('\r\n')[0]).not.toContain('图片');
    expect(csv.text).toContain('"工厂可产"');
    expect(exportBomCsv(bom, { language: 'en' }).text).toContain('"LEGO number"');
    expect(exportBomCsv(bom, { language: 'en' }).text).toContain('Brick 2 x 4');
  });
  it('BOM-03: XLSX columns, freeze, widths, embedded PNGs, summaries and red markings', async () => {
    const doc = outputDoc(
      singleLdraw + '\n' + singleLdraw.replace('1 4', '1 14') + '\n' + singleLdraw.replace('3001.dat', 'unknown.dat'),
    );
    const bom = aggregateBom(doc, outputCatalog),
      thumbnailProvider = vi.fn(() => fakePng);
    const result = await exportBomXlsx(bom, { thumbnailProvider });
    expect(thumbnailProvider).toHaveBeenCalledTimes(3);
    expect(thumbnailProvider).toHaveBeenCalledWith('ld:3001', 'c:red');
    expect(result.thumbnailCount).toBe(3);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(result.bytes as unknown as ExcelJS.Buffer);
    const sheet = book.worksheets[0]!;
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      '序号',
      '图片',
      '乐高编号',
      '工厂编号',
      '零件名称',
      '颜色',
      '工厂色号',
      '颜色中文名',
      '数量',
      '工厂件',
      '工厂可产',
      '分类',
    ]);
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet.getColumn(5).width).toBeGreaterThanOrEqual(10);
    expect(sheet.getCell('D2').value).toBe('0001');
    expect(sheet.getCell('I2').value).toBe(1);
    expect(sheet.getCell('I5').value).toBe(3);
    expect(sheet.getCell('D5').value).toBe(2);
    expect(sheet.getCell('F5').value).toBe(2);
    expect(sheet.getCell('B6').value).toBe(1);
    for (let col = 1; col <= 12; col++)
      expect(sheet.getRow(3).getCell(col).fill).toMatchObject({ fgColor: { argb: 'FFFFE4E6' } });
    expect(sheet.getCell('C4').fill).toMatchObject({ fgColor: { argb: 'FFFFB4B4' } });
    expect(sheet.getCell('C4').font.color?.argb).toBe('FFB91C1C');
    expect(sheet.getImages()).toHaveLength(3);
    const media = Object.entries(readZip(result.bytes).members).filter(
      ([name]) => name.startsWith('xl/media/') && name.endsWith('.png'),
    );
    expect(media).toHaveLength(3);
    expect(media.every(([, bytes]) => Buffer.from(bytes).equals(Buffer.from(fakePng)))).toBe(true);
  });
  it('thumbnail failures keep workbook data and report missing/invalid images; empty English sheet works', async () => {
    const bom = aggregateBom(outputDoc(), outputCatalog);
    const result = await exportBomXlsx(bom, {
      thumbnailProvider: (part, color) => (color === 'c:red' ? undefined : new Uint8Array([0])),
      language: 'en',
    });
    expect(result.thumbnailCount).toBe(0);
    expect(result.issues.map((i) => i.code)).toEqual(['BOM_THUMBNAIL_MISSING', 'BOM_THUMBNAIL_FAILED']);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(
      (await exportBomXlsx(aggregateBom(createDocument()), { thumbnailProvider: () => undefined, language: 'en' }))
        .bytes as unknown as ExcelJS.Buffer,
    );
    expect(book.worksheets[0]!.getCell('C1').value).toBe('LEGO number');
    expect(book.worksheets[0]!.getCell('I2').value).toBe(0);
  });
  it('Node integration: exported OBJ/MTL and BOM XLSX exist and can be read back', async () => {
    const directory = await temporary();
    try {
      const doc = outputDoc(),
        obj = await exportObj(doc, await outputContext());
      const xlsx = await exportBomXlsx(aggregateBom(doc, outputCatalog), { thumbnailProvider: () => fakePng });
      for (const [name, data] of [
        ['model.obj', obj.obj],
        ['model.mtl', obj.mtl],
        ['bom.xlsx', xlsx.bytes],
      ] as const) {
        const destination = path.join(directory, name);
        await writeFile(destination, data);
        expect((await stat(destination)).size).toBeGreaterThan(0);
      }
      const book = new ExcelJS.Workbook();
      await book.xlsx.load((await readFile(path.join(directory, 'bom.xlsx'))) as unknown as ExcelJS.Buffer);
      expect(book.worksheets[0]!.getCell('I4').value).toBe(4);
    } finally {
      await cleanup(directory);
    }
  });
});

describe('M4-1a model information', () => {
  it('INF-01: one 3001 is 4 x 2 studs, 1.17 bricks, 3.2 x 1.6 x 1.12 cm', async () => {
    const info = await calculateModelInfo(outputDoc(singleLdraw), await outputContext(), {
      lastCheck: { errors: 2, warnings: 3 },
    });
    expect(info.dimensions.studs).toEqual({ width: 4, depth: 2 });
    expect(Number(info.dimensions.bricks.toFixed(2))).toBe(1.17);
    expect(info.dimensions.plates).toBe(3.5);
    expect(info.dimensions.cm).toEqual({ width: 3.2, depth: 1.6, height: 1.12 });
    expect(info.dimensions.inches.width).toBeCloseTo(3.2 / 2.54);
    expect(info.dimensions.includesStuds).toBe(true);
    expect(info).toMatchObject({
      directReferences: 1,
      totalParts: 1,
      partTypes: 1,
      colorCount: 1,
      submodelDefinitions: 0,
      submodelInstances: 0,
      lastCheck: { errors: 2, warnings: 3 },
      geometryComplete: true,
    });
  });
  it('separates current-level references, expanded parts, reachable definitions and model occurrences', async () => {
    const doc = outputDoc(),
      unused = createModel('unused');
    doc.models[unused.id] = unused;
    const root = orderedInstances(doc.models[doc.rootModelId]!);
    const info = await calculateModelInfo(doc, await outputContext());
    expect(info).toMatchObject({
      directReferences: 2,
      totalParts: 4,
      submodelDefinitions: 1,
      submodelInstances: 2,
      documentSubmodelDefinitions: 2,
      partTypes: 1,
      colorCount: 2,
      lastCheck: null,
    });
    const scoped = await calculateModelInfo(doc, await outputContext(), {
      scope: { kind: 'model', path: [root[1]!.id] },
    });
    expect(scoped).toMatchObject({ directReferences: 2, totalParts: 2, submodelDefinitions: 0, submodelInstances: 0 });
    expect(scoped.dimensions.studs).toEqual({ width: 2, depth: 8 });
    const visible = await calculateModelInfo(doc, await outputContext(), {
      workspace: { hidden: [[root[0]!.id]] },
      includeHidden: false,
    });
    expect(visible).toMatchObject({ directReferences: 1, totalParts: 2, submodelInstances: 1 });
    expect(visible.dimensions).toEqual(scoped.dimensions);
  });
  it('returns zero dimensions for empty models and marks incomplete geometry without hiding part counts', async () => {
    expect(await calculateModelInfo(createDocument(), await outputContext())).toMatchObject({
      boundsLdu: null,
      dimensions: { cm: { width: 0, depth: 0, height: 0 } },
      totalParts: 0,
    });
    expect(await calculateModelInfo(outputDoc(), { meshProvider: () => undefined })).toMatchObject({
      boundsLdu: null,
      totalParts: 4,
      geometryComplete: false,
    });
  });
});
