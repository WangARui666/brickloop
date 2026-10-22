import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import { contentHash, deterministicZip, FIXED_DATE, writePackFiles } from './pack-files';
import type { PackFiles } from './pack-files';
import type { Finish, Pack } from './types';

export const PART_COLUMNS = [
  '工厂编号',
  '乐高编号',
  'LDraw 文件',
  '自制件编号',
  '名称',
  '分类',
  '可产颜色',
  '状态',
  '备注',
] as const;
export const COLOR_COLUMNS = [
  '工厂色号',
  '乐高色名',
  '乐高颜色 ID',
  '中文名',
  '实测颜色值',
  '材质',
  '透明度',
  '备注',
] as const;
export const CATEGORY_COLUMNS = ['分类 ID', '中文名', '英文名', '父分类 ID', '顺序', '图标'] as const;
export const STATUSES = { 在产: 'active', 停产: 'discontinued', 待确认: 'pending' } as const;
export const MATERIALS: Readonly<Record<string, Finish>> = {
  实色: 'solid',
  透明: 'transparent',
  金属: 'metallic',
  珠光: 'pearl',
  闪粉: 'glitter',
  橡胶: 'rubber',
  夜光: 'glow',
  // Lossless round trip of the additional LDConfig finishes.
  镀铬: 'chrome',
  斑点: 'speckle',
};
const PART_HELP = [
  '必填；工厂内部唯一编号',
  '乐高同款件必填；版本不唯一时另填 LDraw 文件',
  '如 3001.dat；匹配不唯一时必填',
  '自制件必填；形成 cu:<编码>，乐高同款件留空',
  '必填；工厂中文名称优先显示',
  '可选；分类 ID 或名称',
  '必填；工厂色号，多个用逗号分隔；见颜色列表',
  '在产 / 停产 / 待确认；空白默认在产',
  '可选；自由说明',
];
const COLOR_HELP = [
  '必填；工厂内唯一色号',
  '有乐高对应时必填；填写 LEGOID 注释的英文名称',
  '可选；整数，须与乐高色名一致',
  '可选；未填使用内置中文译名或英文',
  '必填；#RRGGBB，如 #B40000',
  '实色 / 透明 / 金属 / 珠光 / 闪粉 / 橡胶 / 夜光；另支持镀铬、斑点',
  '0–1，不透明为 1；空白沿用乐高色（透明独有色默认 0.5）',
  '可选；自由说明',
];

function workbook(): ExcelJS.Workbook {
  const book = new ExcelJS.Workbook();
  book.creator = 'Brickloop';
  book.created = FIXED_DATE;
  book.modified = FIXED_DATE;
  book.lastPrinted = FIXED_DATE;
  return book;
}

function sheet(
  book: ExcelJS.Workbook,
  name: string,
  columns: readonly string[],
  help: readonly string[],
): ExcelJS.Worksheet {
  const result = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 2 }] });
  result.addRow([...columns]);
  result.addRow([...help]);
  result.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  result.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245B78' } };
  result.getRow(2).font = { italic: true, color: { argb: 'FF777777' }, size: 10 };
  result.getRow(2).height = 60;
  result.getRow(2).alignment = { wrapText: true, vertical: 'top' };
  result.columns.forEach((column) => {
    column.width = 24;
    column.numFmt = '@';
  });
  result.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return result;
}

async function workbookBytes(book: ExcelJS.Workbook): Promise<Uint8Array> {
  const bytes = await book.xlsx.writeBuffer();
  // ExcelJS's inner ZIP entry timestamps otherwise depend on the wall clock.
  return deterministicZip(unzipSync(new Uint8Array(bytes)));
}

function dropdown(sheet: ExcelJS.Worksheet, column: number, formula: string, count: number): void {
  for (let row = 3; row <= Math.max(1002, count + 2); row++) {
    sheet.getCell(row, column).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [formula],
      showErrorMessage: true,
      errorTitle: '请使用列表中的值',
      error: '该值不在允许列表中。',
    };
  }
}

export async function packFiles(pack: Pack, editable = false): Promise<PackFiles> {
  const colorsBook = workbook();
  const colorsSheet = sheet(colorsBook, '颜色', COLOR_COLUMNS, COLOR_HELP);
  colorsSheet.getColumn(3).numFmt = '0';
  colorsSheet.getColumn(7).numFmt = '0.########';
  for (const color of pack.colors) {
    const def = color.definition;
    colorsSheet.addRow([
      color.factoryCode,
      def.legoName ?? '',
      def.legoColorId ?? '',
      def.nameZh,
      color.measuredRgb,
      Object.entries(MATERIALS).find(([, finish]) => finish === def.finish)?.[0] ?? '实色',
      def.alpha,
      color.note ?? '',
    ]);
  }
  dropdown(colorsSheet, 6, `"${Object.keys(MATERIALS).join(',')}"`, pack.colors.length);
  for (let row = 3; row <= Math.max(1002, pack.colors.length + 2); row++) {
    colorsSheet.getCell(row, 7).dataValidation = {
      type: 'decimal',
      operator: 'between',
      formulae: [0, 1],
      allowBlank: true,
      showErrorMessage: true,
    };
  }
  const partsBook = workbook();
  const partsSheet = sheet(partsBook, '零件', PART_COLUMNS, PART_HELP);
  const byId = new Map(pack.colors.map((color) => [color.colorId, color.factoryCode]));
  for (const part of pack.parts) {
    partsSheet.addRow([
      part.factoryNo,
      part.legoNo ?? '',
      part.ldrawFile ?? '',
      part.customCode ?? '',
      part.factoryName ?? '',
      part.categoryId ?? '',
      part.colors.map((id) => byId.get(id) ?? id).join(','),
      Object.entries(STATUSES).find(([, status]) => status === part.status)?.[0] ?? '在产',
      part.note ?? '',
    ]);
  }
  const list = partsBook.addWorksheet('颜色列表');
  list.addRow(['工厂色号', '中文名', '乐高色名']);
  for (const color of pack.colors)
    list.addRow([color.factoryCode, color.definition.nameZh, color.definition.legoName ?? '']);
  list.columns.forEach((column) => {
    column.width = 25;
  });
  list.getRow(1).font = { bold: true };
  partsBook.definedNames.add(`'颜色列表'!$A$2:$A$${Math.max(pack.colors.length + 1, 2)}`, 'FactoryColors');
  dropdown(partsSheet, 8, `"${Object.keys(STATUSES).join(',')}"`, pack.parts.length);
  // Excel has no multi-select validation. The list suggests one code, while multiple comma-separated codes remain allowed.
  for (let row = 3; row <= Math.max(1002, pack.parts.length + 2); row++) {
    partsSheet.getCell(row, 7).dataValidation = {
      type: 'list',
      formulae: ['FactoryColors'],
      allowBlank: true,
      showErrorMessage: false,
      showInputMessage: true,
      promptTitle: '可产颜色',
      prompt: '选择单个色号，或输入多个色号并用逗号分隔。',
    };
  }
  const files: PackFiles = {
    ...pack.assets,
    'parts.xlsx': await workbookBytes(partsBook),
    'colors.xlsx': await workbookBytes(colorsBook),
  };
  if (pack.categories.length) {
    const categoriesBook = workbook();
    const categoriesSheet = sheet(categoriesBook, '分类', CATEGORY_COLUMNS, [
      '必填；唯一 ID',
      '必填；中文名称',
      '可选',
      '可选；根分类留空',
      '可选；整数，默认 0',
      '可选；图标名称',
    ]);
    for (const category of pack.categories)
      categoriesSheet.addRow([
        category.id,
        category.nameZh,
        category.nameEn,
        category.parentId ?? '',
        category.order,
        category.icon ?? '',
      ]);
    files['categories.xlsx'] = await workbookBytes(categoriesBook);
  }
  files['pack.json'] = Buffer.from(
    JSON.stringify({ ...pack.manifest, contentHash: editable ? '' : contentHash(files) }, null, 2) + '\n',
  );
  return files;
}

export async function writePack(destination: string, pack: Pack): Promise<void> {
  await writePackFiles(destination, await packFiles(pack));
}

export async function exportTemplate(destination: string, options: { from?: Pack } = {}): Promise<void> {
  const example: Pack = {
    manifest: {
      id: 'factory-template',
      name: '工厂零件库模板',
      version: '1.0.0',
      source: '请替换为工厂与资料来源',
      createdAt: FIXED_DATE.toISOString(),
      templateVersion: 1,
      contentHash: '',
    },
    parts: [
      {
        partId: 'ld:3001',
        factoryNo: 'EXAMPLE-001',
        legoNo: '3001',
        ldrawFile: '3001.dat',
        factoryName: '砖 2×4',
        status: 'active',
        colors: ['c:bright-red'],
        note: '示例行；填写时请替换或删除',
      },
    ],
    colors: [
      {
        colorId: 'c:bright-red',
        factoryCode: 'EXAMPLE-RED',
        measuredRgb: '#B40000',
        definition: {
          id: 'c:bright-red',
          legoName: 'Bright Red',
          legoColorId: 21,
          nameZh: '亮红',
          ldrawCode: 4,
          rgb: '#B40000',
          edgeRgb: '#333333',
          finish: 'solid',
          alpha: 1,
        },
      },
    ],
    categories: [],
    assets: {},
  };
  await writePackFiles(destination, await packFiles(options.from ?? example, true));
}
