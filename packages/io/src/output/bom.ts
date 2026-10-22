import type { BrkDocument } from '@brickloop/core';
import zh from '../../../i18n/locales/zh-CN/common.json';
import en from '../../../i18n/locales/en/common.json';
import { utf8 } from '../binary';
import type { IoIssue } from '../issues';
import { outputIssue, pairKey } from './geometry';
import { collectScene } from './scene';
import type { OutputCatalog, ScopeOptions } from './types';

export interface BomRow {
  index: number;
  partId: string;
  colorId: string;
  legoNo: string;
  factoryNo: string;
  partName: string;
  partNameEn: string;
  legoColor: string;
  factoryColor: string;
  colorName: string;
  quantity: number;
  factoryPart: boolean;
  producible: boolean;
  category: string;
  unmappedPart: boolean;
  unmappedColor: boolean;
}
export interface BomSummary {
  partTypes: number;
  totalParts: number;
  colorCount: number;
  lineCount: number;
  unmappedParts: number;
  unmappedColors: number;
  unmappedRows: number;
  unmappedQuantity: number;
}
export interface BomResult {
  rows: BomRow[];
  summary: BomSummary;
  issues: IoIssue[];
}
export interface BomTextOptions {
  language?: 'zh-CN' | 'en';
}
export function bomLabels(options: BomTextOptions = {}) {
  return options.language === 'en' ? en.io.bom : zh.io.bom;
}
export const bomColumns = [
  'index',
  'image',
  'legoNo',
  'factoryNo',
  'partName',
  'legoColor',
  'factoryColor',
  'colorName',
  'quantity',
  'factoryPart',
  'producible',
  'category',
] as const;

export function aggregateBom(doc: BrkDocument, catalog: OutputCatalog = {}, options: ScopeOptions = {}): BomResult {
  const scene = collectScene(doc, options, true);
  const parts = new Map(catalog.parts?.map((p) => [p.id, p]));
  const colors = new Map(catalog.colors?.map((c) => [c.id, c]));
  const factoryParts = new Map(catalog.factoryParts?.map((p) => [p.partId, p]));
  const factoryColors = new Map(catalog.factoryColors?.map((c) => [c.colorId, c]));
  const grouped = new Map<string, BomRow>();
  const unknownParts = new Set<string>(),
    unknownColors = new Set<string>();
  for (const node of scene.parts) {
    if (node.ref.kind !== 'part') continue;
    const partId = node.ref.partId,
      colorId = node.colorId,
      key = pairKey(partId, colorId);
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity++;
      continue;
    }
    const part = parts.get(partId),
      color = colors.get(colorId),
      factory = factoryParts.get(partId),
      factoryColor = factoryColors.get(colorId);
    const factoryPart = factory !== undefined && factory.status !== 'discontinued';
    if (!part) unknownParts.add(partId);
    if (!color) unknownColors.add(colorId);
    grouped.set(key, {
      index: grouped.size + 1,
      partId,
      colorId,
      legoNo: part?.legoNo ?? partId,
      factoryNo: factory?.factoryNo ?? '',
      partName: factory?.factoryName ?? part?.nameZh ?? partId,
      partNameEn: part?.nameEn ?? partId,
      legoColor: color?.legoName ?? colorId,
      factoryColor: factoryColor?.factoryCode ?? '',
      colorName: color?.nameZh ?? colorId,
      quantity: 1,
      factoryPart,
      producible: Boolean(part && color && factoryPart && factoryColor && factory.colors.includes(colorId)),
      category: factory?.categoryId ?? part?.categoryId ?? '',
      unmappedPart: !part,
      unmappedColor: !color,
    });
  }
  const rows = [...grouped.values()];
  const unknownRows = rows.filter((row) => row.unmappedPart || row.unmappedColor);
  return {
    rows,
    summary: {
      partTypes: new Set(rows.map((row) => row.partId)).size,
      totalParts: rows.reduce((sum, row) => sum + row.quantity, 0),
      colorCount: new Set(rows.map((row) => row.colorId)).size,
      lineCount: rows.length,
      unmappedParts: unknownParts.size,
      unmappedColors: unknownColors.size,
      unmappedRows: unknownRows.length,
      unmappedQuantity: unknownRows.reduce((sum, row) => sum + row.quantity, 0),
    },
    issues: [
      ...[...unknownParts].map((id) => outputIssue('BOM_PART_UNMAPPED', id)),
      ...[...unknownColors].map((id) => outputIssue('BOM_COLOR_UNMAPPED', id)),
    ],
  };
}
export function bomValues(row: BomRow, options: BomTextOptions = {}): (string | number)[] {
  const labels = bomLabels(options);
  return [
    row.index,
    '',
    row.legoNo,
    row.factoryNo,
    options.language === 'en' ? row.partNameEn : row.partName,
    row.legoColor,
    row.factoryColor,
    row.colorName,
    row.quantity,
    row.factoryPart ? labels.yes : labels.no,
    row.producible ? labels.yes : labels.no,
    row.category,
  ];
}
export function exportBomCsv(
  bom: BomResult,
  options: BomTextOptions = {},
): { text: string; bytes: Uint8Array; byteLength: number } {
  const labels = bomLabels(options);
  // Explicit string cells prevent catalog text becoming executable Excel formulas on CSV open.
  const quote = (value: string | number) => {
    let text = String(value);
    if (typeof value === 'string' && /^[\s]*[=+@-]/u.test(text)) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows = [
    bomColumns.filter((key) => key !== 'image').map((key) => labels[key]),
    ...bom.rows.map((row) => bomValues(row, options).filter((_, i) => i !== 1)),
  ];
  const text = '\uFEFF' + rows.map((row) => row.map(quote).join(',')).join('\r\n') + '\r\n';
  const bytes = utf8(text);
  return { text, bytes, byteLength: bytes.length };
}
