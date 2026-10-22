import ExcelJS from 'exceljs';
import path from 'node:path';
import { buildCatalogIndex, defaultLibraryDir, matchLegoNumber } from './catalog-index';
import { readColors } from './colors';
import { contentHash, readPackFiles } from './pack-files';
import type { PackFiles } from './pack-files';
import { CATEGORY_COLUMNS, COLOR_COLUMNS, MATERIALS, PART_COLUMNS, STATUSES } from './pack-workbooks';
import type {
  CatalogIndex,
  Category,
  ColorDef,
  ImportIssue,
  ImportReport,
  Pack,
  PackColor,
  PackManifest,
  PackPart,
  PartId,
} from './types';

export interface ImportOptions {
  skipInvalidRows?: boolean;
  catalog?: CatalogIndex;
  colors?: readonly ColorDef[];
  libraryDir?: string;
}
export type ImportResult = { pack?: Pack; report: ImportReport };
interface TableRow {
  row: number;
  cells: string[];
}
export function validPackId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id);
}
function codeKey(text: string): string {
  return text.toLowerCase();
}

function readManifest(data: Uint8Array | undefined): PackManifest {
  if (!data) throw new Error('缺少 pack.json');
  const parsed: unknown = JSON.parse(Buffer.from(data).toString('utf8'));
  if (typeof parsed !== 'object' || !parsed) throw new Error('pack.json 必须是对象');
  const record = parsed as Record<string, unknown>;
  for (const key of ['id', 'name', 'version', 'source', 'createdAt', 'contentHash']) {
    if (typeof record[key] !== 'string' || (key !== 'contentHash' && !record[key].trim()))
      throw new Error(`pack.json 的 ${key} 必须是非空字符串`);
  }
  if (!validPackId(record.id as string))
    throw new Error('包 ID 只能使用字母、数字、下划线、连字符，不能使用系统保留名');
  if (record.templateVersion !== 1) throw new Error('不支持该模板版本；当前支持 templateVersion 1');
  if (!Number.isFinite(Date.parse(record.createdAt as string))) throw new Error('创建时间不是有效日期');
  if (record.contentHash && !/^[a-f0-9]{64}$/.test(record.contentHash as string))
    throw new Error('内容哈希必须是 SHA-256 或空字符串');
  return record as unknown as PackManifest;
}

async function readTable(
  files: PackFiles,
  file: string,
  sheetName: string,
  columns: readonly string[],
  errors: ImportIssue[],
): Promise<TableRow[]> {
  const bytes = files[file];
  if (!bytes) {
    errors.push({ file, sheet: sheetName, row: 0, column: '', reason: `缺少 ${file}` });
    return [];
  }
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(new Uint8Array(bytes).buffer);
  } catch {
    errors.push({ file, sheet: sheetName, row: 0, column: '', reason: '无法读取 XLSX 文件' });
    return [];
  }
  const sheet = book.getWorksheet(sheetName) ?? book.worksheets[0];
  if (!sheet) {
    errors.push({ file, sheet: sheetName, row: 1, column: '', reason: '工作簿没有工作表' });
    return [];
  }
  const locations = columns.map((column) => {
    let location = 0;
    sheet.getRow(1).eachCell((cell, index) => {
      if (cell.text.trim() === column) location = index;
    });
    if (!location) errors.push({ file, sheet: sheet.name, row: 1, column, reason: `缺少中文表头「${column}」` });
    return location;
  });
  if (locations.includes(0)) return [];
  const rows: TableRow[] = [];
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    const cells = locations.map((column) => row.getCell(column).text.trim());
    if (number === 2 && /^必填；/.test(cells[0] ?? '') && row.getCell(locations[0]!).font?.italic) return;
    if (cells.every((cell) => !cell)) return;
    rows.push({ row: number, cells });
  });
  return rows;
}

/** Validation never writes to the source and never changes the caller's catalog/document. */
export async function importPack(source: string | Uint8Array, options: ImportOptions = {}): Promise<ImportResult> {
  const report: ImportReport = { errors: [], warnings: [], acceptedParts: 0, acceptedColors: 0, skippedRows: 0 };
  let files: PackFiles;
  let manifest: PackManifest;
  try {
    files = await readPackFiles(source);
    manifest = readManifest(files['pack.json']);
    if (manifest.contentHash && manifest.contentHash !== contentHash(files))
      throw new Error('内容哈希不匹配；请重新导出可编辑模板后修改资料');
  } catch (error) {
    report.errors.push({
      file: 'pack.json',
      sheet: '',
      row: 0,
      column: '',
      reason: error instanceof Error ? error.message : String(error),
    });
    return { report };
  }
  let catalog: CatalogIndex;
  let definitions: readonly ColorDef[];
  try {
    catalog = options.catalog ?? (await buildCatalogIndex({ libraryDir: options.libraryDir ?? defaultLibraryDir }));
    definitions =
      options.colors ?? (await readColors(path.join(options.libraryDir ?? defaultLibraryDir, 'LDConfig.ldr')));
  } catch (error) {
    report.errors.push({
      file: 'library/ldraw',
      sheet: '',
      row: 0,
      column: '',
      reason: error instanceof Error ? error.message : String(error),
    });
    return { report };
  }
  const colorRows = await readTable(files, 'colors.xlsx', '颜色', COLOR_COLUMNS, report.errors);
  const partRows = await readTable(files, 'parts.xlsx', '零件', PART_COLUMNS, report.errors);
  const categoryRows = files['categories.xlsx']
    ? await readTable(files, 'categories.xlsx', '分类', CATEGORY_COLUMNS, report.errors)
    : [];
  if (report.errors.length) return { report }; // Structural failures cannot be fixed by skipping data rows.
  const issue = (file: string, sheet: string, row: TableRow, column: string, reason: string) =>
    report.errors.push({ file, sheet, row: row.row, column, reason });
  const colors: PackColor[] = [];
  const seenCodes = new Set<string>();
  const colorIds = new Set<string>();
  for (const row of colorRows) {
    const before = report.errors.length;
    const [code = '', legoName = '', legoId = '', nameZh = '', rgb = '', material = '', alphaText = '', note = ''] =
      row.cells;
    const error = (column: string, reason: string) => issue('colors.xlsx', '颜色', row, column, reason);
    if (!code) error('工厂色号', '必填：工厂色号');
    if (seenCodes.has(codeKey(code))) error('工厂色号', `重复工厂色号：${code}`);
    seenCodes.add(codeKey(code));
    if (!/^#[a-f\d]{6}$/i.test(rgb)) error('实测颜色值', '颜色值必须是 #RRGGBB 格式');
    if (legoId && !/^\d+$/.test(legoId)) error('乐高颜色 ID', '乐高颜色 ID 必须是非负整数');
    if (legoId && !legoName) error('乐高色名', '有对应乐高颜色 ID 时必须填写乐高色名');
    const base = definitions.find((def) => def.legoName?.toLowerCase() === legoName.toLowerCase());
    if (legoName && !base) error('乐高色名', `未知乐高色名：${legoName}；请使用 LEGOID 注释中的名称`);
    if (base && legoId && base.legoColorId !== Number(legoId)) error('乐高颜色 ID', '乐高颜色 ID 与乐高色名不一致');
    if (material && !Object.hasOwn(MATERIALS, material)) error('材质', `未知材质：${material}`);
    const finish = (Object.hasOwn(MATERIALS, material) ? MATERIALS[material] : undefined) ?? base?.finish ?? 'solid';
    const alpha = alphaText ? Number(alphaText) : (base?.alpha ?? (finish === 'transparent' ? 0.5 : 1));
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) error('透明度', '透明度必须是 0 到 1 的数字（1 为不透明）');
    const id = base?.id ?? `cx:${code}`;
    if (colorIds.has(id)) error('乐高色名', `同一稳定颜色已在本包中定义：${id}`);
    if (report.errors.length !== before) continue;
    colorIds.add(id);
    const definition: ColorDef = base
      ? { ...base, nameZh: nameZh || base.nameZh, rgb: rgb.toUpperCase(), finish, alpha }
      : {
          id: `cx:${code}`,
          legoName: null,
          legoColorId: null,
          nameZh: nameZh || code,
          ldrawCode: null,
          rgb: rgb.toUpperCase(),
          edgeRgb: '#333333',
          finish,
          alpha,
        };
    colors.push({
      colorId: definition.id,
      factoryCode: code,
      measuredRgb: definition.rgb,
      definition,
      ...(note ? { note } : {}),
    });
  }
  const categories: Category[] = [];
  const categoryRowById = new Map<string, TableRow>();
  for (const row of categoryRows) {
    const [id = '', nameZh = '', nameEn = '', parentId = '', order = '', icon = ''] = row.cells;
    const before = report.errors.length;
    const error = (column: string, reason: string) => issue('categories.xlsx', '分类', row, column, reason);
    if (!id) error('分类 ID', '分类 ID 必填');
    if (categoryRowById.has(id)) error('分类 ID', `重复分类 ID：${id}`);
    if (!nameZh) error('中文名', '中文名必填');
    if (order && !/^-?\d+$/.test(order)) error('顺序', '顺序必须是整数');
    if (report.errors.length !== before) continue;
    categoryRowById.set(id, row);
    categories.push({
      id,
      nameZh,
      nameEn,
      parentId: parentId || null,
      order: Number(order || 0),
      ...(icon ? { icon } : {}),
    });
  }
  const byCategory = new Map(categories.map((category) => [category.id, category]));
  const invalidCategories = new Set<string>();
  for (const category of categories) {
    const visited = new Set([category.id]);
    let parent = category.parentId;
    while (parent) {
      if (!byCategory.has(parent) || visited.has(parent)) {
        issue(
          'categories.xlsx',
          '分类',
          categoryRowById.get(category.id)!,
          '父分类 ID',
          !byCategory.has(parent) ? `父分类不存在：${parent}` : '分类树存在循环',
        );
        invalidCategories.add(category.id);
        break;
      }
      visited.add(parent);
      parent = byCategory.get(parent)!.parentId;
    }
  }
  const validCategories = categories.filter((category) => !invalidCategories.has(category.id));
  const colorsByCode = new Map(colors.map((color) => [codeKey(color.factoryCode), color]));
  const byPartId = new Map(catalog.parts.map((part) => [part.id, part]));
  const parts: PackPart[] = [];
  const seenFactoryNumbers = new Set<string>();
  const seenPartIds = new Set<PartId>();
  for (const row of partRows) {
    const before = report.errors.length;
    const [
      factoryNo = '',
      legoNo = '',
      file = '',
      customCode = '',
      factoryName = '',
      category = '',
      available = '',
      status = '',
      note = '',
    ] = row.cells;
    const error = (column: string, reason: string) => issue('parts.xlsx', '零件', row, column, reason);
    if (!factoryNo) error('工厂编号', '必填：工厂编号');
    if (seenFactoryNumbers.has(codeKey(factoryNo))) error('工厂编号', `重复工厂编号：${factoryNo}`);
    seenFactoryNumbers.add(codeKey(factoryNo));
    if (!factoryName) error('名称', '必填：名称');
    if (!available) error('可产颜色', '必填：可产颜色');
    if (status && !Object.hasOwn(STATUSES, status)) error('状态', '状态只能为在产、停产或待确认');
    const colorCodes = available
      .split(/[,，]/)
      .map((code) => code.trim())
      .filter(Boolean);
    if (available && !colorCodes.length) error('可产颜色', '至少填写一个工厂色号');
    for (const code of colorCodes) if (!colorsByCode.has(codeKey(code))) error('可产颜色', `未知色号：${code}`);
    let partId: PartId | undefined;
    let ldrawFile: string | null = null;
    if (customCode) {
      if (legoNo) error('自制件编号', '自制件编号与乐高编号不能同时填写');
      if (!/^[a-zA-Z0-9_-]+$/.test(customCode)) error('自制件编号', '自制件编号只能包含字母、数字、下划线和连字符');
      partId = `cu:${customCode}`;
      if (file) {
        const member = `custom/${file}`;
        if (!/^[\w.-]+\.dat$/i.test(file) || !files[member]) error('LDraw 文件', `找不到自制件几何：${member}`);
        else ldrawFile = file;
      } else if (files[`custom/${customCode}.dat`]) ldrawFile = `${customCode}.dat`;
      else
        report.warnings.push({
          file: 'parts.xlsx',
          sheet: '零件',
          row: row.row,
          column: 'LDraw 文件',
          reason: '自制件尚无 .dat 几何，使用缺失几何占位；原始资产仍保留',
        });
    } else {
      if (!legoNo) error('乐高编号', '乐高同款件必填乐高编号；自制件请填写自制件编号');
      const matches = matchLegoNumber(catalog, legoNo);
      if (legoNo && !matches.length) error('乐高编号', `匹配不到零件：${legoNo}`);
      if (file) {
        const requested: PartId = `ld:${file.replace(/\.dat$/i, '').toLowerCase()}`;
        const resolved = catalog.aliases[requested] ?? requested;
        if (!/^[\w.-]+\.dat$/i.test(file) || !matches.includes(resolved) || !byPartId.has(resolved))
          error('LDraw 文件', `LDraw 文件 ${file} 与乐高编号不匹配`);
        else partId = resolved;
      } else if (matches.length > 1)
        error(
          'LDraw 文件',
          `乐高编号 ${legoNo} 对应多个零件，请填写 LDraw 文件：${matches.map((id) => id.slice(3) + '.dat').join('、')}`,
        );
      else partId = matches[0];
      if (partId) ldrawFile = byPartId.get(partId)?.ldrawFile ?? null;
    }
    if (partId && seenPartIds.has(partId)) error('乐高编号', `零件在本包中重复映射：${partId}`);
    const matchedCategory = validCategories.find((entry) => entry.id === category || entry.nameZh === category);
    if (category && categoryRows.length && !matchedCategory) error('分类', `分类不存在或无效：${category}`);
    if (report.errors.length !== before || !partId) continue;
    seenPartIds.add(partId);
    parts.push({
      partId,
      factoryNo,
      factoryName,
      legoNo: legoNo || null,
      ldrawFile,
      status: STATUSES[status as keyof typeof STATUSES] ?? 'active',
      colors: [...new Set(colorCodes.map((code) => colorsByCode.get(codeKey(code))!.colorId))],
      ...(customCode ? { customCode } : {}),
      ...(category ? { categoryId: matchedCategory?.id ?? category } : {}),
      ...(note ? { note } : {}),
    });
  }
  report.acceptedParts = parts.length;
  report.acceptedColors = colors.length;
  report.skippedRows = new Set(report.errors.map((error) => `${error.file}:${error.row}`)).size;
  if (report.errors.length && !options.skipInvalidRows) return { report };
  // A filtered pack needs a new hash when persisted, never the original source hash.
  const assets = Object.fromEntries(Object.entries(files).filter(([name]) => /^(custom|images)\//.test(name)));
  return {
    pack: {
      manifest: { ...manifest, contentHash: report.errors.length ? '' : manifest.contentHash },
      parts,
      colors,
      categories: validCategories,
      assets,
    },
    report,
  };
}
