# @brickloop/connect

连接器 JSON、LDraw 图元推断、兼容规则、吸附约束与世界空间连接图。运行时只依赖工作区的 `@brickloop/core` 和 `@brickloop/ldraw`，使用 ES2022 TypeScript，无 DOM、Node、three.js 依赖，可在 Worker 中运行。Node 文件读取、数据包读取与生成仅位于 `scripts/` 和测试中。

## 公开接口

所有接口从 `@brickloop/connect` 导入。完整类型见 `src/types.ts` 和各模块的导出定义。

| 接口                                                                            | 行为                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseConnectorFile(json: unknown, fileName?)`                                  | 接受文本或对象；返回 `{ file: ConnectorFile \| null, issues }`。问题携带 JSON 字段路径和可选文件名；坏数据不会变成空连接器文件。                                                            |
| `readConnectorFile(fileName, read)`                                             | 注入异步文本读取器；文件缺失、读取失败、JSON 或结构错误抛 `ConnectorDataError`。                                                                                                            |
| `writeConnectorFile(file)`                                                      | 校验后输出 JSON；错误抛 `ConnectorDataError`。                                                                                                                                              |
| `cloneConnector(c)`、`transformConnector(c, matrix)`                            | 深复制语义字段，变换 frame、长度、直径与限位距离。刚体变换保留标量原值；镜像网格重新排列行以保持几何位置。                                                                                  |
| `connectorCells(c)`、`instantiateConnectors(instance)`                          | 展开有效网格单元并应用实例矩阵；世界项保留 `ConnectorRef` 与完整连接参数。                                                                                                                  |
| `isCompatible(a, b, rules?)`                                                    | 返回 `{ ok, reason }`，原因区分类型、直径、尺寸、角色、标签与凸点深度。规则对称。                                                                                                           |
| `DEFAULT_RULES`、`DEFAULT_PRIMITIVE_MAP`、`parsePrimitiveMap(json)`             | 内置数据来自 `library/connectors/`；图元表在加载时校验。P3 类型可存储，当前规则不开放配对。                                                                                                 |
| `inferConnectors(partFile, resolver, options?)`                                 | `partFile` 可为文件名或已解析的 `LDrawFile`；resolver 使用 ldraw 的 `resolve` 接口。返回 `Promise<ConnectorFile>`，状态始终为 inferred。缺引用、环、深度超限或解析警告抛 `InferenceError`。 |
| `ConnectorIndex`                                                                | 默认 10 LDU 分桶；`set`、`delete`、`entriesOf`、`paths`、`query`、`querySegment`。长连接器沿有效长度进入多个桶。                                                                            |
| `solveSnap(request)`                                                            | 返回候选、选中项、拒绝原因；每项包含主选件矩阵、整组选中件矩阵、差分矩阵、约束残差、排名依据和碰撞状态。                                                                                    |
| `DEFAULT_SNAP_CONFIG`、`insertionRange`、`slideOffset`、`solveRotation`         | 可配置的搜索、捕获、排序与线性/角度约束辅助接口。                                                                                                                                           |
| `snapSelectionToGrid(selection, step?)`、`snapInParent(candidate, parentWorld)` | 整组网格放置与父空间矩阵转换。                                                                                                                                                              |
| `ConnectionGraph`                                                               | `update(changedPaths)`、`edgesOf(path)`、`components()`、`connectedTo(path)`、`isOccupied`、`index`。                                                                                       |
| `documentConnectorSource(getDocument, getConnectors)`                           | core 文档适配器；初次使用 `expandInstances`，提交后只重新计算受影响子树的世界矩阵，并更新共享定义的所有访问路径。                                                                           |

`Connector`、`ConnectorFile`、`ConnectorIssue`、`Frame`、`ConnectorRef`、`ConnectorInstance`、`WorldConnector`、`SnapRequest`、`SnapPointer`、`SnapResult`、`SnapCandidate`、`SnapConfig`、`ConnectionEdge`、`GraphSource`、`GraphOptions`、`PrimitiveMap`、`InferenceOptions`、`ConnectorRules` 等类型亦公开导出。

## 坐标和数据约定

- 使用 LDraw 局部坐标与 LDU，保留 -Y 向上。`worldMatrix`、候选的 `transform`、`delta` 均为**列主序 4×4**，与 core 内存矩阵一致。候选用普通 `number[]` 便于 Worker 消息传递；写回 core 文档时先转父空间，再用 `toLDraw` 转为 12 数数组。
- frame.axis 指向对接零件一侧。杆/轴/销的有效段是 `origin + axis × [0,length]`；孔的有效段是 `origin - axis × [0,length]`。孔的 `start` 在入口，`end` 在内部终点；`stops` 为从 origin 向有效段内量取的距离。杆的起端封闭/肩部阻止孔口越过杆根，孔内部封闭/限位阻止杆尖穿过。
- 空心凸点的外部连接平面保持在凸点基面；接 Bar 时孔口位于基面沿 axis 前移 4 LDU 的凸点顶部。内部与外部占用独立记录。
- 网格列沿 ref。stud 系列的行沿 `axis × ref`，antistud 系列的行沿 `ref × axis`，与规格中的顶/底面原点一致。`mask` 为 `null` 或 `rows × cols` 布尔数组，`true` 表示有单元；`cells.tube` 为底管单元语义标记。推断数据另保留真实半格位置的 `antistud.tube`，供 Bar 与底管中心匹配。
- `transformConnector` 适用于刚体、镜像及保持 frame 正交的缩放；单一 pitch 的网格不表达非均匀平面缩放或剪切。实例化从原始局部单元逐个变换，镜像不会把格点移到另一侧。
- JSON 不接受未知字段、重复 ID、非有限数值、不正交 frame、非法网格或越界 cells/stops。所有语义字段在复制、序列化和实例化后保留。普通空数组仅表示推断尚未识别到连接器，与读文件失败明确区分。

## 吸附使用

```ts
import { ConnectionGraph, documentConnectorSource, solveSnap } from '@brickloop/connect';

const graph = new ConnectionGraph(documentConnectorSource(() => currentDocument, connectorsForPart));

// 在文档提交后调用；删除的旧路径也必须传入。
graph.update(changedPaths);

const result = solveSnap({
  selection: selectedInstances, // 每项为 { path, worldMatrix, connectors }
  primaryPath,
  index: graph.index,
  pointer: { screen: [mouseX, mouseY], viewProjection, viewport: [width, height] },
  previous: lastChosen,
  isOccupied: graph.isOccupied,
});
```

鼠标输入也可使用 `{ ray: { origin, direction }, worldUnitsPerPixel }`。省略鼠标输入时屏幕距离为零，适用于 AI/离线世界空间求解。`viewProjection` 使用 NDC z ∈ [-1, 1]，输入屏幕坐标以视口左上角为原点，单位为像素。长线段先裁剪近/远平面再投影，射线模式只接受射线前方候选。

| 默认配置         |    数值 |
| ---------------- | ------: |
| 屏幕候选半径     |   32 px |
| 世界宽相搜索半径 |  24 LDU |
| 最终位移捕获距离 |  12 LDU |
| 轴向捕获角度     |     35° |
| 线性吸附步长     |  10 LDU |
| 网格重叠判定容差 | 0.5 LDU |
| 上帧候选滞后分值 |    0.12 |

各阶段阈值独立。候选先做类型与占用检查，再反向对齐轴、量化绕轴转角、求插入区间。球保持原姿态，只平移球心，`limits` 检查相对轴的倾角；铰链的 `limits` 检查绕轴相对 ref 的角度。十字轴配十字孔按 90°，配销孔可自由旋转。两侧数值 rotation 步长取共同角度格，避免只满足一侧约束。

排序分值为 `screenWeight × screen / screenRadius + displacementWeight × displacement / captureDistance + rotationWeight × degrees / 180 - overlapBonus × overlap`，默认权重为 1、0.5、0.15、0.04。同分按路径、目标连接器/单元、源连接器/单元排序，避免依赖桶遍历顺序。上一候选仍合法且与最优项差距不大于 hysteresis 时继续使用它。允许网格部分重叠；任何实际重叠单元被占用时拒绝该方案。

`continuous: true` 对应 Shift 连续滑动，仍受端部和限位约束。`enabled: false` 返回空候选与 `gridTransforms`，整组按 `gridStep`（默认 20）放置。多选只用主选件产生源连接器，整个选择共用同一差分矩阵。

拒绝原因仅针对宽相检索到的对象；远处对象不为解释目的遍历全场景。`collision` 始终为 `unknown`，M3-2 可在此结构上填入真实碰撞结果。当前没有实际鼠标交互体验调参，默认值是本项目初值。

## 连接图和增量边界

图默认以位置误差 ≤ 0.5 LDU、方向/离散转角误差 ≤ 1° 判断接合；线性连接比较横向误差、轴向有效区间和端部约束。球只要求球心接近并满足可选角限。`connectedTo` 包含起点自身；`components` 包含没有连接器的孤立实例。

普通 `GraphSource.instances()` 提供当前完整实例快照；图只替换 changedPaths 及包含相同共享实例 ID 的项。`update` 返回实际更新/移除实例数，`[]` 为无操作，`[[]]` 请求全量重建。core 使用全局唯一实例 ID；自定义来源也应遵守此约定。

`documentConnectorSource` 保留未受影响的世界矩阵。它维护模型定义的访问路径，能处理共享空模型的新增子件、删除件和祖先变换。每次更新仍需枚举模型引用关系与筛选实例快照；连接器实例化、分桶和边求交只针对变化子树。改变连接器定义时，调用方需将所有受影响零件路径加入 changedPaths。连接器提供器读取失败应抛异常，不能返回空数组掩盖失败。

## 推断与人工补写

```powershell
node scripts/devenv.mjs pnpm connect:infer --pack demo
```

图元映射表在 `library/connectors/primitive-map.json`。推断器递归累计 LDraw 变换，识别图元后不再重复识别它的子图元；仍读取底层几何以计算轮廓。矩形砖/板/平滑板从开口底腔推断底面网格，1×N 内部实心小柱为 bar.post。共线且连续的同类杆/销段合并，例如 6558 的长销侧合并为 40 LDU。无专用图元的简单圆柱 Bar 以轮廓尺寸识别。

脚本读取实际 demo 数据包，追加任务指定的旧编号/包外验收件。对已有 draft/reviewed 文件按字节保留；坏文件报告具体路径并使脚本失败；未识别零件写 inferred 空数组并列入统计。脚本内复用已有 Prettier 生成稳定格式，不新增第三方依赖。缓存仅与 resolver 同寿命；库内容改变后应新建 resolver。

当前包内 222 件全部有文件，另有 9 个包外验收编号；共 231 份零件 JSON。包内 216 inferred、6 draft；含验收编号总计 221 inferred、10 draft。34 份文件仍未识别到连接器，其余文件也可能仅覆盖部分连接。逐件类型、数量、原始推断与最终保存结果均见 [生成统计](../../library/connectors/README.md)。

| 人工 draft  | 补写内容                                |
| ----------- | --------------------------------------- |
| 2412、2412b | 格栅板由显式面构成的 1×2 底面凹位       |
| 15712       | 顶部夹子的 z 轴夹持段，保留原有底面凹位 |
| 3700        | Technic 砖的 1×2 底面凹位               |
| 14418       | 球窝板不使用 box5 图元的 1×2 底面凹位   |
| 3626、3626c | 人仔头的专用颈部配对位置                |
| 973         | 颈部、髋部和左右肩部接口                |
| 970、3815b  | 髋部与躯干、左右腿的专用配对位置        |

上述 draft 均来自 LDraw 几何坐标与本项目自定配对标签，未经过人工标注界面审核。当前库中 14417 是球头、14418 是球窝；按 DAT 几何处理。32523 的三个通孔保留六个入口，两个方向均可作为吸附目标。人仔接口的活动自由度仍需后续旋转工具细化。

## 校验与性能

```powershell
node scripts/devenv.mjs pnpm verify
node scripts/devenv.mjs pnpm exec vitest run packages/connect/test/performance.test.ts --reporter=verbose --silent=false
```

测试覆盖 CON-01–CON-12 的逻辑行为、常见件逐项类型/位置断言、镜像网格、部分重叠、共享定义修改/新增/删除、连续滑动与端部限制、数据文件覆盖率、draft/reviewed 保留和坏文件失败。CON-06 同时通过 core 的复制、子模型展开与文档序列化验证语义字段；UI 操作和真实碰撞属于后续任务。

性能测试构造 1,000 个 3001 实例，每件 19 个有效连接项，共 19,000 项。记录 solveSnap 冷调用、5 次预热后 30 次中位数/p95，以及更新 10 个实例的耗时；同时检查其余索引项对象保持不变。运行输出见 `performance.txt`，完整工作区验收输出见 `verification.txt`。不使用机器速度相关的硬断言，目标为单次 solveSnap ≤ 8 ms。

源码与测试文件清单见 `FILES.txt`。本次配套修改仅根目录 `package.json`、`pnpm-lock.yaml` 与追加第三方来源说明；未修改 apps、其他 packages、tools、规格或任务文档。未创建 git commit。
