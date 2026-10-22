# @brickloop/ldraw

LDraw 文本、库搜索、递归网格和模型读写。核心入口只使用 ES2022，可在 Node 与 Web Worker 中运行，无 DOM、three.js 或运行时 npm 依赖。`@brickloop/ldraw/node` 提供磁盘库与网格缓存；两种入口不能在 Worker 中混用。

## Node 使用

```ts
import path from 'node:path';
import { buildPartMesh, parseLDraw, readModel, writeModel } from '@brickloop/ldraw';
import { createLibraryResolver, createMeshCache } from '@brickloop/ldraw/node';

const resolver = createLibraryResolver({
  libraryDir: path.resolve('library/ldraw'),
  customDirs: [path.resolve('project/custom')],
  embedded: { 'example.ldr': '0 Example\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat' },
});
const mesh = await buildPartMesh('3001.dat', resolver, {
  highResPrimitives: false,
  smoothingAngle: 30,
  maxDepth: 64,
});
const colours = await resolver.loadColours();
const cache = createMeshCache(path.resolve('.devdata/cache/mesh'));
const { mesh: cachedMesh, key, cacheHit } = await cache.build('3001.dat', resolver);
const parsed = parseLDraw('0 Example', 'example.ldr');
const model = readModel('0 Example', 'example.ldr', resolver);
const text = writeModel(model);
```

开发工具和脚本通过仓库的 `scripts/devenv.mjs` 运行，例如 `pnpm -F @brickloop/ldraw test`。CI 先执行 `pnpm ldraw:fetch`，再执行 `pnpm verify`。本包所有类型保存在本包内，没有修改 `@brickloop/core` 或要求新增通用类型。

## Worker 与自定义来源

```ts
import { LibraryResolver, createMemorySource, buildPartMesh } from '@brickloop/ldraw';

const resolver = new LibraryResolver({
  embedded: { 'project.ldr': projectText },
  custom: [createMemorySource('custom', customFiles)],
  library: createMemorySource('official', libraryFiles),
});
const mesh = await buildPartMesh('3001.dat', resolver);
```

`libraryFiles` 的键包含库内相对路径，例如 `parts/3001.dat`、`p/stud.dat`、`parts/s/3001s01.dat`、`ldconfig.ldr`。`customFiles` 的键直接对应引用名称，如 `my part.dat`、`s/subpart.dat`。也可以实现 `LibrarySource`：提供稳定的 `id` 和异步 `readText(relativePath)`；缺失返回 `undefined`，其他读取错误抛出异常。内存来源创建时复制输入；需要随时反映编辑时，提供自己的 `readText` 来源或重新创建 resolver。

默认 `order` 为 `['embedded', 'custom', 'parts', 'p', 'subparts', 'models']`，可显式替换。custom 内的来源依数组顺序查找。MPD 文件作为当前构建的内嵌命名空间，不污染 resolver 的后续构建。文件名大小写和两种斜杠等价；规范化名称保留内部空格，拒绝绝对路径和 `..`。

`s/` 只定位 `parts/s/`，`48/`、`8/` 定位对应图元目录。高精度开关只在搜索到 `p` 层时优先尝试 `p/48/`，缺失则回退 `p/`；不覆盖工程内嵌、自制件或 `parts/` 命中，也不改写显式 `48/`、`8/` 引用。

## 几何约定

- 坐标为 LDU，保留 LDraw 的 -Y 向上，不翻轴。包围盒顺序为 `[minX, minY, minZ, maxX, maxY, maxZ]`；包括可绘制的面和线端点，排除条件线控制点。空网格为六个 0。
- 面批的 `main` 表示实例主色；固定颜色保留 LDraw 数值代码（包括 `0x2RRGGBB` 直接色）。线批的 `edge` 表示实例边线色；线批数值 16 表示实例主色。显式父色的 EDGE RGB 转成直接色代码。直接色没有 EDGE 定义时采用 `#333333`。
- `conditionalEdges.positions` 每 6 个数表示两个端点，`controls` 每 6 个数表示两个控制点。兼容性扩展 `colors?` 每条线一个已继承的颜色，与普通边线相同；本构建器始终填充它。后续渲染器可按此颜色数组分组。
- `LDConfig.ldr` 通过 `loadColours()` 读取，`alpha` 保留 LDraw 的 0–255 字节值；`material` 保存材质标记及参数。文件局部的 `!COLOUR` 在解析结果中保留，构建时按引用作用域解析边线颜色。显示层使用本地色定义时，应将对应解析结果交给材质表。
- 面统一为 CCW，综合处理 CW、累计 INVERTNEXT 和完整变换的负行列式。未认证、NOCLIP 或祖先禁止剔除的面使整个 `PartMesh.doubleSided` 为 true；当前接口只有全网格双面标记。
- 先计算多边形面法线，再沿共享边按夹角平滑；默认 30°，按角度加权。类型 2 线段阻止跨线平滑，包括覆盖多个面边的长线段。顶点按位置和法线去重，焊接位置量化到 `1e-5` LDU；四边形沿 0–2 对角线三角化。
- 缺失文件、引用环和深度限制只终止对应分支，其他几何继续生成。诊断保留完整引用链；默认最多 64 层（含根文件）。读取来源的 I/O 错误不伪装成缺失。

`!DATA` 原样收集为文件名和合并后的 base64，当前模块不解码图片或构建纹理。未知类型 0 元命令保留；无效操作行产生 parser warnings 并跳过。不处理 Studio 私有行型 11、UV 扩展、TEXMAP 渲染、目录/中文名或连接器。

## 模型读写

`parseLDraw` 返回主文件字段及 `subfiles`（包括首个主文件）、`data`、`warnings`；每个子文件的 `lines` 为类型 0–5 的判别联合，`meta` 保留全部类型 0 原文。MPD 的 FILE/NOFILE 为结构边界，NOFILE 后至下一块之前的内容忽略。

`readModel` 只导入结构，不解析外部零件，不展开几何，也不因缺失文件删掉实例。`submodels[].steps[]` 包含：

- `instances`：颜色、LDraw 顺序的 12 数变换、规范化文件名。
- `meta`：元命令原文；STEP 由步骤边界表示。
- `geometry`：直接出现的类型 2–5 操作行。
- `order`：三种数组的交错次序，保留 INVERTNEXT 与实例行的相对位置。替换数组元素会直接反映到导出；插入或删除元素时同步更新 `order`。没有 order 项的新增元素会在步骤末尾写出。

读取时规整实例数值，写出时再次规整：平移最多 4 位、矩阵最多 6 位，去除多余 0 和负 0。仅对接近正交的单位变换修正数值漂移，保留镜像、缩放和剪切。输出 UTF-8 文本无 BOM，行尾为 CRLF。有效输入的 `readModel → writeModel → readModel` 在此规范化结构上保持一致。

## 磁盘缓存

`createMeshCache(dir).build(...)` 返回 `{mesh, key, cacheHit}`。每次先读取依赖快照，键包含规范化文件名、各级源内容 SHA-256、实际来源、缺失项、颜色配置、构建器版本及完整选项。这样修改子文件、补齐缺失项、更换来源优先级和高精度开关都可自动失效。

`get(key)` / `set(key, mesh)` 适用于已知键的调用方。调用 `get` 本身不重新验证源文件；需要防止陈旧数据时使用 `build`。热缓存的源校验仍有文件读取和解析成本，性能测试分别输出完整热缓存与仅二进制读取的耗时。

格式为版本化 magic + SHA-256 校验 + Node V8 二进制 payload，保存 typed arrays。写入采用同目录临时文件后原子替换。版本不匹配、校验失败、反序列化失败或结构损坏均丢弃并重建；它是可删除的派生数据，不是交换格式。开发目录为 `.devdata/cache/mesh`，生命周期和清理策略交给调用方。

## 验证

Vitest 覆盖任务定义的 G01–G08、BFC、平滑与硬边、颜色继承、MPD/BOM/空格文件名、缓存损坏与传递依赖失效、假 ZIP 下载/校验/解压/复用。官方库不存在时，G01 和性能用例自动跳过并输出获取提示。此任务的 G08 为高精度图元命中规则；规格文档中的视口 G08 留给视口任务。

实现依据为项目规格、分析报告的行为结论，以及官方 [文件格式](https://www.ldraw.org/article/218.html)、[BFC](https://www.ldraw.org/article/415.html)、[颜色扩展](https://www.ldraw.org/article/299.html)、[MPD / !DATA](https://www.ldraw.org/article/47.html)。未复制 three.js LDrawLoader 或其他项目代码。
