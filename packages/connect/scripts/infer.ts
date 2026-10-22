import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { importPack } from '@brickloop/catalog';
import { createLibraryResolver } from '@brickloop/ldraw/node';
import { parseLDraw } from '@brickloop/ldraw';
import { inferConnectors, parseConnectorFile, writeConnectorFile, ConnectorDataError, connectorCells } from '../src';
import type { ConnectorFile } from '../src';

const root = fileURLToPath(new URL('../../../', import.meta.url));
/** These legacy/design IDs are acceptance fixtures in addition to current pack IDs. */
export const ACCEPTANCE_PARTS = [
  '3001',
  '3003',
  '3004',
  '3020',
  '3022',
  '3023',
  '3024',
  '3069b',
  '3062b',
  '4073',
  '3794',
  '2412',
  '3700',
  '3713',
  '3749',
  '3673',
  '6558',
  '32523',
  '4274',
  '4085',
  '15712',
  '61252',
  '14417',
  '14418',
  '3626',
  '973',
  '970',
];
export async function generatePack(packId = 'demo', outputDir = path.join(root, 'library/connectors')): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(packId)) throw new Error('Invalid pack ID');
  const imported = await importPack(path.join(root, 'library/packs', packId), {
    libraryDir: path.join(root, 'library/ldraw'),
  });
  if (!imported.pack) throw new Error(JSON.stringify(imported.report));
  const resolver = createLibraryResolver({ libraryDir: path.join(root, 'library/ldraw') });
  const formatting = (await resolveConfig(path.join(root, 'package.json'))) ?? {};
  const packParts = new Set(imported.pack.parts.map((p) => p.partId));
  const parts = new Map(imported.pack.parts.map((p) => [p.partId, p.ldrawFile]));
  if (packId === 'demo') for (const id of ACCEPTANCE_PARTS) parts.set(`ld:${id}`, `${id}.dat`);
  await fs.mkdir(outputDir, { recursive: true });
  const rows: { id: string; family: string; status: string; distribution: string; raw: string; inPack: boolean }[] = [];
  const unrecognized: string[] = [],
    drafts: string[] = [],
    failures: string[] = [],
    totals = new Map<string, number>();
  let written = 0,
    preserved = 0;
  for (const [id, fileName] of [...parts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    try {
      if (!fileName) throw new Error('No LDraw geometry');
      const resolved = await resolver.resolve(fileName);
      if (!resolved) throw new Error(`Missing ${fileName}`);
      const parsed = parseLDraw(resolved.text, fileName);
      const raw = await inferConnectors(fileName, resolver, { partId: id });
      const name = path.join(outputDir, id.replace(/^[^:]+:/, '') + '.json');
      let file: ConnectorFile = raw;
      try {
        const loaded = parseConnectorFile(await fs.readFile(name, 'utf8'), name);
        if (!loaded.file) throw new ConnectorDataError(loaded.issues);
        if (loaded.file.partId !== id) throw new Error(`PartId mismatch in ${name}`);
        if (loaded.file.status !== 'inferred') {
          file = loaded.file;
          preserved++;
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (file === raw) {
        await fs.writeFile(name, await format(writeConnectorFile(file), { ...formatting, parser: 'json' }), 'utf8');
        written++;
      }
      if (!raw.connectors.length) unrecognized.push(id);
      if (file.status === 'draft') drafts.push(id);
      const counts = (f: ConnectorFile): string => {
        const types = new Map<string, number>();
        for (const c of f.connectors) types.set(c.type, (types.get(c.type) ?? 0) + connectorCells(c).length);
        return (
          [...types.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([type, n]) => `${type}: ${n}`)
            .join(', ') || '无'
        );
      };
      if (packParts.has(id))
        for (const c of file.connectors) totals.set(c.type, (totals.get(c.type) ?? 0) + connectorCells(c).length);
      rows.push({
        id,
        family: parsed.title.split(/\s+/).filter(Boolean).slice(0, 2).join(' '),
        status: file.status,
        distribution: counts(file),
        raw: counts(raw),
        inPack: packParts.has(id),
      });
    } catch (error) {
      failures.push(`${id}: ${String(error)}`);
    }
  }
  const packRows = rows.filter((r) => r.inPack),
    empty = rows.filter((r) => r.distribution === '无');
  const lines = [
    '# 示例包连接器数据',
    '',
    '由 `pnpm connect:infer --pack demo` 生成。仅使用 LDraw 文本几何和本项目规则；未使用 Studio 连接文件、代码或数据。',
    '',
    `数据包：${packParts.size} 件；已生成：${packRows.length} 件；包外验收编号：${rows.length - packRows.length} 件。`,
    `状态（包内）：inferred ${packRows.filter((r) => r.status === 'inferred').length}，draft ${packRows.filter((r) => r.status === 'draft').length}，reviewed ${packRows.filter((r) => r.status === 'reviewed').length}。`,
    '',
    '推断不等于几何连接完整性；inferred 文件可能只有部分连接。未识别零件保留显式空数组与 inferred 状态，加载错误则中止该文件并使脚本失败。draft 是人工几何标注，仍待维护者审核。',
    '',
    '网格数量按有效单元计。底部 tube 同时有 `cells.tube` 语义标记与实际半格位置的独立 `antistud.tube`，本表只计算实际连接项，不重复计算元数据。',
    '',
    '## 包内类型分布',
    '',
    '| 类型 | 单元 / 线段数量 |',
    '| --- | ---: |',
    ...[...totals.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([type, n]) => `| ${type} | ${n} |`),
    '',
    '## 人工补写（包括验收别名）',
    '',
    drafts.join('、') || '无',
    '',
    '补写依据与局限见 packages/connect/README.md；已有 draft/reviewed 文件不会被脚本覆盖。',
    '',
    '## 自动推断未识别清单',
    '',
    unrecognized.join('、') || '无',
    '',
    `最终仍为空：${empty.map((r) => r.id).join('、') || '无'}。`,
    '',
    '## 每件结果',
    '',
    '| PartId | 包内 | 类别 / 标题前缀 | 状态 | 已保存类型分布 | 原始推断类型分布 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) => `| ${r.id} | ${r.inPack ? '是' : '验收'} | ${r.family} | ${r.status} | ${r.distribution} | ${r.raw} |`,
    ),
    '',
    '来源、作者署名与许可证：LDraw.org 官方库，逐文件 Author / !HISTORY / !LICENSE 保留在 library/ldraw 对应 DAT；派生与修改说明见 docs/third-party.md。',
    '',
  ];
  await fs.writeFile(
    path.join(outputDir, 'README.md'),
    await format(lines.join('\n'), { ...formatting, parser: 'markdown' }),
    'utf8',
  );
  console.log(
    `connect:infer pack=${packId}; pack parts=${packParts.size}; files=${rows.length}; written=${written}; preserved=${preserved}; failed=${failures.length}`,
  );
  for (const row of rows) console.log(`${row.id} [${row.family}] ${row.status}: ${row.distribution}`);
  console.log(`Unrecognized (${unrecognized.length}): ${unrecognized.join(', ')}`);
  console.log(`Manual draft (${drafts.length}): ${drafts.join(', ')}`);
  if (failures.length) throw new Error(failures.join('\n'));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--pack'))
    throw new Error('Usage: pnpm connect:infer [--pack demo]');
  await generatePack(args[1] ?? 'demo');
}
