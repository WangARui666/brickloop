# @brickloop/io

工程 ZIP、Studio `.io`、LDraw `.ldr/.mpd` 的编解码，以及 Node 原子保存和崩溃恢复。根入口不依赖 Node、DOM 或目录服务的 XLSX/文件系统实现；`tsconfig.worker.json` 单独检查 Worker 入口。没有复制 Studio 代码或样例资源。

## 公开接口

| 入口                 | 接口                                                         | 返回/用途                                                                                        |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `@brickloop/io`      | `packProject(doc, workspace, assets?, options?)`             | 同步生成 `Uint8Array`                                                                            |
| 同上                 | `unpackProject(bytes, { migrations? }?)`                     | `{ doc, workspace, assets, issues, manifest, preservation, readOnly }`，文档不可读时 `doc: null` |
| 同上                 | `importLDraw(text, fileName, ctx?)`、`importIo(bytes, ctx?)` | `{ doc, workspace, assets, parts, colors, report }`                                              |
| 同上                 | `exportLDraw(doc, ctx?)`                                     | `{ text, report }`                                                                               |
| 同上                 | `exportIo(doc, ctx?)`                                        | `{ bytes, report }`                                                                              |
| 同上                 | `attachEmbeddedPart(doc, assets, fileName, bytes, partId?)`  | 添加自制几何资源及核心文档引用，返回目录映射                                                     |
| 同上                 | `hashBytes(bytes)`、`crc32(bytes)`                           | SHA-256 / CRC32 小写十六进制                                                                     |
| 同上                 | `PROJECT_FORMAT_VERSION`、`projectMigrations`                | 当前格式 1、显式逐版本迁移表                                                                     |
| 同上                 | `STUDIO_INFO_VERSION`、`STUDIO_PARTS_DB_VERSION`             | 样例默认值 `2.25.11_3`、`200`                                                                    |
| 同上                 | `IoIssue`、`IoReport`、`ioMessagesZh`、相关上下文/选项类型   | 结构化报告与可接入 i18n 的中文默认文案                                                           |
| `@brickloop/io/node` | `saveProjectAtomic(path, bytes, options?)`                   | 异步分类结果 `SaveResult`                                                                        |
| 同上                 | `RecoveryStore(rootDir, options?)`                           | 每文档独立恢复目录和操作队列                                                                     |
| 同上                 | `transactionFromChange(event, at?, assets?)`                 | 把 core 的提交/撤销/重做事件转为日志事务                                                         |
| 同上                 | `trackSession(store, session, options)`                      | 自动订阅事件、批量刷盘、周期/空闲/计数快照，返回 `flush/closeClean/dispose`                      |

`IoContext.parts/colors` 接受 `@brickloop/catalog` 的 PartDef/ColorDef 数组（只使用结构子集）；主进程先加载目录，再把普通 JSON 映射发给 Worker。无需扩展 core、ldraw 或 catalog 接口。颜色 16 对应 `inherit`，无映射颜色为 `ld:<code>`，未知标准零件为 `ld:<文件名去.dat>`。返回的 `parts/colors` 是当前导入用到的最小映射，调用方可交给目录层补全显示资料。导出 `c:`/`cx:` 颜色时应提供当前目录色表；没有 LDraw 码的颜色按 RGB 距离选最近的可导出颜色，完全没有候选时回退 7 并报告。

## 工程文件

`ProjectAssets` 为 ZIP 相对成员路径到字节数组的映射，例如 `assets/images/<sha256>`、`assets/parts/my-part.dat`。`thumbnail.png` 默认是透明的 512×512 PNG；调用方通过 `options.thumbnail` 提供实际视口预览。`options.history` 和 `options.instructions` 分别写 AI JSONL 和说明书 JSON。空资源目录不写占位成员。

清单记录所有有效载荷成员的大小和 SHA-256；清单自身不参与自身哈希。ZIP 读取还检查 CRC32、中央目录/本地头一致性，并逐成员报告错误。损坏资源不阻止读取健康文档；文件名附在问题中。支持 ZIP32 的 stored/deflate，单成员上限 256 MiB、总展开上限 512 MiB；不支持 ZIP64/分卷。不会把 ZIP 路径直接解压到文件系统。

未知文档、模型、实例、工作区、manifest 字段及未知成员保留。普通 `unpack → pack` 传回同一个 `assets` 对象时自动保留 manifest 扩展；跨 Worker、克隆资源映射或持久化中间结果时，应显式传 `options.preservation`：

```ts
const opened = unpackProject(bytes);
if (opened.doc && !opened.readOnly) {
  const saved = packProject(opened.doc, opened.workspace, opened.assets, {
    preservation: opened.preservation,
  });
}
```

内置 `0 → 1` 迁移仅覆盖与当前 payload 结构相同的兼容夹具，不声称支持其他历史产品格式。迁移表可注入，每次必须前进一个版本。较新 formatVersion 只读打开，默认拒绝再次打包；显式 `allowNewerVersion` 允许尽力写回并保留新版本号。

## 原子保存

顺序为：同目录随机临时文件 → 写完/`FileHandle.sync()` → 重新读取并比较完整字节哈希与工程 manifest → 可选复制旧文件到临时备份、刷盘后替换 `.bak` → `fs.rename(temp, target)` → 对目标再次刷盘。备份使用复制，原文件在替换点前一直存在。

Windows 实际采用 Node/libuv 的 `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` 路径，没有 FFI/原生扩展，也没有调用 `ReplaceFileW`。这使纯 Node 适配层可安装、测试，并避免先删目标造成的保存空窗。实现依据：[Node 文件系统 API](https://nodejs.org/api/fs.html)、[libuv Windows fs 实现](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c)。

`SAVE_PERMISSION`、`SAVE_NO_SPACE`、`SAVE_BUSY`、`SAVE_VALIDATION`、`SAVE_IO` 在替换前失败时返回 `ok: false`，原文件保持原字节，清理临时文件。若替换已成功但后续刷盘失败，则返回 `ok: true, durability: 'uncertain'` 和 `SAVE_DURABILITY`，如实区分已提交与持久性状态；调用方应显示此问题。文件系统故障适配器和三个检查点可用于可重复测试。

正常进程崩溃下替换不会留下半个正式文件。Windows 的 Node API 没有目录 fsync，也未设置 `MOVEFILE_WRITE_THROUGH`；突然断电时目录元数据持久性仍依赖文件系统/设备，不能把文件刷盘等同于已验证的整机断电保证。POSIX 环境额外刷盘父目录。

## 崩溃恢复

目录为 `<rootDir>/recovery/<documentId>/`，包含 `session.json`、`snapshot-<revision>.brkl`、`journal-<baseRevision>.jsonl`、`assets/<sha256>`。

`RecoveryStore` 方法：

- `startSession(docId, bytes, projectPath?)`：写初始快照并记录原文件路径。`writeSnapshot` 也可初始化新会话。
- `appendTransaction(docId, tx)`：资源先写完并刷盘，再追加完整事务行。返回 `seq`、`lastDurableAt`。资源参数以 SHA-256 为键，`asset.add` 引用的资源必须已存在或同时提供。
- `flush(docId)`：显式刷盘；默认后台合并窗口 1,000 ms，可调小。正常磁盘响应与事件循环条件下，最多约一秒尚未持久化；IO 失败通过方法拒绝或 `onError` 显示，不能继续承诺该恢复点。
- `checkpoint(docId)`：获取当前 `{ seq, revision }`。
- `writeSnapshot(docId, bytes, revision, snapshotSeq?)`：校验身份/版本/revision，写带 `manifest.recovery.seq` 的快照，写新日志并保留序号更晚的事务，最后清理旧快照/日志。异步捕获旧状态时同时传捕获的 seq，尤其适用于撤销后重复 revision。
- `scanRecoverable()`：只列出未正常关闭且 PID 不再存在的会话，包括文档名、原路径、事务数、最后恢复时间及问题。损坏 session 单独报告。默认 PID 检查保守对待仍存在的进程；宿主可注入带进程启动时间的检查，解决 PID 重用。
- `recover(docId)`：选择最高日志序号的有效快照，顺序重放完整事务；校验、序号、revision 链或资源失败时停止，整个失败事务不发布。返回 `unsaved: true`，不恢复撤销历史。
- `closeClean(docId)`：标记正常关闭后仅删除该文档目录；校验 ULID 和实际目录，拒绝目录链接或越界。
- `dispose()`：停止定时器并刷盘，保留恢复数据。

core 的撤销/重做会回到旧 revision，分支提交还会跳过 revision。因此日志按严格递增 `seq` 重放，要求 `prevRevision === 当前 revision`，而不要求 `revision === prevRevision + 1`。快照中的序号用于处理中断残留日志和去重。新快照发布后、日志裁剪前崩溃也不会重复应用已包含的事务。

自动接入示例：

```ts
const store = new RecoveryStore(userDataPath, { onError: showRecoveryError });
const tracking = await trackSession(store, session, {
  project: () => ({ workspace: session.workspace, assets: projectAssets }),
  projectPath,
  onError: showRecoveryError,
});
// 默认 5 分钟 / 200 个提交事件 / 修改后空闲 30 秒，取先满足的条件。
// 应用正常关闭文档（已保存或明确放弃）时：
await tracking.closeClean();
```

已有遗留会话不会被初始化隐式覆盖。先恢复并安全保存/保留返回资源，再明确 `closeClean` 并为恢复后的编辑会话重新 `startSession`。每文档使用一个 Store 写入者；多文档互不阻塞。没有添加跨进程锁文件。

## Studio 兼容与报告

主模型顺序为 `modelv2.ldr → modelv1.ldr → model.ldr`，损坏候选可回退。支持 BOM、名称空格、大小写规范化匹配、11 行的 UID 与隐藏状态；隐藏集合包含共享模型中每个出现的完整 InstancePath。

UID 位于 `instance.extensions.studio.uid`；导入 UID 沿用，新实例 ID 映射为稳定的正 31 位数字，避免 Studio 整数溢出。重复/无效 UID 会重新分配并报告。原始变换及核心保存规整值作为扩展保留：直接往返和经过一次 `.brkl` 规整后，无修改实例均能恢复原始六位小数。新建/修改实例平移规整到 `1e-5`，全部矩阵字段输出六位小数，UTF-8 无 BOM。内部坐标已是 LDraw，不做 Unity 坐标翻转。

输出 `model.ldr`、`modelv2.ldr`、`.info`、`errorPartList.err`，可选调用方缩略图及 `CustomParts/`、参考图。`total_parts` 为递归展开零件数。自制件及 `p/`、`s/` 几何可通过 `assets/parts/` 提供；缺几何写报告错误。Studio 连接/碰撞数据、说明书、柔性参数、`model2.ldr`、`model.lxfml` 不导入；不写 Studio 的后三种模型/说明书文件。参考图字节导入工程，位置配置保留在 `doc.extensions.studio.referenceImages`。

编组降级为 `0 // BRICKLOOP GROUP ...` 注释并报告。共享子模型的不同出现若具有不同隐藏状态，Studio 定义级行无法独立表达，导出报告降级并使该定义实例可见。保留共享结构优先。

报告的 `counts` 区分展开件数、定义数、子模型数、存储实例数、步骤数、零件/颜色映射数；`degradations/omitted/warnings/errors` 均有 `code/messageKey/severity/file?/detail?`。默认中文文案在 `ioMessagesZh`，后续 UI 可接入正式 i18n。本任务未修改 UI/i18n 包。

## 测试与人工文件

从工作树根目录运行：

```powershell
node scripts/devenv.mjs pnpm verify
node scripts/devenv.mjs pnpm exec vitest run packages/io --reporter=verbose
node scripts/devenv.mjs pnpm -F @brickloop/io fixtures
```

测试覆盖 P01/P02/P04/P05、REC-01/02/03/05/06/07、IO-01/02/05/06/07/09 和 AI 生成模型相同的逻辑导出入口。包括真实子进程强制结束、权限/空间/占用/重读校验故障注入、快照发布与日志裁剪的中断点、50 次快照期间持续编辑共享定义、撤销/重做/分支重放。

Banana 只读样例测试仅在设置 `BRICKLOOP_STUDIO_BANANA` 时运行，将该环境变量设为本地 `Banana.io` 的路径；未设置或文件不存在时，测试说明跳过原因。样例不复制入库，自动化断言为展开 186 件、21 个定义、192 个存储引用，并逐项比较颜色/变换/子模型/UID。

生成的 `test/fixtures/io/out/mod-01.io`、`custom-parts.io` 和 `reports.json` 已被现有 `out/` 规则忽略。`mod-01.io` 应显示红黄各两件、共享 pair 两次、第二次旋转平移；`custom-parts.io` 应显示四个自建立方体。需主窗口在 Studio 2.26.8_1 打开，核对颜色/位置/共享/步骤，再移动一件并保存。这里只完成逻辑和文件系统自动化，未操作 Studio 应用、未声称已通过其界面验收；真实 AI-03/IMG-02 产物尚待相应里程碑集成。

新增运行时依赖 `@noble/hashes@2.0.1`（MIT）；复用 `fflate@0.8.2`（MIT）。许可证与来源见 `docs/third-party.md`。

## M4-1a：3D 输出、BOM 与模型信息

本轮提供编码器与计算接口，不接入菜单、对话框、IPC、状态栏或视口截图。M4-1b 可以直接复用下列接口；所有输入均不被修改。

| 入口                 | 接口                                                   | 返回                                                     |
| -------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `@brickloop/io`      | `exportObj(doc, context, options?)`                    | `Promise<{ obj, mtl, stats }>`                           |
| 同上                 | `exportDae(doc, context, options?)`                    | `Promise<{ text, stats }>`，返回前使用 XML 解析器检查    |
| 同上                 | `exportGlb(doc, context, options?)`                    | `Promise<{ bytes: Uint8Array, stats }>`                  |
| 同上                 | `aggregateBom(doc, catalog?, options?)`                | `{ rows, summary, issues }`，同步，不要求几何            |
| 同上                 | `exportBomCsv(bom, { language? }?)`                    | `{ text, bytes, byteLength }`                            |
| 同上                 | `calculateModelInfo(doc, context, options?)`           | `Promise<ModelInfo>`                                     |
| 同上                 | `exportUnits`                                          | `mm/cm/ldu` 的 `perLdu` 与 `meter` 换算                  |
| `@brickloop/io/node` | `exportBomXlsx(bom, { thumbnailProvider, language? })` | `Promise<{ bytes, byteLength, issues, thumbnailCount }>` |

编码器返回字符串或字节，文件路径和保存由调用方负责。XLSX 仅在 Node 入口加载 ExcelJS；根入口不导入 Node、ExcelJS 或目录服务。BOM 文案取自现有 i18n 中英资源，`language` 默认为 `zh-CN`，也可传 `en`。报告只返回 `code/messageKey/severity/detail`，界面使用 `t(issue.messageKey)` 展示。

### 目录与几何注入

`OutputCatalog` 接收普通数组：`parts`、`colors`、`factoryParts`、`factoryColors`。它们是 catalog 的 `PartDef`、`ColorDef`、`FactoryPartInfo`、`FactoryColorInfo` 的结构子集，也可直接传数据包的 `parts/colors` 作为工厂表。应传当前启用数据包覆盖后的目录资料；颜色优先取 `factoryColors.measuredRgb`，再取 `ColorDef.rgb`，透明度为 `ColorDef.alpha`（0–1）。

`GeometryContext` 在上述字段之外要求 `meshProvider(partId) → PartMesh | undefined | Promise<…>`。Provider 应从已有网格缓存取数据，需要时调用 `@brickloop/ldraw`；每次导出/计算中同一 PartId 只请求一次。网格使用 LDraw 原始 LDU、Y 向下坐标，编码器自行转换。`PartMesh.batches` 的固定色、直接 RGB 色以及 `main` 继承色均保留。没有颜色映射时回退灰色并报告；缺几何跳过对应形状，但保留件数并报告。Provider 的 I/O 异常向调用方抛出。

```ts
import { exportObj, aggregateBom, calculateModelInfo } from '@brickloop/io';
import { exportBomXlsx } from '@brickloop/io/node';

const context = {
  parts, // 当前目录 PartDef[]
  colors, // 当前目录 ColorDef[]
  factoryParts: pack.parts,
  factoryColors: pack.colors,
  meshProvider: async (partId: string) => meshCache.get(partId),
};
const obj = await exportObj(doc, context, {
  unit: 'mm',
  grouping: 'instance',
  workspace: { hidden: workspace.hidden },
  materialFileName: 'model.mtl',
});
// 在选定输出目录保存 obj.obj 为 model.obj、obj.mtl 为 model.mtl。
// 对话框使用 obj.stats.byteLength / triangleCount 展示结果。

const bom = aggregateBom(doc, context, {
  scope: { kind: 'model', path: workspace.activeModelPath },
});
const xlsx = await exportBomXlsx(bom, {
  language: 'zh-CN',
  thumbnailProvider: async (partId, colorId) => thumbnailCache.getOrGenerate(partId, colorId),
});
const info = await calculateModelInfo(doc, context, {
  lastCheck: { errors: lastCheck.errors.length, warnings: lastCheck.warnings.length },
});
// 模型信息对话框与状态栏都消费 info.dimensions；显示时再四舍五入。
```

示例中的 `parts/colors/pack` 和两个缓存均由 M4-1b 宿主提供。此处 `meshCache` 是以 PartId 查找网格的宿主适配器，不是 LDraw 磁盘缓存原始 SHA-256 键。

### 范围、隐藏状态与坐标

`ScopeOptions.scope` 默认 `{ kind: 'project' }`，支持 `{ kind: 'model', path: InstancePath }` 和 `{ kind: 'selection', paths: InstancePath[] }`。路径始终相对工程根，当前子模型应传 `workspace.activeModelPath`，所选应传 `workspace.selection`。空模型路径表示根；空所选输出空集合；重叠的父/子选择只计算一次。使用完整实例路径，共享定义的两个出现可具有不同隐藏状态与继承色。无效路径、引用环、缺少模型引用抛出 `RangeError`。

3D 默认 `includeHidden: false`；BOM、模型信息默认 `true`。隐藏列表通过 `workspace.hidden` 提供，隐藏父节点会排除全部后代。BOM 工程范围只从根遍历可达实例；未使用的子模型定义不会生成物料数量。

3D 的 `unit` 为 `mm`（默认）、`cm`、`ldu`。使用绕 X 轴 180° 的基变换 `(x,y,z) → (x,-y,-z)`，保持右手坐标；缩放因子分别为 `0.4/0.04/1`。模型信息保留 LDraw 世界包围盒，但宽/深/高分别取 X/Z/Y 轴长度，不受翻轴影响。

### 3D 格式细节

- OBJ：`grouping: 'instance' | 'color'`，默认按实例；对象名为 `<legoNo>_<legoColorId 或 ldrawCode 或 colorId>_<从 1 开始的序号>`，不安全字符替换为下划线。按颜色时每种材质一个对象；固定色面与主色面分别归入对应材质。MTL 使用显示 RGB、`d=alpha`；镜像调整三角形绕序，法线使用逆转置并归一。`materialFileName` 默认 `model.mtl`，必须是无空白、路径分隔符的 `.mtl` basename。
- DAE：COLLADA 1.4.1，`Y_UP`，毫米/厘米/LDU 的 `meter` 分别为 `0.001/0.01/0.0004`，顶点和节点平移同步缩放。同一 `(PartId, ColorId)` 仅写一份 geometry，零件节点用 `instance_geometry`；子模型定义用 `library_nodes` + `instance_node` 复用。不同继承色或隐藏状态形成必要的定义变体。矩阵文本采用 COLLADA 的行主序。`phong` 材质的透明度使用 `A_ONE` + `transparency=alpha`。所有 `name` 编码为合法 NCName；原工程名称保存在 `asset/title`。`createdAt` 可传 ISO 日期，默认固定时间以便确定性比较。
- GLB：glTF 2.0，采用标准共享 `mesh` 加实例 `node`，不使用 `EXT_mesh_gpu_instancing`，普通查看器即可显示。顶点与节点先按所选单位编码，再由根节点缩放到 glTF 规定的米；`asset.extras.sourceUnit` 记录用户选择。塑料 PBR 参数为 `metallicFactor=0`、`roughnessFactor=0.28`；sRGB 显示色转换为线性 `baseColorFactor`，透明色使用 `BLEND`。一般实例用一个节点；剪切变换分解为两个标准 TRS 节点，几何继续共享。支持非均匀缩放、镜像与剪切；奇异矩阵拒绝输出。
- 三种格式支持 `includeEdges`（默认 `false`）：将固定边线变成方形细管网格，`edgeWidthLdu` 默认为 `0.2`（0.08 mm），不依赖查看器的线宽实现。条件边线依赖相机方向，未作永久几何输出，启用边线且源有条件边线时报告 `OUTPUT_CONDITIONAL_EDGES_OMITTED`。

`stats.triangleCount` 是展开实例后绘制的三角形数，包含选中的边线网格；`uniqueTriangleCount` 是共享几何三角形数；`partCount` 是范围内零件出现次数（包含缺几何件）；`meshCount` 是实际写出的零件/颜色组合数。`byteLength` 是 UTF-8 或二进制实际字节数，OBJ 为 OBJ+MTL 合计。`grouping` 仅影响 OBJ；M4-1b 应仅在 OBJ 时启用分组选择，DAE/GLB 保留实例关系。

### BOM 列、计数与缩略图

聚合键为 `(PartId, ColorId)`，子模型展开后每次出现加 1。行按步骤深度优先的首次出现顺序输出。`summary.partTypes` 是不同 PartId 数，`colorCount` 是不同 ColorId 数，`lineCount` 是组合行数，`totalParts` 是展开件数；另有 `unmappedParts/unmappedColors/unmappedRows/unmappedQuantity`，分别表示未映射零件种类、未映射颜色、受影响组合数和受影响件数，不将同一件重复计数。

CSV 为 UTF-8 BOM、CRLF，11 列，不含图片；逗号、引号、换行按 CSV 引用规则转义。可能被 Excel 解释为公式的文字加单引号前缀。XLSX 用 ExcelJS 写出 12 列：序号、图片、乐高编号、工厂编号、零件名称、颜色、工厂色号、颜色中文名、数量、工厂件、工厂可产、分类。编号保留为字符串，工厂编号的前导零不丢失。英文选项切换表头、是/否和零件名称；颜色中文名列仍保留中文。

工厂件依据工厂条目的 `active/pending` 状态；`discontinued` 为非工厂件。可产还要求零件/颜色能映射、存在工厂颜色条目、该颜色在零件允许配色中。非工厂件和不可产组合整行浅红底；未映射行红字，其零件/颜色单元格另用较深红底，不阻止导出。

XLSX 首行冻结、按内容自动估算列宽（上限 60）、图片列宽 10、物料行高 48 pt。末尾第一汇总行 D/F/I 列分别为零件种类数/颜色数/总件数，后一行 B/D/F/H 分别为未映射零件种类/颜色/组合/件数。两行均加粗，自动筛选仅覆盖表头和物料行。

`thumbnailProvider(partId, colorId)` 必填，返回 PNG `Uint8Array`（可异步）；应先读宿主缩略图缓存，缺失时按需生成。每个 BOM 组合调用一次。返回 `undefined`、抛异常或返回无效 PNG 时保留该行数据并在 `issues` 中报告。库不创建渲染器或磁盘缩略图缓存；测试和示例使用自制 1×1 假 PNG。

### 模型信息口径

`calculateModelInfo` 变换实际可绘制顶点与线端点，计算世界坐标范围；排除条件线控制点，不直接变换本地 AABB，以免旋转时夸大尺寸。返回未舍入的 `ldu/mm/cm/inches` 宽深高、`studs.width/depth`、`bricks`、`plates` 和 `includesStuds: true`。换算为宽深 ÷20，高 ÷24 或 ÷8，厘米 ×0.04，英寸 ÷63.5。3001 为 4×2 格、1.1666… 砖、3.2×1.6×1.12 cm。

`directReferences` 是当前模型当前层的直接引用数，零件与子模型引用各算一次；所选范围则为去重后的所选根数。`totalParts` 是展开零件数。`submodelDefinitions/submodelInstances` 是当前范围可达的子模型定义数/展开出现数，排除当前模型本身；`documentSubmodelDefinitions` 单列整个工程中存储的子模型定义总数，包括未使用定义。`partTypes/colorCount` 与 BOM 同口径。`lastCheck` 原样保留调用方提供的错误/警告数，未检查为 `null`。空模型尺寸为零、`boundsLdu: null`；缺几何时保留计数并返回 `geometryComplete: false`，调用方应标明尺寸不完整。

### M4-1a 验证与示例文件

```powershell
node scripts/devenv.mjs pnpm --filter @brickloop/io schema:fetch
node scripts/devenv.mjs pnpm exec vitest run packages/io/test/output-3d.test.ts packages/io/test/output-bom-info.test.ts --reporter=verbose
node scripts/devenv.mjs pnpm --filter @brickloop/io output:fixtures
node scripts/devenv.mjs pnpm verify
node scripts/devenv.mjs pnpm e2e
```

XSD 采用 Khronos 官方 OpenCOLLADA 仓库固定版本。文件头的版权声明没有明确给出宽松再分发授权，因此按主窗口补充指示只下载到 `.devdata/io-schema/`，不纳入仓库。测试缺少 XSD 时只跳过该校验并显示原因；当前任务实际下载并通过正例与反例验证。来源、版权依据和运行方式见 [XSD 夹具说明](test/fixtures/collada/README.md)。GLB 使用 Khronos 官方 `gltf-validator`，检查格式、引用、二进制、材质和变换。

## M7-1a 宏数据 API

接口均由 `@brickloop/io` 导出，实现在 `src/macro/`，可在 Worker 中运行，不读写文件系统。

| API                                                         | 返回与用途                                                                                                                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMacroFromSelection(document, paths, meta, services)` | 返回 `MacroPackage`。`meta` 包含 `id/name/category/author/createdAt`；`name` 支持字符串或语言映射。必传 `services.bboxProvider(partId)` 提供真实局部包围盒，可选 `services.id` 注入 ID 生成器。 |
| `writeMacro(pkg)`                                           | 返回 ZIP `Uint8Array`；无当前时间或随机 ZIP 属性，同一包重复写入字节一致。无效包抛 `MacroError`。                                                                                               |
| `readMacro(bytes)`                                          | 成功为 `{ ok: true, value: MacroPackage, issues: [] }`，失败为 `{ ok: false, issues: IoIssue[] }`；不会返回可插入的损坏部分。                                                                   |
| `macroInsertOps(pkg, document, options?)`                   | 返回 core `Op[]`，调用方一次提交。默认 `as: 'group'`；也支持 `'submodel'`。支持 `transform/stepId/context/name/id`。                                                                            |
| `macroAvailability(pkg, catalogPack)`                       | 返回排序、去重的 `missingParts/missingColors/unavailableColors`。停产件视为缺件；组合不可产与缺件、缺色分别报告。                                                                               |
| `macroName(name, locale?)`                                  | 根据语言选择显示名，默认 `zh-CN`，回退英文及按键排序的第一个语言。                                                                                                                              |

`MacroPackage` 为 `{ meta, document, thumbnail? }`。`meta` 还包含展开后的 `partCount`、唯一 `partIds/colorIds`、宏坐标下的 `bboxLdu` 和 `origin: { convention: 'bbox-bottom-center-grid', gridLdu: [20,8,20] }`。`document` 是完整有效的 core 文档：主模型装选中根实例，仅保留引用到的子模型定义，共享定义只复制一次，子模型内部的步骤、编组与扩展字段保留。重复选择及已选祖先下的子路径不会重复计数；从子模型中单选零件会保留其世界变换与实际继承颜色。选中根实例归入宏主模型的单一步骤。

原点计算使用展开零件真实包围盒的八角点，包含旋转、嵌套变换和凸点。LDraw 的底面为 **maxY**，将底面中心按 x/z 20 LDU、y 8 LDU 四舍五入，减去此坐标得到宏模型。恰好半格时使用 JavaScript `Math.round`（向正方向取整）。原点是放置锚点；非网格内容的底面与原点可相差最多 4 LDU。缺少任何零件包围盒时抛 `MACRO_BOUNDS_MISSING`，不以零件原点代替尺寸。

ZIP 必含 `manifest.json`、`macro.json`、`model.json`，可选 `thumbnail.png`。清单使用 `format: 'brickloop-macro'`、`formatVersion: 1`，`members` 与 `.brkl` 一样逐文件记录字节数和 SHA-256，清单自身不参与哈希。复用现有 ZIP CRC/路径/大小检查及 core 文档规范化序列化。读取拒绝清单错误、缺失/未登记成员、哈希不符、非当前格式版本、无效闭包、与模型不符的数量及零件/颜色清单。包围盒来源于创建时的几何提供器，读文件无需加载几何。

```ts
import { createMacroFromSelection, readMacro, writeMacro, macroInsertOps, macroAvailability } from '@brickloop/io';

const pkg = createMacroFromSelection(
  session.document,
  session.workspace.selection,
  {
    id: macroId,
    name: { 'zh-CN': '桌子', en: 'Table' },
    category: 'furniture',
    author: authorName,
    createdAt: new Date().toISOString(),
  },
  { bboxProvider: (partId) => meshes.get(partId)?.bboxLdu },
);
const bytes = writeMacro(pkg); // 交给主进程持久化。
const loaded = readMacro(bytes);
if (loaded.ok) {
  const availability = macroAvailability(loaded.value, activePack);
  // 界面展示 availability；允许用户保留目录外零件，由检查面板继续报告。
  const ops = macroInsertOps(loaded.value, session.document, {
    as: 'group',
    context: session.context,
    transform: placementLDraw12,
    stepId: activeStepId,
    name: localizedMacroName,
  });
  const result = session.applyExternal(ops, t('macro.insert'), 'ui');
  // 检查 result.ok；一次 undo/redo 同时处理实例、子模型和编组。
}
```

`transform` 为 **12 数 LDraw 变换**，相对于 `context.activeModelPath` 的目标模型；默认单位变换。`stepId` 优先于 `context.stepId`，未指定时使用目标模型第一步。编组方式仅将宏主模型的根实例放入目标模型，并添加外层编组；嵌套子模型仍为引用，原编组置于外层编组内。子模型方式复制整个闭包，添加一个根引用。每次插入均分配新 ID，避免宏重复插入、插回源文档和共享关系的冲突。子模型名通过 core 自动加 ` (2)` 等后缀。函数不修改输入文档、宏包或 context；其返回 ops 应以生成时的文档为基准立即应用。

宏错误通过 `MacroError.issues` 或读取结果的 `issues` 携带 `code/messageKey/severity/file/detail`；宏文案键为 `macro.errors.*`，ZIP 错误继续使用现有 `io.*`，core 参数错误使用现有 `core.errors.*`。内置分类文案为 `macro.categories.*`，自定义分类字符串也可持久化。

M7-1b 需要加载 `library/macros/builtin/index.json`、按需读文件、提供 bbox、当前编辑 context/步骤和放置矩阵，再提交单一事务。内置包没有缩略图；离屏渲染和缓存、用户宏目录与桌面菜单仍由桌面任务实现。宏中的内嵌零件引用会随闭包保留；此版本不打包自制零件几何文件，跨机器使用自制件仍需要相应目录/数据包。

内置宏尺寸、规则与重建方式见 [library/macros/README.md](../../library/macros/README.md)。验收命令：

```powershell
node scripts/devenv.mjs pnpm macros:build --check
node scripts/devenv.mjs pnpm exec vitest run packages/io/test/macro.test.ts packages/io/test/macro-builtin.test.ts
```

`packages/io/out/m4-1a/` 生成 `model.obj/model.mtl/model.dae/model.glb/bom.csv/bom.xlsx/report.json`。目录已被现有 `out/` 规则忽略；有官方库时读取真实 3001，否则使用本包自制盒体。几何来源与假缩略图会写入报告。实际 LDraw 几何的许可与署名继续遵循 `docs/third-party.md`，示例文件仅用于本地验收。Node 集成测试写出并回读非空 OBJ/MTL/XLSX，结束后清理临时目录。对话框截图和经菜单触发的端到端验收留给 M4-1b，现有 E2E 只作为回归检查。
