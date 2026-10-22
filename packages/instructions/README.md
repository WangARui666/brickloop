# @brickloop/instructions

独立的基础说明书 PDF 引擎。纯函数规划页面，`pdf-lib` 和 `@pdf-lib/fontkit` 生成 PDF；宿主负责步骤图、零件缩略图、字体资源和最终保存。包的运行时代码不访问文件系统、不调用 GPU、不依赖 Electron。

## API

```ts
import { planInstructions, renderInstructionsPdf } from '@brickloop/instructions';
import type { InstructionHost } from '@brickloop/instructions';

const plan = planInstructions(document, {
  paper: 'A4-portrait',
  stepsPerPage: 1,
  includeCover: true,
  includeBom: true,
  pliShowNames: false,
  dpi: 150,
  language: 'zh-CN',
  catalog: { parts, colors, factoryParts, factoryColors, categories },
  metadataDate: '2026-01-01T00:00:00.000Z',
});

const controller = new AbortController();
const host: InstructionHost = {
  fonts: { regular: regularFontBytes, bold: boldFontBytes },
  signal: controller.signal,
  onProgress: ({ completedPages, totalPages }) => updateProgress(completedPages, totalPages),
  renderStep: async ({ modelId, stepIndex, highlightNew, widthPx, heightPx, inheritedColorId, signal }) => {
    // 返回 PNG Uint8Array。显示 stepIds[0..stepIndex] 的累计实例；
    // 仅高亮当前步骤加入的实例。递归展开子模型，应用 inheritedColorId。
    // 同时应用 document.models[modelId].steps[stepId].camera（如有）。
    return renderStepPng({ modelId, stepIndex, highlightNew, widthPx, heightPx, inheritedColorId, signal });
  },
  renderPart: async ({ partId, colorId, sizePx, signal }) => {
    return renderPartPng({ partId, colorId, widthPx: sizePx, heightPx: sizePx, signal });
  },
};
const bytes = await renderInstructionsPdf(plan, host);
// 只有 Promise 成功后才写文件；取消或渲染失败时不会返回半成品。
await savePdf(bytes);
```

以上外部变量和函数由宿主提供。两个渲染回调既可同步返回 `Uint8Array`，也可返回 Promise。字体字节必须是本仓库固定的 Noto Sans SC 静态 OTF，Regular/Bold 分别传入。

### 规划参数

| 参数                          | 取值和默认值                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `paper`                       | `A4-portrait`（默认，595.28 × 841.89 pt）、`A4-landscape`（841.89 × 595.28）、`A5`（竖版，419.53 × 595.28）、`Letter`（竖版，612 × 792） |
| `stepsPerPage`                | `1`（默认）、`2`、`4`；表示每页最多步骤数                                                                                                |
| `includeCover` / `includeBom` | 均默认 `true`                                                                                                                            |
| `pliShowNames`                | 默认 `false`；开启后在 PLI 数量下方显示单行名称，超长加省略号；BOM 始终显示名称                                                          |
| `dpi`                         | 默认 `150`，必须是有限正数；仅影响回调请求的像素尺寸                                                                                     |
| `language`                    | `zh-CN`（默认）或 `en`，由宿主传当前界面语言                                                                                             |
| `rootModelId`                 | 默认 `document.rootModelId`；可选择任意已有子模型作为独立说明书的根                                                                      |
| `catalog`                     | `@brickloop/io` 的 `OutputCatalog`，加可选的 `categories: { id, order }[]`；传当前生效数据包的目录信息                                   |
| `defaultColorId`              | 根级 `inherit` 的解析颜色，默认 `ld:16`                                                                                                  |
| `metadataDate`                | ISO 时间；默认固定为 `2000-01-01T00:00:00.000Z`，同时用作创建与修改时间                                                                  |

`planInstructions` 不改变输入，不读取时间、字体、文件或网络。返回可序列化的 `InstructionPlan`，包含 `options`、`steps`、完整 `bom` 和 `pages`。每页包含尺寸、步骤索引及 `text/image/panel/line` 元素；坐标为左上原点、单位 pt。`TextElement.box` 为文字可用范围。清单中的名称、颜色及编号使用 `overflow: 'ellipsis'`，按真实字体宽度在单行末尾添加省略号，计划数据保留全文；其余文字自动换行并按需缩小到 6 pt，排不下时抛出 `RangeError`。

目录外零件仍按 ID 输出；BOM 中保留 `@brickloop/io` 的未知零件/颜色 `issues`，供宿主展示。仅以隐藏状态隐藏的零件仍计入说明书。

### 步骤、PLI 与分页

- 根模型按 `stepIds` 输出。首次遇到子模型时，先递归插入其单份构建序列，再输出父步骤。同一定义后续不再展开。
- 父步骤 2 首次加入一种两步子模型时，编号为 `2.1`、`2.2`；其中第一步又引用嵌套模型时，其步骤为 `2.1.1`。同一步首次引用多种独立子模型时，增加定义序号，例如 `2.1.1`、`2.2.1`，保证编号唯一。
- 同一子模型在本步的全部实例合并成一个 PLI 项目（例如 `×2`）。构建步骤和该项缩略图以首次出现的继承颜色展示；BOM 仍按所有实例的实际颜色展开计数。
- 普通零件按 `(PartId, ColorId)` 合并，按分类 `order`、分类 ID、颜色 ID、零件展示编号、PartId 排序。没有分类顺序的类别放在已知类别后；字符串使用固定码点顺序，不依赖机器语言。工厂分类覆盖基础分类。子模型项放在普通零件之后。
- 子模型页眉为“子模型：名称”，下方加 0.5pt 浅灰细线。定义切换时换页，避免一页页眉指向多个模型；每页步骤数是上限，未满页按实际步骤扩展为单格或两格。竖向纸张的两步布局为上下两格，A4 横向为左右两格，四步布局为 2 × 2；单元之间留 20pt 间距，并以 0.5pt、`#D9D9D9` 细线分隔。
- PLI 紧贴步骤号下方靠左，以 56pt 格宽和 6pt 内边距按实际项数收缩、换行。缩略图在上，粗体数量在下方居中；默认不显示名称，`pliShowNames: true` 可开启。空步骤不画灰框。步骤图选择 PLI 右侧或下方更大的完整可用矩形，按比例最大化并居中；像素请求随新框的 pt 尺寸计算。
- 多行 PLI 占用有限高度，保留至少一半步骤主体区域给步骤图；超出时在对应步骤页后增加“本步零件（续）”页，不丢失项目。续页同样服从 `pliShowNames`。
- BOM 使用白底紧凑网格、64pt 缩略图、下方粗体数量和单行名称/颜色；小号灰字编号优先显示工厂编号，否则显示零件编号。A4 横版为 10 列 × 4 行（扣除页边距每格约 78pt，100 项需 3 页），其他纸张按约 96pt 的格宽安排。行间用细线分隔，不画逐项灰底卡片。排序与 PLI 相同。
- 子模型 PLI 缩略图和封面调用 `renderStep`，索引为该模型最后一步，仍传 `highlightNew: true`；不会要求第三个渲染回调。
- 图片请求尺寸为 `max(1, round(pt × dpi / 72))`；两倍 dpi 可能因取整有 1 px 差异。图像按比例完整放进框内。同一图片来源和请求尺寸在一次导出中复用。

### 进度、取消与确定性

`onProgress` 首次报告 `{ completedPages: 0, totalPages }`，每完成一页再报告一次，包括封面、续页与 BOM 页。达到总页数表示所有页面已经绘制；宿主应等返回 Promise 成功后再显示保存完成。

调用 `AbortController.abort()` 后以 `name === 'AbortError'` 的异常退出。回调会收到同一个 signal；即使回调不响应 signal，生成 Promise 也会及时拒绝，宿主仍应停止其离屏渲染工作。同步的字体/压缩运算只能在返回事件循环后观察取消。回调错误原样传播。

相同规划、字体字节和确定性 PNG 回调产生相同 PDF 字节。日期默认固定，创建者/生成器固定，不写当前系统时间。宿主若要记录实际导出时间，可显式设置 `metadataDate`，但相应输出字节会改变。

## 字体与资源约定

从仓库根目录运行：

```powershell
node scripts/devenv.mjs pnpm run setup
# 已安装依赖时只校验/补齐字体
node scripts/devenv.mjs pnpm fonts:fetch
```

`scripts/fetch-fonts.mjs` 根据 `library/fonts/fonts.json` 从官方 `notofonts/noto-cjk` 的 **Sans2.004** 发布对应提交下载 `Sans/SubsetOTF/SC` 静态字体，每次校验 SHA-256。已有正确字体时完全离线。校验失败的下载不会替换已有文件；临时 `.download` 文件会清理。

字体获取已接入根 `setup` 脚本。pnpm 10 的 `setup` 同时是包管理器内置命令，会优先修改用户环境变量；执行项目脚本时必须写 `pnpm run setup`。

提交内容只有 `library/fonts/fonts.json` 和 `library/fonts/OFL.txt`。`NotoSansSC-Regular.otf`、`NotoSansSC-Bold.otf` 被 git 忽略，分别约 8.33 MB、8.54 MB。许可为 SIL OFL 1.1。PDF 中嵌入实际使用的字形子集和 ToUnicode 映射，页面文字可选择、可检索。

`src/fontkit.ts` 对固定版本 `@pdf-lib/fontkit@1.1.1` 做局部 CFF 兼容处理：修正多字形字典重复引用时的 FDSelect 对应关系和 CFF 头的 offSize。原始字体、依赖目录及全局原型不被修改。升级 fontkit 时需复核此适配器，并重新做中文/英文提取和视觉回归。

## 留给 M7-2 的接入

1. 桌面声明 `@brickloop/instructions: workspace:*`，导出对话框传当前文档快照、界面语言、目录数据和页面选项。
2. 开发态读取 `<repo>/library/fonts/NotoSansSC-{Regular,Bold}.otf`；安装包约定放在 `<process.resourcesPath>/fonts/` 下，同目录包含 `fonts.json`、`OFL.txt`。M7-2 负责修改资源复制与许可收集脚本，本任务没有修改 `apps/**`。
3. 接入现有离屏步骤渲染器与零件缩略图渲染器。`stepIndex` 为 **0 起始**，累计显示至该步，使用 `inheritedColorId` 解析继承色；不要从当前视口的临时隐藏集合推导说明书内容。
4. 为每次导出创建 signal，按页数更新进度。步骤 PNG、字体和文档在导出期间保持一致；采用 Worker 可避免大模型 PDF 编码占用界面线程。
5. 保存对话框、文件写入和错误提示由桌面负责。拿到完整字节后再原子保存；取消时不写目标文件。将 `plan.bom.issues` 纳入导出报告。

## 验证与示例

```powershell
node scripts/devenv.mjs pnpm -F @brickloop/instructions test
node scripts/devenv.mjs pnpm -F @brickloop/instructions examples
node scripts/devenv.mjs pnpm verify
```

测试不访问网络、不依赖 GPU，PNG 由确定性的纯色缓冲区编码。覆盖 INS-01/02/03、12 种纸张/步骤数的布局快照、BOM/PLI 分页、英文文案、字体校验、确定性、进度与取消。字体需由 setup 预先准备。

`test-output/中文说明书-A4竖版-1步每页.pdf`、`test-output/中文说明书-A4横版-4步每页.pdf` 和 `test-output/中文说明书-A5竖版-2步每页.pdf` 是示例交付物，目录被 git 忽略。示例宿主使用本项目编写的 CPU 方块示意渲染器展示累计零件和新增件颜色，并以 4% 留白贴近图像框边界；正式零件几何、相机和高亮效果由 M7-2 的桌面宿主提供。宿主也应尽量去掉 PNG 内部无意义留白，以充分利用步骤图区域。
