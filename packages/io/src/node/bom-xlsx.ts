import ExcelJS from 'exceljs';
import type { IoIssue } from '../issues';
import { bomColumns, bomLabels, bomValues } from '../output/bom';
import type { BomResult, BomTextOptions } from '../output/bom';
import { outputIssue } from '../output/geometry';

export type ThumbnailProvider = (
  partId: string,
  colorId: string,
) => Uint8Array | undefined | Promise<Uint8Array | undefined>;
export interface BomXlsxOptions extends BomTextOptions {
  thumbnailProvider: ThumbnailProvider;
}
export interface BomXlsxResult {
  bytes: Uint8Array;
  byteLength: number;
  issues: IoIssue[];
  thumbnailCount: number;
}
export async function exportBomXlsx(bom: BomResult, options: BomXlsxOptions): Promise<BomXlsxResult> {
  const workbook = new ExcelJS.Workbook(),
    labels = bomLabels(options);
  workbook.creator = 'Brickloop';
  workbook.created = workbook.modified = new Date('2000-01-01T00:00:00Z');
  const sheet = workbook.addWorksheet(labels.sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.addRow(bomColumns.map((key) => labels[key]));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).height = 24;
  const issues = [...bom.issues];
  let thumbnailCount = 0;
  for (const item of bom.rows) {
    const row = sheet.addRow(bomValues(item, options));
    row.height = 48;
    row.alignment = { vertical: 'middle' };
    for (const column of [3, 4, 7]) row.getCell(column).numFmt = '@';
    if (!item.factoryPart || !item.producible)
      for (let i = 1; i <= bomColumns.length; i++)
        row.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE4E6' } };
    if (item.unmappedPart || item.unmappedColor) {
      for (let i = 1; i <= bomColumns.length; i++) row.getCell(i).font = { color: { argb: 'FFB91C1C' } };
      for (const i of [...(item.unmappedPart ? [3, 5] : []), ...(item.unmappedColor ? [6, 8] : [])])
        row.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFB4B4' } };
    }
    try {
      const png = await options.thumbnailProvider(item.partId, item.colorId);
      if (png) {
        if (png.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => png[i] === value))
          throw new Error('Expected PNG thumbnail');
        const imageId = workbook.addImage({
          base64: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
          extension: 'png',
        });
        sheet.addImage(imageId, {
          tl: { col: 1.1, row: row.number - 0.9 },
          ext: { width: 52, height: 52 },
          editAs: 'oneCell',
        });
        thumbnailCount++;
      } else issues.push(outputIssue('BOM_THUMBNAIL_MISSING', `${item.partId}/${item.colorId}`));
    } catch (error) {
      issues.push(outputIssue('BOM_THUMBNAIL_FAILED', `${item.partId}/${item.colorId}: ${String(error)}`));
    }
  }
  const summary = bom.summary;
  sheet.addRow([
    labels.summary,
    '',
    labels.partTypes,
    summary.partTypes,
    labels.colorCount,
    summary.colorCount,
    '',
    '',
    summary.totalParts,
  ]);
  sheet.addRow([
    labels.unmappedParts,
    summary.unmappedParts,
    labels.unmappedColors,
    summary.unmappedColors,
    labels.unmappedRows,
    summary.unmappedRows,
    labels.unmappedQuantity,
    summary.unmappedQuantity,
  ]);
  for (const index of [sheet.rowCount - 1, sheet.rowCount]) sheet.getRow(index).font = { bold: true };
  for (let i = 1; i <= bomColumns.length; i++) {
    let width = 8;
    sheet.getColumn(i).eachCell((cell) => {
      const length = [...String(cell.value ?? '')].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
      width = Math.max(width, length + 2);
    });
    sheet.getColumn(i).width = i === 2 ? 10 : Math.min(60, width);
  }
  if (bom.rows.length) sheet.autoFilter = { from: 'A1', to: `L${bom.rows.length + 1}` };
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  return { bytes, byteLength: bytes.length, issues, thumbnailCount };
}
