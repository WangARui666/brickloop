# @brickloop/catalog

M1-2 的 Node.js 逻辑层：LDraw 目录、中文搜索、颜色表和可替换工厂数据包。应用通过 IPC 调用文件读写能力；本包不包含界面，不保存应用的「当前启用包」设置，也不修改工程文档。

## M7-1a 图案分组

规则位于 `library/macros/patterns.json`，`version: 1` 是结构版本，`revision` 是内容版本。`parsePatternRules(json)` 校验规则；`groupPatterns(catalogIndex, rules)` 返回固定顺序的 `{ groupId, parts: PartId[] }[]`：`faces/torsos/legs/screens/texts/controls/symbols`，对应 `catalog.patterns.groups.<groupId>` 中英文文案。`@brickloop/catalog/types` 提供不依赖 Node 模块的类型入口。

仅处理同时有 `printed` 标志和 `baseOf` 的零件。每条规则有 `baseIds/include/exclude/whitelist/blacklist`：基础件白名单和英文标题包含词必须同时满足；空列表表示该条件不限。标题按忽略大小写的完整词/词组匹配，例如 `screen` 不会命中 `windscreen`。黑名单优先级最高，人工白名单可覆盖该组的基础件、关键词和排除条件。每件只进入首个命中组；组顺序固定，不受 JSON 中的组排列影响；组内按 PartId 排序，不随输入索引顺序变化。

人仔头、躯干和腿的基础件表覆盖当前完整库内的常规/特殊 Minifig 与 Friends 系列，不将头饰与手持配件当作表情。屏幕、键盘限制件形，屏幕额外列出经标题核对的斜面屏幕和笔记本盖白名单。标志组匹配 logo/sign/symbol 等词，未将所有剩余印刷件自动归入“其他”。

```ts
const rules = parsePatternRules(JSON.parse(rulesJson));
const patterns = new PatternCatalog(catalogIndex, rules);
patterns.groups; // 固定七组，全部 ID，无默认 100 件上限。
patterns.searchPatterns('keyboard', 'controls'); // 返回 PartDef[]。
patterns.searchPatterns('人仔'); // 支持中英文名称、编号和既有拼音关键词。
patterns.unclassified; // 排序、去重的未归类印刷件 ID。
```

切换目录或规则版本后重建 `PatternCatalog`。该服务不筛除当前包外的印刷件；界面可使用现有 `CatalogService.isFactoryPart/availableColors` 标出可用性。完整库统计脚本只读取 `library/ldraw`，缓存写当前 worktree 的 `.devdata/cache/catalog`：

```powershell
node scripts/devenv.mjs pnpm patterns:stats
node scripts/devenv.mjs pnpm exec vitest run packages/catalog/test/patterns.test.ts --reporter=verbose --silent=false
```

统计用例在缺少 LDraw 库时跳过，固定夹具仍执行。当前统计及范围说明见 [宏内容说明](../../library/macros/README.md)。

## 命令

在仓库根目录运行，脚本均经 `scripts/devenv.mjs` 设置开发环境：

```powershell
pnpm catalog:index
pnpm catalog:index --force
pnpm catalog:demo-pack
pnpm --filter @brickloop/catalog test
pnpm verify
```

真实库用例需要 `library/ldraw/LDConfig.ldr` 和 `parts/`。缺少时跳过并提示先运行 M1-1 提供的 `pnpm ldraw:fetch`；夹具测试仍运行。脚本只读取 LDraw 文件，不执行库中程序。

目录缓存为 `.devdata/cache/catalog/<版本>-<指纹>.json`。指纹包含 LDConfig 内容、顶层 DAT 文件名/大小/修改时间及索引格式修订，库变化后自动重建；损坏缓存也会重建。默认路径从包的位置推导，可通过参数注入。

## 接入

```ts
import path from 'node:path';
import {
  buildCatalogIndex,
  readColors,
  PackStore,
  CatalogService,
  exportTemplate,
  importPack,
  diffPacks,
} from '@brickloop/catalog';

const catalog = await buildCatalogIndex();
const colors = await readColors('library/ldraw/LDConfig.ldr');
const store = new PackStore('library/packs', { catalog, colors });
const pack = await store.resolveActive(savedPackId);
const service = new CatalogService(catalog, colors, pack);

service.search('2x4 砖'); // 默认当前包中非停产件，最多 100 条 PartDef
service.search('phb', { includeAll: true, limit: 50 });
service.factoryInfo('ld:3001');
service.isFactoryPart('ld:3001');
service.isFactoryColor('c:bright-red');
service.availableColors('ld:3001'); // ColorDef[]，已应用实测值
service.getPart('ld:3001'); // 已应用工厂名称、分类覆盖
service.getColor('c:bright-red');

await exportTemplate(path.join('output', 'factory-template'), { from: pack });
const result = await importPack('incoming.brklpack', { catalog, colors });
if (result.pack) {
  const diff = diffPacks(pack, result.pack);
  const impact = service.impactOf(documentReferences, pack, result.pack);
  // 展示 diff/impact；确认后调用 store.import，应用设置保存新包 ID。
}
```

`importPack(source, options)` 的 source 可以是目录路径、`.brklpack` 路径或 ZIP 字节；未传 catalog/colors 时按默认库路径加载。`skipInvalidRows: true` 返回可用行和完整错误报告。缺文件、缺表头、不支持的模板版本、哈希不符等结构错误不能通过跳行绕过。

`ImportReport.errors/warnings` 的每项包含 `file/sheet/row/column/reason`。数据行保留 XLSX 中实际行号，首条数据通常为第 3 行。`row: 0` 表示文件级错误。`acceptedParts/acceptedColors` 是有效行数，`skippedRows` 按有错误的文件与行去重统计。

## 目录和搜索

- 顶层 DAT 扫描排除 `~`、`Moved to`、子零件和图元。Alias 不重复展示，存入 `aliases`；`getPart`、工厂查询与编号搜索会解析别名。
- `PartId` 使用小写文件名；`legoNo` 保留完整文件名去扩展名。尾部字母模具版本还加入共同数字设计编号的映射。`matchLegoNumber` 返回全部匹配；印刷后缀 `p<数字>`、`pr<数字>` 单独保留，并记录 `baseOf`。
- 分类优先 `!CATEGORY`，否则使用标题首词；如 `Technic Axle` 的多词分类保留原名并挂到 `Technic` 下。数据包提供分类树时以其为准。
- 工厂名称优先显示，搜索同时使用英文标题、原目录关键词、当前中文名称及其拼音。尺寸统一为 `2x4`；支持砖块/砖、光面板/平滑板等同义词。
- 排序为编号精确匹配、名称/拼音前缀、关键词、子串或有序字符模糊匹配；同分按 PartId 稳定排序。`includeAll`、`limit`、`categoryId` 可选。`pending` 属于工厂件，`discontinued` 不属于。
- `bboxLdu` 在头信息目录阶段为 `null`，明确表示尚未计算；几何解析、真实包围盒和连接器属于后续集成。`geometry.hash` 是 DAT 源文本的 SHA-256，`connectorsRef` 暂为 `null`。

`ldraw-headers.ts` 是并行开发期间的最小适配器，未依赖尚未合并的 `@brickloop/ldraw`。合并时可以用该包的公开头信息 API 替换适配器。

## 颜色

`parseLDConfig` 读取 `!COLOUR` 及紧邻其前的 `// LEGOID`。多个 LEGO 编号的注释使用首个作为 `legoColorId`；ID 由乐高名称生成，如 `Bright Red → c:bright-red`，不使用 LDraw 的 `Red` 别名。没有 LEGO 对应的定义使用 `ld:<代码>`，工厂独有色使用 `cx:<工厂色号>`。中文翻译未覆盖时显示英文。

`alpha` 为 0–1，1 为不透明；材质标记优先于透明度决定 finish。支持 CHROME、METAL、PEARLESCENT、RUBBER、GLITTER、SPECKLE 和 LUMINANCE。`colorIdFromLDrawCode` 将代码 16 返回为文档哨兵 `inherit`。

## 模板与数据包

本实现选择 **两个独立 XLSX 文件**：`parts.xlsx`、`colors.xlsx`，同时生成 `pack.json`。第 1 行中文表头、第 2 行灰色斜体说明、第 3 行起为数据。空白模板带可替换的示例行，当前包模板带全部当前资料。

状态、材质提供下拉。材质包含规格中的七项，另有镀铬、斑点以保证 LDConfig 信息往返。`parts.xlsx` 内附「颜色列表」与命名范围 `FactoryColors`；可选择一个色号，也可手工填写逗号分隔的多个色号，导入时逐个校验。编号列使用文本格式以保留前导零；透明度列限制在 0–1。模板预设 1,000 条数据行的下拉，导入不限制于此行数。

可选的 `categories.xlsx` 采用 `分类 ID / 中文名 / 英文名 / 父分类 ID / 顺序 / 图标`；校验重复、缺失父节点与循环。零件分类列可填写 ID 或中文名。未提供分类树时，分类列作为工厂分类标识保留。

工厂自制件的 `自制件编号` 形成 `cu:` ID。几何引用指向 `custom/<LDraw 文件>`，未填文件时尝试 `custom/<自制件编号>.dat`。没有 DAT 时给出警告并保留条目，便于后续用缺失几何占位。`custom/`、`images/` 下的原始文件在目录/ZIP 往返与入库时保留，包括待转换的 STL/STEP。

同一包内工厂编号、工厂色号、稳定 PartId、稳定 ColorId 均须唯一；工厂编号和工厂色号的重复判断忽略大小写。这样每个稳定 ID 的工厂编号、实测色与可产配色没有歧义。

正式 `writePack` 生成内容哈希；哈希依次覆盖按路径排序的文件名、长度、原始字节，不含 `pack.json`。`exportTemplate` 清空哈希，允许填写后导入。修改已封装的正式包会触发哈希错误；应先导出可编辑模板。XLSX 属性及内外 ZIP 时间固定，同输入同字节输出。

`PackStore(dir)` 提供 `list/read/import/delete/resolveActive`。导入先校验，再写入同目录的暂存目录，完成后重命名到 `<dir>/<包ID>`，保留旧包。已存在的包 ID 不覆盖；新版资料应使用新 ID，便于随时回滚。`resolveActive` 找不到或无法读取指定包时回退到 demo，再回退到仓库内置示例包；调用方可比较返回 ID 与请求 ID 展示回退提示。

`diffPacks` 按 PartId 比较零件，按工厂色号比较颜色，所以同一工厂色号改映射会列为变更。集合顺序变化不算变更。

`impactOf` 接受 `{partIds, colorIds, instances}` 或 `{partId, colorId}[]`，返回新变为非工厂件/非工厂色及新失去的可产配色。只有 IDs 列表时报告成员资格变化；要检查组合配色需提供配对的 instances。它不修改输入，`inherit` 不按独立颜色检查；将应用设置切回旧包即可回滚。

## 示例与验收记录

`src/demo-parts.ts` 的每项带类别注释。内置示例为 **222 件、40 色**（30 实色、10 透明色），工厂编号 `DEMO-P001` 起、工厂色号 `DEMO-001` 起；每件关联所有示例色。实测值暂用 LDConfig 主色，仅供开发。

2026-10-16 在提供的 2026-05-29 库上得到 **20,463 件、89 分类、482 别名**。FAC-01–07、UI-03 逻辑测试覆盖模板填写五行、歧义映射、错误跳行、默认工厂范围、差异、回滚、文档引用不变，以及示例包重建字节一致。

全库范围每查询 20 次的实测记录如下，含首次查询；阈值由测试逐次检查为 `< 30 ms`：

| 查询             | 首次 ms | 中位数 ms | 最大 ms |
| ---------------- | ------: | --------: | ------: |
| `2x4 砖`         |    8.36 |      7.80 |    9.53 |
| `3001`           |    6.56 |      6.93 |   10.37 |
| `DEMO-P012`      |   12.81 |     12.77 |   14.47 |
| `phb`            |   10.37 |     10.13 |   11.66 |
| `平滑板`         |    8.53 |      8.53 |    9.51 |
| `technc`（模糊） |   15.78 |     14.67 |   15.78 |

可用下列命令显示测试里的详细耗时日志：

```powershell
node scripts/devenv.mjs pnpm exec vitest run packages/catalog/test/integration.test.ts --reporter=verbose --disableConsoleIntercept
```

临时测试文件位于 `.devdata/catalog-tests`，测试结束自动清理。依赖说明与 LDraw 署名见 `docs/third-party.md`。
