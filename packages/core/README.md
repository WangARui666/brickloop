# @brickloop/core

编辑器的文档、数学、命令、事务和序列化核心。源码只使用 ES2022 TypeScript；没有运行时依赖，也不使用 DOM、Node 专有 API 或 three.js。UI、文件读写、连接求解和渲染由调用方负责。

## 入口与公开接口

所有类型与主要函数可从 `@brickloop/core` 导入，也提供以下子路径：

| 入口                        | 主要接口                                                                                                                                                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@brickloop/core/math`      | `Vec3`、`Matrix4`、`identity`、`fromLDraw`、`toLDraw`、`multiply`、`invert`、`determinant`、`translation`、`rotationAxisAngle`、`rotateAboutPivot`、`transformPoint`、`transformDirection`、`normalizeForSave`、`snapToGrid`                                                                                    |
| `@brickloop/core/document`  | 文档/模型/实例/步骤/编组/工作区/编辑上下文类型；`createUlidGenerator`、`ulid`、`isUlid`、`createDocument`、`createModel`、`createWorkspace`、`updateWorkspace`、`validateDocument`、`resolvePath`、`resolveContext`、`worldMatrix`、`expandInstances`、`wouldCreateCycle`、`orderedInstances`、`pathStartsWith` |
| `@brickloop/core/ops`       | `Op` 及各项参数类型；`apply`、`invert`、`applyOps`、`applyWithInverse`                                                                                                                                                                                                                                          |
| `@brickloop/core/commands`  | `Command`、`CommandOutput`、`CommandServices`、`BBox`、`RotationPivot`；`executeCommand`、`resolveClickSelection`、`isContextCurrent`；上下文辅助函数 `contextModel`、`selectedInstances`、`groupAncestors`、`commonGroup`                                                                                      |
| `@brickloop/core/clipboard` | `ClipboardData`、`ClipboardItem`、`Placement`；`copySelection`、`pasteInto`、`tryCopySelection`、`tryPasteInto`                                                                                                                                                                                                 |
| `@brickloop/core/history`   | `Transaction`、`SessionChange`、`SessionOptions`、`DispatchOutput`、`DocumentSession`                                                                                                                                                                                                                           |
| `@brickloop/core/serialize` | `serializeDocument`、`parseDocument`、`ParseResult`                                                                                                                                                                                                                                                             |
| 根入口                      | 以上接口；`Result`、`CommandError`、`ErrorCode`、`CoreError`、`coreErrorMessagesZh`；原有单位常量与 `toLdu` / `fromLdu`                                                                                                                                                                                         |

数学与操作原语都要求名为 `invert` 的接口，因此根入口将矩阵求逆导出为 `invert`，操作求逆导出为 `invertOp`，并导出 `ops` 命名空间。子路径 `@brickloop/core/ops` 保持 `invert(op, docBefore)` 原名。

## 文档与数学约定

- 内存计算使用列主序 `Float64Array(16)`；文档的 `Instance.transform`、剪贴板的 `worldMatrix` 使用 LDraw 顺序的 12 数普通数组，可直接写入 JSON。`multiply(parent, child)` 表示先应用子变换，再应用父变换。
- `createDocument(meta, { id?, now?, catalogPack? })` 生成一个主模型和一个空步骤。`createUlidGenerator({ clock?, random? })` 可注入毫秒时钟和返回 `[0, 1)` 的随机函数；同一生成器在同毫秒和时钟回退时仍单调递增。默认随机源为 `Math.random`，ID 不承担安全凭据用途。
- 实体中已知字段有明确类型，未知字段由 `unknown` 索引保留。`extensions` 与未知 JSON 字段不会被重命名、展开或归一化。`EmbeddedPartRef` / `RefImage` 最少记录 `hash`，其他资源元数据由 IO/目录适配器持有。
- `validateDocument(unknown)` 返回带 `code`、`messageKey`、`path`、`severity` 的问题数组。它校验运行时结构、标识符、步骤双向归属、引用存在性和环、编组所属模型及父组、主模型入口等。目录中没有的合法 PartId / ColorId 仍被接受。
- `resolvePath` 返回包含该实例的定义、实例本身、父矩阵和世界矩阵；找不到时返回 `undefined`。`worldMatrix(doc, [])` 为单位矩阵。上下文路径必须指向模型实例。
- `expandInstances` 每行表示一个实际零件出现，按步骤/成员顺序深度优先展开，提供完整路径、实际颜色与世界矩阵。`multiplicity = 1` 可直接求和；`definitionMultiplicity` 表示同一定义内这个实例在本次展开中出现的次数。根层没有父颜色时，`inherit` 解析为 `ld:16`；可用第三个参数指定根继承色。传入 `modelId` 时路径和矩阵相对于该模型。遇到坏引用或环会抛异常；读入文件应先检查 `parseDocument` 的问题列表。
- 保存时平移保留 4 位小数，旋转元素吸附到规定的常见值；`||det|-1| < 1e-6` 且正交误差超过 `1e-12` 时用极分解正交化，保留镜像符号。已经正交的矩阵不重复扰动，因此规范化 JSON 可形成稳定往返。

## 命令

`executeCommand(doc, context, command, services?)` 返回 `Result<CommandOutput>`。成功结果包含 `ops`，剪切可返回 `clipboard`，添加/粘贴等命令可返回建议的 `selection`。执行失败返回结构化错误，文档不变。

所有编辑命令均已实现：

| 类别   | 命令                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 零件   | `part.add`                                                                                              |
| 变换   | `transform.translate`、`transform.rotate`、`transform.set`、`transform.snapToGrid`                      |
| 颜色   | `color.set`、`color.replace`                                                                            |
| 编辑   | `edit.delete`、`edit.cut`、`edit.paste`、`edit.clone`                                                   |
| 编组   | `group.create`、`group.dissolve`、`group.rename`                                                        |
| 子模型 | `submodel.create`、`submodel.instantiate`、`submodel.makeUnique`、`submodel.explode`、`submodel.rename` |
| 步骤   | `step.add`、`step.remove`、`step.move`、`step.assign`                                                   |

命令以 `type` 区分。可指定 `label`、`source`、`input` 和 `mergeKey`。带 `paths` 的命令默认使用 `context.selection`，每条路径必须直接属于当前 `activeModelPath`，不能通过另一个共享出现绕过编辑上下文。`primaryPath` 默认取选择列表末项。

旋转 `pivot` 为 `{ kind: 'selectionCenter', point }`、`{ kind: 'primaryOrigin' }` 或 `{ kind: 'point', point }`。点坐标均为世界坐标；选择中心由调用方计算。平移与旋转可指定 `space: 'world' | 'primaryLocal'`。变换先在世界空间计算，再通过上下文逆矩阵写回定义局部空间。

`transform.set` 将主选件设置为目标矩阵，并把同一个差分变换应用于其他选中件；默认目标位于世界坐标，`space: 'context'` 表示上下文局部坐标。`transform.snapToGrid` 支持单一步长或 `[x, y, z]` 步长及可选网格原点，取整规则与 `Math.round` 一致。

`resolveClickSelection` 把深层命中路径截断到当前模型上下文，在组外展开最外层组成员，在逐级进入的组内按下一层组或单件选择。Ctrl 切换整个命中集合，Shift 追加，Alt 直接选件；隐藏路径不能被点选。进入/退出编辑状态由调用方更新工作区。

`submodel.create` 需要 `services.bboxProvider(partId)` 返回零件局部包围盒 `[minX, minY, minZ, maxX, maxY, maxZ]`。递归考虑所选实例的变换，在当前模型坐标中取包围盒底面中心（LDraw 的底面为 `maxY`），三个坐标对齐 20 LDU。移动件保留实例 ID；步骤描述、组层级和未知字段随内容保留。

`submodel.makeUnique` 递归复制用户模型定义图；同一源定义在每个独立副本中只复制一次，内部共享仍保留。多个选中子模型分别解除共享。`submodel.explode` 展开一层，内部子模型仍可继续展开；内部实例变换与父变换相乘，继承色显式解析，目标父步骤保持成员顺序。删除最后一个引用后，定义仍保留为未使用定义。

`step.remove` 把原成员追加到 `targetStepId`，默认选择前一步（删除第一步时选择下一步）；不能删除唯一剩余步骤。`step.assign` 的 `position` 是移除本批成员后再插入的起始位置。

## 事务与工作区

```ts
import { createDocument, DocumentSession, executeCommand } from '@brickloop/core';

const session = new DocumentSession(createDocument({ title: '示例' }));
const added = session.dispatch({ type: 'part.add', partId: 'ld:3001', colorId: 'c:bright-red' });
if (!added.ok) throw new Error(added.error.messageKey);

session.begin('拖动零件', 'ui');
// 每一帧都以 transactionBase 计算从手势起点累计的位移。
const candidate = executeCommand(session.transactionBase, session.context, {
  type: 'transform.translate',
  delta: [20, 0, 0],
});
if (candidate.ok) session.preview(candidate.value.ops);
session.commit(); // 或 session.cancel()
session.undo();
session.redo();
```

`DocumentSession` 提供：

- `document`、`transactionBase`、`workspace`、`context`、`history`、`redoHistory`、`savedRevision`、`isDirty`、`isPreviewing`、`canUndo`、`canRedo`。
- `begin(label, source)`、`preview(ops)`、`commit()`、`cancel()`、`dispatch(command, context?)`、`undo()`、`redo()`、`markSaved()`。
- `onChange(listener)` 返回退订函数。`setContext`、`updateWorkspace` 不产生文档历史。工具切换调用 `endMerge()`。
- `applyExternal(ops, label, source?)` 为已有操作原语的导入/外部适配器提交一次事务，并先取消 UI 候选状态。

除 `cancel`、工作区更新和订阅外，可能失败的方法返回 `Result`，调用方应检查 `ok`。`new DocumentSession` 对无效初始文档抛 `CoreError`。

`preview` 替换上一帧候选，以 `transactionBase` 为基准，不追加帧数、不修改 revision、不发提交事件。候选期间 `isDirty` 反映尚未提交的修改；取消恢复原始文档对象、revision、dirty、撤销和重做栈。调用方可在每帧读取 `document` 更新画面。

UI 预览期间收到独立 `dispatch` / `applyExternal` 会先取消预览，再应用命令。切换选择或编辑路径也取消预览。提交前再次验证编辑路径仍指向原模型定义，防止共享编辑改写到另一个出现。

AI/外部整轮修改使用 `begin(label, 'ai' | 'mcp' | 'import')`，期间的 `dispatch` 累积到同一候选事务，`commit()` 后一次撤销全部恢复。也可用 `preview` 提交从事务基准计算出的完整操作列表。一次性命令的来源可设置 `command.source`。

默认仅 `input: 'keyboard'` 的 `transform.*` 命令参与连续按键合并。同选择顺序、主选件、上下文、坐标系、命令类型和 `mergeKey`，且相邻间隔不超过 1,000 ms 时共用一项撤销历史。`mergeKeyboard: false` 关闭，`mergeIntervalMs` 可调整间隔。其他命令、保存、撤销、重做、选择/上下文变化和 `endMerge()` 都结束合并。按钮和数值输入不自动合并。

历史默认上限 1,000 项，可用 `historyLimit` 配置。revision 是会话内不复用的提交状态编号；撤销/重做回到原编号，分支编辑使用高于此前所有提交的编号，避免与旧保存点碰撞。保存会结束按键合并，撤销/重做到 `savedRevision` 时 dirty 自动清除。预览期间不能 `markSaved`。

提交事件结构为 `{ type: 'tx' | 'undo' | 'redo', transaction, ops, revisionBefore, revisionAfter }`。每次实际提交发送本次正向 ops；键盘合并只影响撤销列表，不重复发送之前已提交的操作。撤销事件的 `ops` 是实际逆操作，重做为正向操作。日志订阅者按事件顺序应用 `ops`，再设置 `revisionAfter`，即可重放文档。监听器异常可通过 `onListenerError` 接收，不撤回已经提交的修改。

操作原语自身不分配 revision。全部集合操作使用 `items`；`instance.update` 的一项表示 `{ modelId, instanceId, changes, unset?, position? }`，可一次更新大量实例。`apply` 不修改输入，未改动的模型、实例、步骤、资源保持结构共享；事务边界统一校验不变式，允许复杂命令的中间原语短暂分离步骤和实例。调用方应把文档、ops 与返回的历史记录视为不可变值，不直接修改它们。

## 剪贴板与序列化

`copySelection` 去掉重复和被已选祖先覆盖的路径，记录实例、世界矩阵、继承后的颜色、所引用模型定义闭包、关联编组和内嵌零件引用。`ClipboardData` 是普通 JSON。复制时保留不可变文档的快照引用，后续命令不会改变剪贴板内容。

`pasteInto(doc, context, clipboard, placement?, id?)` 返回 ops；无效输入抛 `CoreError`，`tryPasteInto` / `tryCopySelection` 提供 `Result` 形式。同文档粘贴复用原定义并检查环；跨文档为每个定义生成一份新定义，名称冲突追加 `(2)` 等后缀。源实例来自同一共享组的不同出现时，会在目标中形成不同的组。内嵌 PartId 已存在且内容哈希不同时返回错误，避免覆盖目标文档资源。

`placement.offset` 为世界坐标增量；`placement.position` 把锚点移到指定世界坐标，两者互斥。默认锚点是首个复制实例的原点，可用 `placement.anchor` 覆盖；`placement.stepId` 指定目标步骤。粘贴会通过目标上下文的逆矩阵写回局部姿态。

`serializeDocument` 按键名字典序生成紧凑 JSON，保留具有语义的数组顺序，只规整已知实例的矩阵。未知字段必须是 JSON 值；函数、`undefined`、循环对象等不会被静默丢弃。

`parseDocument` 返回 `{ doc, issues }`；JSON 或结构/不变式错误时 `doc: null`。高于当前版本的文档保留版本号并返回 `READ_ONLY_NEWER` 警告，若已知结构仍合法则可读取；Session 拒绝编辑该文档。工作区不包含在该序列化接口中，可独立写入 `workspace.json`。

## 验证与文件布局

从仓库根目录运行，统一通过开发环境入口：

```powershell
node scripts/devenv.mjs pnpm verify
node scripts/devenv.mjs pnpm exec vitest run packages/core/test/performance.test.ts --reporter=verbose --silent=false
```

测试覆盖 CMD-01–CMD-08、GRP-01–GRP-04、MOD-01–MOD-07、P01/P05、每条不变式的反例、所有原语的正逆往返、结构共享和矩阵计算。夹具及规范化前后状态断言位于 `test/fixtures.ts` 和对应测试文件；无需外部零件库。第五条不变式规定未知目录 ID 仍有效，因此用接受用例验证，没有把缺失目录项当作文档错误。

`test/performance.test.ts` 在 10,000 实例上输出展开、平移 1,000 件及撤销的墙钟耗时，并验证批量原语和完整撤销。计时包含命令生成、校验和历史维护，不设依赖机器速度的硬阈值。完整工作区验证输出见 `verification.txt`，单独的性能运行输出见 `performance.txt`。

源码按 `src/math`、`document`、`ops`、`commands`、`clipboard`、`history`、`serialize` 分层，`src/errors.ts` 提供结构化错误和中文默认文案，`src/index.ts` 汇总导出。新增测试为 `commands`、`document`、`history`、`math`、`ops`、`performance`、`serialize`、`submodels-clipboard` 八个测试文件及公共 `fixtures.ts`；原有 `units` 保留。

没有新增第三方依赖或许可。测试继续使用工作区已有 Vitest（MIT），TypeScript strict 检查继续使用已有工具链。后续 UI 应把 `core.errors.*` 的中文默认文案和校验问题键接入正式 i18n；资源读取、系统剪贴板、恢复日志落盘、渲染和文件 IO 仍由各适配器实现。
