# @brickloop/collide

M3-2 的碰撞代理、三态碰撞查询和模型检查。根入口是纯 TypeScript，使用 ES2022 / Worker API；不依赖 DOM、Electron、three.js、`@brickloop/connect` 或 Node 模块。`/node` 入口单独提供磁盘缓存和人工文件读取。源码通过 strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 及独立 Worker 类型检查，没有 `any`。

## 接入与公开接口

| 入口                      | 接口                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@brickloop/collide`      | `buildCollider(partFile, resolver, mesh, options?)`、`colliderFileName(partId)`、`partIdForFile(file)`                                                                                                                                                                                                                                                        |
| 同上                      | `parseColliderOverride(value, partId?)`、`isCollider(value)`、`isColliderShape(value)`                                                                                                                                                                                                                                                                        |
| 同上                      | `intersectShapes(a, b)`、`CollisionWorld`、`pathKey(path)`                                                                                                                                                                                                                                                                                                    |
| 同上                      | `runChecks(doc, ctx, options?)`、`check.run`、`issueMessagesZh`                                                                                                                                                                                                                                                                                               |
| 同上                      | `GENERATOR_VERSION`、`IDENTITY_ROTATION`；`ColliderShape`、`Collider`、`ColliderOverride`、`ColliderBuildOptions`、`CollisionStatus`、`CollisionPair`、`CollisionResult`、`CollisionInstance`、`CollisionPreview`、`QueryOptions`、`CollisionWorldOptions`、`CheckContext`、`CheckOptions`、`Issue`、`IssueKind`、`UnknownReason`、`Vec3`、`Rotation`、`Aabb` |
| `@brickloop/collide/node` | `createOverrideLoader(directory)`、`createColliderCache(directory)`、`hashMesh(mesh)`、`ColliderCache`                                                                                                                                                                                                                                                        |

以下示例从仓库根目录运行，路径均相对于仓库根目录。

```ts
import { buildPartMesh } from '@brickloop/ldraw';
import { createLibraryResolver } from '@brickloop/ldraw/node';
import { expandInstances } from '@brickloop/core';
import { CollisionWorld, runChecks } from '@brickloop/collide';
import { createColliderCache, createOverrideLoader } from '@brickloop/collide/node';

const resolver = createLibraryResolver({ libraryDir: 'library/ldraw' });
const mesh = await buildPartMesh('3001.dat', resolver);
const cache = createColliderCache('.devdata/cache/colliders');
const { collider } = await cache.build('3001.dat', resolver, mesh, {
  loadOverride: createOverrideLoader('library/colliders'),
});

// Example: a document whose parts are all 3001. For mixed parts, look up each PartId.
const world = new CollisionWorld({
  instances: expandInstances(doc).map((row) => ({
    path: row.path,
    transform: row.worldMatrix,
    collider,
  })),
});
const preview = world.query({ shapes: worldSpacePreviewShapes, excludePaths: draggedPaths }, { budgetMs: 4 });
const issues = runChecks(doc, { catalog: catalogService, collisionWorld: world }, { collisionEnabled: true });
```

Worker 中由宿主注入 `loadOverride(partId)`（例如读取内存 Map 或通过消息获取 JSON）；不提供时直接生成自动代理。人工数据存在时优先于自动生成与包围盒回退。文件读取错误、非法 schema/版本/基本体会抛出错误，避免悄悄忽略错误的人工文件。

## 代理与文件约定

坐标为 LDU，保持 LDraw 的 -Y 向上。`center`、`halfSize`、`axis` 为三个数；盒的 `rotation` 为列主序 3×3 正交矩阵，允许镜像；圆柱的 `axis` 必须是单位向量。AABB 为 `[minX, minY, minZ, maxX, maxY, maxZ]`。实例 `transform` 使用 core 的列主序 `Float64Array(16)`，文档里的 12 数变换需先 `fromLDraw`。

生成过程：

1. 通过 resolver 与 `parseLDraw` 展开引用，累计实例变换，识别 `stud.dat`、`stud2.dat`、`stud2a.dat`、`stud4.dat`、完整 `4-4cyli.dat` 及 `axlehol*.dat` 的实体圆柱或轴心。
2. 空心凸点和底管拆为沿管壁分布的小圆柱，保留中空区域。十字轴保留内接圆柱轴心，其余十字臂由体素盒覆盖。通用圆柱还用实际网格采样，排除孔内壁和不完整圆柱。
3. 对展开网格做有向扫描线实体采样。默认 2 LDU 体素，检查内缩后的八角及中心，避免把孔填实；按 X/Y/Z 顺序合并相邻体素成盒。圆柱和最终合并盒表面内缩 0.5 LDU。
4. 缺几何、引用环、深度限制、开放表面、空体素或超出体素上限时，用原几何包围盒内缩并标记 `approximate: true`。完全没有有效体积时保留空代理，查询返回 `unknown`。

可配置 `resolution`、`inset`、`maxVoxels`（默认 2,000,000）、`maxDepth`（默认 64）、`highResPrimitives` 与 `partId`。`resolution` 必须大于 `2 * inset`，否则单体素内缩后没有体积。宿主应使用与网格一致的图元精度设置，并把 `cu:` 自制件 ID 显式传入 `partId`。自动代理是离散实体表示，小于分辨率的细节仍需人工代理；验收覆盖列出的实际配对，不等于所有零件配对都已审核。

人工文件有 `schema: 1`、递增的 `version`、`partId`、`approximate`、`shapes` 和可选 `notes`。形状已内缩，加载时不再次内缩。Windows 不允许文件名含冒号，因此统一用 `colliderFileName(partId)` 生成经过 URL 编码的文件名：`ld:3001` → `ld%3A3001.collider.json`；JSON 中仍保留原 PartId，不与 `cu:` 命名空间混淆。

仓库提供三个独立按尺寸编写的例子，由 `scripts/write-overrides.ts` 保留可复查的尺寸来源：

| PartId     | 形状数 | 原因                                                                         |
| ---------- | -----: | ---------------------------------------------------------------------------- |
| `ld:3001`  |    109 | 顶板、侧壁、三条底管分别描述，保留复杂底腔并减少体素阶梯和基本体数量。       |
| `ld:3020`  |    109 | 短底管与浅底腔接近体素尺寸，直接定义实体壁及孔口。                           |
| `ld:85861` |     96 | 显式保留开孔凸点、贯通杆孔、盘体和底部空腔，验证杆能穿过而偏移到壁内会碰撞。 |

前两件在示例数据包内，85861 是 COL-03 的额外真实零件夹具。文件位于 `library/colliders/`；本包不读取 Studio `.col`。

缓存由调用方指定目录。键包含 PartId、实际网格 SHA-256、生成器版本、配置、图元源内容与人工覆盖内容/版本，补齐缺失几何、更换图元、改代理版本均会失效。缓存复用 M1-1 的版本 magic + SHA-256 校验 + V8 payload、同目录临时文件与原子替换方式。损坏缓存丢弃后重建。`get(key)` 不重新验证来源；需要验证时调用 `build(...)`。不内建缓存目录和淘汰策略。

## CollisionWorld

- `new CollisionWorld({ instances?, resolve?, enabled?, budgetMs?, now? })` 建立动态 AABB 树。零件内部另建共享的局部形状树，按需变换查询包围盒，减少窄相组合数。
- `set(instance)` / `remove(path)` 支持增删；删除子模型路径同时删除其所有后代。
- `update(changedPaths)` 仅刷新受影响路径。构造时提供 `resolve(path)`，返回一个叶实例、子模型的全部展开叶实例，或删除时的 `undefined`。共享定义变更后由宿主提供所有受影响的出现路径，包不自行维护文档订阅。
- `query(path, options?)` 检查零件或子模型出现与世界；`query({ shapes, path?, excludePaths?, approximate? }, options?)` 检查世界空间预览。移动多选集合时通过 `excludePaths` 排除已提交实例。
- `queryAll(paths?, options?)` 在给定叶路径范围内检查两端、去重冲突对，共享一次时间预算。未传路径检查整个世界。
- `bounds(path)` 返回内缩前的世界几何包围盒，供地面接触判断。`size` 返回叶实例数；`enabled` 可切换。

盒-盒使用 15 轴 SAT；盒-圆柱和非平行圆柱使用支持映射 GJK；平行圆柱使用径向/轴向精确判定。圆柱是平底有限圆柱，不当作胶囊。镜像和正交缩放保留；无法精确表达的剪切或椭圆圆柱变换用保守盒并标记近似。

`CollisionResult` 包含 `status`、`pairs`、`unknownPaths`、`reasons`、`testedPairs`。每个 pair 有自己的 `status`，`shapes` 是两侧代理形状下标的相交证据，找到第一个证据后停止该零件对。缺代理、近似代理相交、预算耗尽和数值不收敛对应 `missing-proxy`、`approximate`、`budget`、`numerical`。整体 `unknown` 优先于 `hit`，但已知命中的 pair 完整保留，界面可以同时显示确认冲突和无法判断。

`budgetMs` 覆盖查询准备、宽相和窄相；到期将剩余目标路径记录为未知，不跳过小件。单次支持映射迭代有固定上限；函数不是可抢占的实时线程。未指定预算默认完成全部查询。`enabled: false` 在任何遍历、时钟或窄相工作前返回空结果，`testedPairs: 0`。连接图不作为碰撞白名单，连接成立仍可同时报告实体穿模。

实例、代理和返回路径应当视为不可变数据；代理改变时传入新对象再 `set/update`，以使共享形状索引刷新。

## 模型检查

`runChecks` 不修改文档。范围由 `scope: 'project' | 'currentModel' | 'selection'`、`activeModelPath`、`selection` 指定，使用根模型实际展开出现的世界矩阵和继承后颜色；选中子模型包含后代。`visibleOnly` 与 `hidden` 按出现路径过滤，祖先隐藏作用于后代。碰撞检查的两端都限于筛选后的范围。

`ctx` 的各适配器都是可选项；没有某项来源时跳过该类检查，不制造成功或失败的假结论：

- `catalog` 接收 `isFactoryPart`、`isFactoryColor`、`availableColors`，可直接使用 `CatalogService`。不可产配色只在零件和颜色分别属于工厂时报告，避免重复归因。
- `geometry(partId, path)` 接收 LDraw 风格 `missing: string[][]`，返回缺文件名与完整引用链。
- `connectivity.components(scope)` 返回范围内的连通分量；`isConnectorDataReviewed(partId)` 返回 `false` 表示 inferred、`true` 表示已审核、`undefined` 表示没有可判断的状态。无此接口时完全跳过悬空和未审核连接数据。M3-1 合并后的真实适配器由集成方接入。
- `collisionWorld` 接收 `queryAll` 和可选 `bounds`；可用真实世界或测试替身。
- `worldBounds(path)` 可独立提供内缩前世界包围盒，优先于世界的 `bounds`。

悬空检查仅在分量数大于 1 时，报告最大分量之外的分量；同大小按路径稳定选择主体。`groundIsFixed` 使接触地面的其他分量视为固定，LDraw 的底面为 `maxY`；默认地面 Y=0、容差 0.5 LDU，可配置。重复件按相同 PartId、实际颜色和完全相同世界矩阵聚合，忽略数值的负零，不合并仅仅相近的变换。

`grid` 默认步长 `[20, 8, 20]`、世界原点和 `1e-4` LDU 容差；可提供单一步长/三轴步长、原点、容差，或 `false` 关闭。`kinds` 可选择检查项；`collisionEnabled: false` 不调用碰撞世界；`collisionBudgetMs` 设置全量检查的碰撞预算。未知结果单独用 warning 表示，不与已确认穿模 error 混合。其余级别按 05 §8：

| kind / messageKey                                     | 级别    | 中文默认文案                                   |
| ----------------------------------------------------- | ------- | ---------------------------------------------- |
| `collision` / `check.collision`                       | error   | 零件发生穿模。                                 |
| `collisionUnknown` / `check.collisionUnknown`         | warning | 无法判断碰撞：缺少代理、代理近似或计算未完成。 |
| `floating` / `check.floating`                         | error   | 零件悬空或未与主体连接。                       |
| `nonFactoryPart` / `check.nonFactoryPart`             | error   | 当前工厂数据包不包含此零件，或此零件已停产。   |
| `nonFactoryColor` / `check.nonFactoryColor`           | error   | 当前工厂数据包不包含此颜色。                   |
| `unavailableColor` / `check.unavailableColor`         | warning | 当前工厂无法生产此零件与颜色的组合。           |
| `duplicate` / `check.duplicate`                       | warning | 相同零件、颜色和位置存在重叠重复实例。         |
| `missingGeometry` / `check.missingGeometry`           | error   | 零件几何文件缺失。                             |
| `unreviewedConnectors` / `check.unreviewedConnectors` | info    | 零件使用了尚未审核的连接数据。                 |
| `offGrid` / `check.offGrid`                           | info    | 零件位置偏离当前网格。                         |

`Issue.data` 保留 PartId、ColorId、缺失文件/引用链、形状下标、未知原因、网格位置或重复数量等参数；M3-3 可直接做定位与文案格式化。正式 i18n 词条及界面行为留给界面任务。

## 验证、统计与性能

从仓库根目录运行：

```powershell
node scripts/devenv.mjs pnpm verify
node scripts/devenv.mjs pnpm exec vitest run packages/collide --reporter=verbose
node scripts/devenv.mjs pnpm exec tsx --no-cache packages/collide/scripts/measure.ts
node scripts/devenv.mjs pnpm exec tsx --no-cache packages/collide/scripts/measure.ts --performance-only
```

测试覆盖 COL-01–04、CON-03–04、CHK-01–03、科技销插梁孔、旋转/镜像、不同形状的几何判定、树的增删和朴素检索对照、增量与预览隔离、时间预算、全部检查项/级别、范围/可见性/地面/继承颜色、人工覆盖以及缓存损坏与失效。真实库不存在时只跳过真实零件用例，普通夹具测试仍执行；当前交付运行中真实库用例全部实际执行。

`evidence/generation.json` 保存示例包全部 222 件的形状数量、圆柱数量、近似状态、原因与耗时。222/222 均有非空代理，206 件正常生成，16 件开放表面回退为近似包围盒。近似件：2357、25269、3045、3046、43093、3749、56145、55982、30027b、60208、6014a、56898、32607、30176、3818、3819。它们相交时返回 unknown，适合后续优先补人工代理。

`evidence/performance.json` 记录机器、Node 版本和实测数据。场景使用自动 3001 的 217 个基本体，10×10 紧邻列、24 LDU 竖直叠放；拖动交替处于正常与半格错位位置，计时含 update 与 query。全量检查启用全部项目，真实目录/数据包、无缺失几何、注入单连通分量；世界构建另计，不包括在检查耗时中。连接图构建不属于本包计时。10,000 件的全量检查和世界空间基本体内存仍有较高成本，宿主应在 Worker 中运行并按交互需要给查询设置预算。

`evidence/verification.txt` 保存完整 `pnpm verify` 输出。临时测试目录在工作区 `.devdata/collide-tests`，测试清理自己创建的子目录。没有改动 apps、其他 packages、spec、tasks、tools；配套改动只有工作区 lockfile 和追加第三方来源说明。
