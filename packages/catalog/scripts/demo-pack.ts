import path from 'node:path';
import { buildCatalogIndex, defaultLibraryDir, repositoryRoot } from '../src/catalog-index';
import { readColors } from '../src/colors';
import { DEMO_COLOR_CODES, DEMO_PARTS } from '../src/demo-parts';
import { importPack } from '../src/pack-import';
import { writePack } from '../src/pack-workbooks';
import type { Pack, PackColor, PackPart, PartId } from '../src/types';

const index = await buildCatalogIndex();
const definitions = await readColors(path.join(defaultLibraryDir, 'LDConfig.ldr'));
const byId = new Map(index.parts.map((part) => [part.id, part]));
const colors: PackColor[] = DEMO_COLOR_CODES.map((code, i) => {
  const definition = definitions.find((color) => color.ldrawCode === code);
  if (!definition?.legoName) throw new Error(`示例颜色 ${code} 缺少乐高对应`);
  return {
    colorId: definition.id,
    factoryCode: `DEMO-${String(i + 1).padStart(3, '0')}`,
    measuredRgb: definition.rgb,
    definition,
  };
});
const missing = DEMO_PARTS.filter((number) => !byId.has(index.aliases[`ld:${number}`] ?? `ld:${number}`));
if (missing.length) throw new Error(`示例清单中的零件不存在或被排除：${missing.join(', ')}`);
const parts: PackPart[] = DEMO_PARTS.map((number, i) => {
  const id: PartId = index.aliases[`ld:${number}`] ?? `ld:${number}`;
  const part = byId.get(id)!;
  return {
    partId: part.id,
    legoNo: part.legoNo,
    ldrawFile: part.ldrawFile,
    factoryNo: `DEMO-P${String(i + 1).padStart(3, '0')}`,
    factoryName: part.nameZh,
    status: 'active',
    colors: colors.map((color) => color.colorId),
  };
});
const duplicates = parts.filter((part, i) => parts.findIndex((entry) => entry.partId === part.partId) !== i);
if (duplicates.length)
  throw new Error(`示例清单存在别名解析后的重复零件：${duplicates.map((part) => part.partId).join(', ')}`);
const pack: Pack = {
  manifest: {
    id: 'demo',
    name: '示例包',
    version: '1.0.0',
    source: 'LDraw.org 官方零件库与 LDConfig（2026-05-29）；用于开发演示，非真实工厂产能。许可：CC BY 4.0。',
    createdAt: '2026-05-29T00:00:00.000Z',
    templateVersion: 1,
    contentHash: '',
  },
  parts,
  colors,
  categories: [],
  assets: {},
};
const destination = path.join(repositoryRoot, 'library/packs/demo');
await writePack(destination, pack);
const result = await importPack(destination, { catalog: index, colors: definitions });
if (!result.pack) throw new Error(JSON.stringify(result.report, null, 2));
console.log(`示例包已生成并通过导入校验：${parts.length} 件、${colors.length} 色；每件可产全部示例颜色。`);
