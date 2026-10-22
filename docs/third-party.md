# 第三方依赖

本表记录 M0-1 新增的全部直接运行时与开发依赖。版本精确固定于各 `package.json`，传递依赖及完整解析结果锁定于根目录 `pnpm-lock.yaml`。

| 名称              | 版本    | 类型                        | 用途                                          | 许可证     |
| ----------------- | ------- | --------------------------- | --------------------------------------------- | ---------- |
| i18next           | 26.4.5  | 运行时（`@brickloop/i18n`） | 多语言资源、参数插值、语言切换与事件订阅      | MIT        |
| @eslint/js        | 10.0.1  | 开发                        | ESLint 官方 JavaScript 推荐规则               | MIT        |
| @types/node       | 26.6.5  | 开发                        | 测试、检查脚本与工具配置的 Node.js 类型       | MIT        |
| eslint            | 10.12.0 | 开发                        | Flat config 代码检查                          | MIT        |
| prettier          | 3.9.10  | 开发                        | 统一格式，120 字符行宽                        | MIT        |
| tsx               | 4.23.15 | 开发                        | 以 ESM 运行 TypeScript 缺键检查脚本           | MIT        |
| typescript        | 6.0.3   | 开发                        | strict 类型检查                               | Apache-2.0 |
| typescript-eslint | 8.71.2  | 开发                        | TypeScript 推荐规则与 Promise 等类型感知检查  | MIT        |
| vite              | 8.3.4   | 开发                        | Vitest 所需的 Vite peer dependency 和模块转换 | MIT        |
| vitest            | 5.0.5   | 开发                        | 工作区统一单元测试与命令行集成测试            | MIT        |

包管理器按任务约定使用 pnpm 10.33.0（MIT），通过根目录 `packageManager` 固定；它不是额外的项目依赖。`@brickloop/core` 没有运行时依赖。

版本与许可核对来源：各包发布到 [npm 官方 registry](https://registry.npmjs.org/) 的元数据以及 `pnpm licenses list --json`。

已安装的传递依赖许可还包括 BSD-2-Clause、BSD-3-Clause、ISC、MPL-2.0，以及 minimatch 10.2.6 的 BlueOak-1.0.0。后者为允许使用、修改与分发的宽松许可，分发时须保留许可证正文或链接；已核对包内 `LICENSE.md`（[许可原文](https://blueoakcouncil.org/license/1.0.0)）。lightningcss 及其 Windows 二进制包使用 MPL-2.0。未引入 GPL/AGPL 依赖。

## TypeScript 版本选择

当前 TypeScript 最新版为 7.0.2，但 typescript-eslint 8.71.2 声明的 TypeScript peer 范围为 `>=4.8.4 <6.1.0`。因此使用该范围内最新的稳定版 TypeScript 6.0.3，保证解析器与类型感知检查兼容。此选择符合任务补充约定；后续随 typescript-eslint 的官方支持范围升级。

来源：[typescript-eslint 支持版本](https://typescript-eslint.io/users/dependency-versions/)、[TypeScript 包元数据](https://registry.npmjs.org/typescript)、[typescript-eslint 8.71.2 元数据](https://registry.npmjs.org/typescript-eslint/8.71.2)。

## 开发环境

根目录按接口约定声明 Node.js `>=22`。当前工具链自身的 engines 更严格：ESLint 10 要求 Node.js `^20.19.0 || ^22.13.0 || >=24`，Vitest 5 要求 `^22.12.0 || ^24.0.0 || >=26.0.0`。本任务在已有 Node.js 26.5.1、pnpm 10.33.0 上校验；使用 Node.js 22 时至少需要 22.13.0。

pnpm store、下载缓存和状态目录通过 `.npmrc` 分别设为仓库内的 `.devdata/pnpm-store`、`.devdata/pnpm-cache`、`.devdata/pnpm-state`；安装配置钩子按仓库根目录解析这些路径。Vitest 的 `cacheDir` 指向 `.devdata/vite`；package 脚本通过仓库自带的 `scripts/devenv.mjs` 运行工具：它按仓库根目录推算路径，把 Node 编译缓存放到 `.devdata/node-compile-cache`，把 `TEMP`、`TMP` 放到 `.devdata/tmp`，脚本中不写死绝对路径。

缺键检查使用 `tsx --no-cache`，CLI 测试也禁用 tsx 转译缓存。测试夹具在 `.devdata/i18n-test-tmp/` 下创建并在每个测试结束后清理。所有检查命令直接可用，无需 source 环境脚本。

安装时仅允许 esbuild 执行所需的 postinstall，由 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 声明。

## M0-2 桌面外壳

以下为本次新增的直接依赖；版本按 npm registry 的稳定标签核对并精确固定。工作区内的 `@brickloop/i18n` 通过 `workspace:*` 复用，不是第三方依赖。

| 名称                 | 版本   | 类型              | 用途                                              | 许可证     |
| -------------------- | ------ | ----------------- | ------------------------------------------------- | ---------- |
| Electron             | 44.7.2 | 开发 / 桌面运行时 | 安全进程边界、窗口与 IPC                          | MIT        |
| electron-vite        | 6.0.0  | 开发              | 构建 main、preload、renderer                      | MIT        |
| React                | 19.3.1 | 运行时            | 界面组件                                          | MIT        |
| react-dom            | 19.3.1 | 运行时            | React DOM 挂载                                    | MIT        |
| Ant Design（antd）   | 6.6.6  | 运行时            | 菜单、面板标签、树、输入框、暗色主题和内置 locale | MIT        |
| Zustand              | 5.0.15 | 运行时            | 语言切换和面板状态                                | MIT        |
| lucide-react         | 1.57.0 | 运行时            | 统一线性图标                                      | ISC        |
| @vitejs/plugin-react | 6.1.2  | 开发              | Vite 的 React JSX 与开发刷新                      | MIT        |
| @types/react         | 19.3.0 | 开发              | React 类型                                        | MIT        |
| @types/react-dom     | 19.3.0 | 开发              | React DOM 类型                                    | MIT        |
| @playwright/test     | 1.64.1 | 开发              | Electron E2E 与截图                               | Apache-2.0 |

新增传递依赖包括 Ant Design 内部的 `@ant-design/icons` 6.3.4（MIT）、Playwright / playwright-core 1.64.1（Apache-2.0）等；具体版本见 `pnpm-lock.yaml`。应用自行使用的图标统一来自 lucide-react，未直接引入 Ant Design 图标包。

`pnpm licenses list --json` 已核对本次依赖树：MIT、ISC、Apache-2.0、BSD-2-Clause、BSD-3-Clause、MPL-2.0、BlueOak-1.0.0，以及 caniuse-lite 1.0.30001816 浏览器兼容性数据的 CC-BY-4.0。后者来自 [caniuse-lite](https://github.com/browserslist/caniuse-lite)，原始数据来自 [Can I use](https://caniuse.com/)，分发时保留其署名与 [CC BY 4.0 许可](https://creativecommons.org/licenses/by/4.0/)。没有 GPL/AGPL 依赖。

版本来源：[npm 官方 registry](https://registry.npmjs.org/)、[Electron 稳定版本列表](https://releases.electronjs.org/)。Electron 自带 Chromium 等组件的第三方许可随二进制中的 `LICENSES.chromium.html` 分发。

### M0-2 安装与缓存

Electron 44 的 npm 包不再自带自动下载二进制的 postinstall；根项目的 `postinstall` 通过 `scripts/devenv.mjs` 调用官方安装器。第一次普通 `pnpm install` 就将二进制下载缓存放到仓库 `.devdata/electron-cache`；`pnpm setup` 是可选的安装入口。安装器重复执行时复用已安装版本。

`.npmrc` 追加仓库内的 pnpm 配置钩子，在安装依赖前复用 `developmentEnvironment()` 设置 TEMP/TMP、Node 编译缓存、Electron 与 Playwright 缓存。钩子将根 `package.json` 的 `pnpm.onlyBuiltDependencies` 与既有工作区名单合并，只放行 electron、esbuild。未修改全局环境或 pnpm 全局配置，也不使用 `%LOCALAPPDATA%\electron`。

路径都按仓库位置计算；`dev` 与 `e2e` 分别将 `BRICKLOOP_DATA_DIR` 指向 `.devdata/dev`、`.devdata/e2e`。Chromium 会话、日志与崩溃目录也放在各自数据目录内。详细命令、目录和安全边界见 [桌面包说明](../apps/desktop/README.md)。

## 3D 视口

| 名称         | 版本    | 类型                            | 用途                                                                                   | 许可证 |
| ------------ | ------- | ------------------------------- | -------------------------------------------------------------------------------------- | ------ |
| three        | 0.186.1 | 运行时（`@brickloop/viewport`） | WebGPURenderer（自动回退 WebGL2）、场景、几何、材质、相机、OrbitControls、TSL 网格淡出 | MIT    |
| @types/three | 0.186.0 | 开发                            | three.js、WebGPU 和 OrbitControls 的 TypeScript 类型                                   | MIT    |

版本与许可证根据 npm 官方 registry 元数据核对：[three](https://registry.npmjs.org/three/0.186.1)、[@types/three](https://registry.npmjs.org/@types%2fthree/0.186.0)。OrbitControls 和 TSL 随 three.js 分发，不是独立依赖。渲染器回退机制与鼠标位置缩放参考 [WebGPURenderer 文档](https://threejs.org/docs/pages/WebGPURenderer.html)及 [OrbitControls 文档](https://threejs.org/docs/pages/OrbitControls.html)。

视口只负责场景与相机，不维护文档。文档对象统一挂在绕 X 轴旋转 180° 的 `ldrawRoot` 下；`content` 子层为未来按零件定义、颜色组织的 InstancedMesh 批次保留位置。地面网格、灯光和坐标轴不参与模型取景。相机控制关闭惯性，通过变化事件合并单次 animation frame；释放时取消待执行帧，并清理控件、ResizeObserver、场景资源与渲染器。

## M1-1 LDraw 零件库与解析模块

`@brickloop/ldraw` 和 `tools/ldraw-fetch` 没有新增 npm 依赖。解析、BFC、网格、法线平滑和 ZIP 读取均为本项目实现；磁盘缓存使用 Node.js 自带的 crypto/fs/v8，ZIP 解压与 CRC 使用自带 zlib。测试复用已有 Vitest、TypeScript 与 tsx。没有复制 three.js LDrawLoader 或其他项目的代码，也不包含 BrickLink Studio 的文件。

| 资源                 | 固定版本                                               | 来源与署名                                                                    | 许可                                                         |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| LDraw.org 官方零件库 | 库更新标识 2026-09；LDConfig 2026-05-29；37,261 个文件 | LDraw.org 及各文件 Author / !HISTORY 标注的作者；LDraw 由 James Jessiman 创建 | CC BY 2.0（旧称 CCAL 2.0）和/或 CC BY 4.0，按各文件 !LICENSE |

下载来源：[LDraw 官方 complete.zip](https://library.ldraw.org/library/updates/complete.zip)。本次固定 ZIP 为 146,075,744 字节，SHA-256：`f3e496d0ede69ca7942fa4aa198e661ee2d22723906101e2e339d8917a4dd5f2`；pin 随获取脚本纳入 git，库本体和生成的 VERSION 不纳入 git。

许可依据为库内 `CAreadme.txt`、`CAlicense.txt`、`CAlicense4.txt` 和各零件的 `!LICENSE`，并参照 [LDraw 贡献者协议](https://www.ldraw.org/article/349.html)。许可正文：[CC BY 2.0](https://creativecommons.org/licenses/by/2.0/)、[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。本次保留原始库文件，只生成版本元数据和派生网格缓存；分发库或派生几何时应保留作者/历史署名、来源、许可及转换/修改说明，不能只署名本项目。

获取脚本仅将 ZIP 作为数据处理，不运行 `mklist.exe` 等附带程序。库结构与固定版本操作见 [library/README.md](../library/README.md)；接口和缓存格式见 [packages/ldraw/README.md](../packages/ldraw/README.md)。

## M1-2 零件目录与数据包

以下新增直接运行时依赖均使用宽松许可，版本固定于 `packages/catalog/package.json`：

| 名称       | 版本   | 用途                                             | 许可证 |
| ---------- | ------ | ------------------------------------------------ | ------ |
| exceljs    | 4.4.0  | 中文 XLSX 模板、下拉校验、工厂资料读写           | MIT    |
| pinyin-pro | 3.29.5 | 中文名称的全拼与拼音首字母索引                   | MIT    |
| fflate     | 0.8.2  | `.brklpack` ZIP 与 XLSX ZIP 时间归一，确定性输出 | MIT    |

许可已核对安装包的 `package.json` 与 LICENSE。上游来源：[ExcelJS](https://github.com/exceljs/exceljs)、[pinyin-pro](https://github.com/zh-lx/pinyin-pro)、[fflate](https://github.com/101arrowz/fflate)。ExcelJS 的传递依赖 JSZip 3.10.2 提供 `MIT OR GPL-3.0-or-later` 双许可，本项目选择 MIT；archiver、fast-csv、unzipper、readable-stream 等按其 MIT 许可使用。安装提示的 fstream、glob、inflight、lodash.isequal、rimraf、uuid 等旧版传递依赖来自 ExcelJS，后续升级需检查 XLSX 确定性与模板往返。

示例数据包和目录源自 [LDraw.org 官方零件库](https://library.ldraw.org/) 与其 `LDConfig.ldr`（2026-05-29）。版权归 LDraw.org 零件作者及贡献者；逐文件作者、修改历史和许可位于原始 DAT 头部，库中 `CAreadme.txt`、`CAlicense.txt`、`CAlicense4.txt` 提供完整说明。原始零件按文件声明适用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 或 CC BY 2.0 / 4.0 的组合声明。目录保留源文件引用；示例包只派生编号、名称和颜色资料，添加中文术语翻译、工厂占位编号与演示用可产配色，未修改或内嵌源几何。LDConfig 主色暂作示例实测值，不代表真实工厂测量或产能。

## M1-3 桌面目录、数据包与零件渲染

没有新增外部 npm 依赖。桌面和视口增加内部工作区依赖 `@brickloop/catalog`、`@brickloop/ldraw`；继续复用 three.js（MIT）、React（MIT）、Ant Design（MIT）、Zustand（MIT）、lucide-react（ISC）及上节目录层依赖。固定行高的缩略图虚拟滚动由本项目实现，不引入虚拟列表库。网格 Worker、二进制传输和缓存使用 Node.js 内置 API；缩略图由现有 three.js 渲染器生成。

本次生成的网格与 PNG 是 LDraw 原始零件的派生数据，保存在用户缓存目录，不修改原始库。分发这些派生资源时仍适用前述逐文件 LDraw 署名及许可要求。

## M5-1 AI 核心

`@brickloop/ai` 新增以下直接运行时依赖，版本精确固定在包的 `package.json`。

| 名称              | 版本    | 用途                                        | 许可证     |
| ----------------- | ------- | ------------------------------------------- | ---------- |
| openai            | 7.34.0  | 官方 Responses 与 Chat Completions SDK      | Apache-2.0 |
| @anthropic-ai/sdk | 0.134.0 | 官方 Messages、模型目录与类型化错误         | MIT        |
| @google/genai     | 2.30.0  | 官方 Gemini 流式接口、函数声明与 inlineData | Apache-2.0 |
| zod               | 4.6.7   | 工具参数校验与 JSON Schema 生成             | MIT        |
| jose              | 6.2.12  | OAuth ID Token 签名、声明与 JWKS 校验       | MIT        |

版本/许可来源为 npm registry 元数据与已安装包的 LICENSE，执行 `pnpm licenses list --json` 核对。新增依赖使用 MIT、Apache-2.0、BSD 或 ISC 等宽松许可；没有引入 GPL/AGPL。Google SDK 的安装脚本和 protobufjs 的可选安装脚本未获执行许可，本任务未更改工作区构建脚本白名单；标准 HTTP/SSE 功能已通过注入传输测试。

官方源码：[openai-node](https://github.com/openai/openai-node)、[anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript)、[js-genai](https://github.com/googleapis/js-genai)、[zod](https://github.com/colinhacks/zod)、[jose](https://github.com/panva/jose)。

评测中的 30 张参考 PNG 为本项目根据原创几何定义生成，不含第三方图片。SIWC 官方 Markdown 副本仅从 `.devdata/reference/siwc/` 读取，未复制或加入版本控制。宿主提供 SecretStore 加密实现；本包未新增 Electron 依赖。

## M2-3 编辑器拾取与场景投影

新增 `three-mesh-bvh` 0.9.16（MIT，Copyright © 2018 Garrett Johnson），用于按零件定义缓存 BVH 并对每个出现的局部射线拾取。源码与许可：[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)、[LICENSE](https://github.com/gkjohnson/three-mesh-bvh/blob/master/LICENSE)。已核对安装包的 `package.json` 与 LICENSE。没有修改依赖源码或其许可。

移动与旋转手柄继续使用 three.js 内置 TransformControls（MIT），通过公开 `setColors` 接口适配轴色与当前轴强调色。描边使用本项目的全分辨率屏幕遮罩；实例边线使用 three.js TSL 与 InstancedBufferGeometry，无额外依赖。桌面缓存使用 Node.js 内置 V8 序列化。

## M2-2 工程文件、恢复与 Studio / LDraw 交换

| 名称          | 版本  | 用途                                                      | 许可证 |
| ------------- | ----- | --------------------------------------------------------- | ------ |
| fflate        | 0.8.2 | 复用已有版本；工程与 Studio ZIP、默认透明 PNG 的压缩      | MIT    |
| @noble/hashes | 2.0.1 | 新增；纯 JavaScript SHA-256，支持 Worker 同步工程打包校验 | MIT    |

许可证已核对安装包 LICENSE。来源：[fflate](https://github.com/101arrowz/fflate)（Arjun Barrett）、[noble-hashes](https://github.com/paulmillr/noble-hashes)（Paul Miller）。noble-hashes 没有运行时传递依赖。CRC32、ZIP 成员校验、格式映射、原子保存和恢复流程由本项目编写；文件系统使用 Node 内置模块，没有新增 FFI 或 Windows 原生扩展。

Brickloop 为了文件互通读写 BrickLink Studio `.io` 文件。仓库不包含 BrickLink Studio 的代码、图片或样例文件。`test/fixtures/io/mod-01.mpd` 和 `custom-cube.dat` 为本项目自建数据；生成的人工核对 `.io` 位于被忽略的 `out/`。LDraw 目录映射仅接收已有 catalog 数据，不重新分发官方零件几何。

## M4-1a 模型导出、BOM 与模型信息

| 名称           | 版本           | 类型与用途                                                   | 许可证                     |
| -------------- | -------------- | ------------------------------------------------------------ | -------------------------- |
| @xmldom/xmldom | 0.9.12         | 运行时；每次 COLLADA 导出后的 XML 解析自检，可在 Worker 使用 | MIT                        |
| exceljs        | 4.4.0          | 运行时；复用已有版本，仅 Node 入口生成带 PNG 的 BOM XLSX     | MIT                        |
| libxml2-wasm   | 0.7.2          | 开发；COLLADA 1.4.1 XSD 校验                                 | MIT，内含 libxml2 也是 MIT |
| gltf-validator | 2.0.0-dev.3.10 | 开发；Khronos 官方 glTF/GLB 验证器                           | Apache-2.0                 |

许可证核对依据为各安装包的 LICENSE（libxml2 同时有 `LICENSE.libxml2`，gltf-validator 同时有 NOTICES）及 npm 元数据。来源：[xmldom](https://github.com/xmldom/xmldom)、[ExcelJS](https://github.com/exceljs/exceljs)、[libxml2-wasm](https://github.com/jameslan/libxml2-wasm)、[glTF-Validator](https://github.com/KhronosGroup/glTF-Validator)。新增的解析/验证依赖无运行时传递依赖；ExcelJS 的 JSZip 双许可继续选择 MIT。本次没有复制其他项目的编码器实现。

COLLADA 测试 schema 来源：[Khronos 官方 OpenCOLLADA 的 1.4.1 XSD](https://github.com/KhronosGroup/OpenCOLLADA/blob/6031fa956e1da4bbdd910af3a8f9e924ef0fca7a/DAEValidator/xsd/collada_schema_1_4_1.xsd)，固定 commit `6031fa956e1da4bbdd910af3a8f9e924ef0fca7a`，文件 SHA-256 为 `49266165027329388e710ade6a424116570cda6776cbf3623f7b8c78c727b0ff`。其文件头声明 Khronos Group / Sony Computer Entertainment 2005、2006 年版权、All Rights Reserved 和免责条款，未明确给出宽松再分发授权。因此不推定其他组件许可证覆盖该 XSD；按主窗口授权，下载到被忽略的 `.devdata/io-schema/` 作本地测试，不随源码提交。依赖的 [W3C XML namespace schema](https://www.w3.org/2001/03/xml.xsd) 也仅在此目录缓存，下载脚本保留原文件并记录来源/哈希。缺文件时仅 XSD 用例说明原因后跳过；XML 解析和结构测试继续执行。

OBJ、COLLADA、GLB 和 BOM 编码、矩阵变换和统计由本项目实现。测试盒体和假缩略图为测试数据；真实 3001 回归只读 `library/ldraw`，示例导出的衍生几何位于被忽略的本地 `out/`，不随代码提交。分发这些衍生文件时须继续遵循上文 LDraw 许可与逐文件署名要求。

## M3-1 连接器与吸附

`@brickloop/connect` 未新增第三方 npm 依赖。运行时仅使用工作区的 core 数学/文档与 ldraw 解析接口；数据包生成复用 catalog，格式化复用已有 Prettier，测试复用已有 Vitest。运行时不依赖 DOM、Node 或 three.js。

`library/connectors/*.json` 是从上述固定 LDraw.org 官方库的图元引用、累计变换与几何轮廓派生的连接元数据，并包含 Brickloop 人工补写的 draft。对应来源为相同编号的 DAT 及其递归引用文件；作者与修改历史仍见每个源文件的 Author / !HISTORY，许可见 !LICENSE。生成表保留 PartId；`source` 标明自动推断或人工修改，逐件覆盖与人工补写清单见 [连接器统计](../library/connectors/README.md)。分发这些派生元数据时一并保留本来源说明、源 DAT 的作者/历史署名及其 CC BY 许可说明。

连接器 schema、类型兼容表、配对标签、吸附参数、分桶与求解代码由本项目独立定义。Studio 分析报告仅用于确认远处球关节排除、不同阶段阈值分离、语义字段复制、端部约束与候选稳定等行为要求；没有复制 Studio 的连接数据、碰撞数据、代码或其参数表。未使用 LDCad 或 BrickNet 连接数据。

## M3-2 碰撞代理与模型检查

`@brickloop/collide` 没有新增外部 npm 依赖。运行时仅引用工作区的 core、ldraw；catalog 仅用于验收统计脚本。SAT、有限圆柱支持映射/GJK、动态 AABB 树、扫描线体素化及合并均为本项目实现。磁盘缓存复用 M1-1 的设计，使用 Node.js 内置 crypto/fs/v8。未复制 Studio `.col` 数据、代码或其他产品的碰撞资源。

自动代理来自上述 LDraw 官方库，属于网格的派生几何；原始文件的 Author、!HISTORY、!LICENSE 和库许可继续适用。人工代理 `library/colliders/ld%3A3001.collider.json`、`ld%3A3020.collider.json`、`ld%3A85861.collider.json` 按公开尺寸编写，尺寸依据为 3001.dat、s/3001s01.dat、3020.dat、85861.dat、stud.dat、stud2a.dat、stud4.dat；原作者包括 James Jessiman、Magnus Forsberg，以及这些文件 Author / !HISTORY 中列出的所有贡献者。这些源文件声明 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，来源为 [LDraw.org 官方零件库](https://library.ldraw.org/)。

转换说明：本项目保留实体孔洞，将曲面近似为内接盒/圆柱，对基本体表面内缩至少 0.5 LDU，并添加 schema、版本、PartId 和说明；未修改原始 LDraw 库。派生文件与分发的自动代理应连同本署名和许可来源说明提供。人工尺寸定义及验证方式见 `packages/collide/scripts/write-overrides.ts`、`library/colliders/README.md` 和 `packages/collide/README.md`。

## M2-4 桌面文件流程与 M4-1b 导出界面

桌面端复用工作区 `@brickloop/io`，没有新增第三方运行时依赖。桌面端到端测试直接声明已有的 [fflate 0.8.2](https://github.com/101arrowz/fflate)（MIT），用于读取工程和 XLSX 压缩成员、验证缩略图与工作表内容。BOM 图片复用现有 Three.js 缩略图渲染器与缓存；Excel 编码继续使用 IO 包已有的 ExcelJS。Banana 样例只读原路径，未复制入产品；导出样例中的 LDraw 派生几何继续适用上文许可与署名要求。

## M6-1a 马赛克与看图搭建逻辑

| 名称     | 版本  | 用途                                   | 许可证       |
| -------- | ----- | -------------------------------------- | ------------ |
| fast-png | 8.0.0 | 纯 JavaScript PNG 解码；测试生成 PNG   | MIT          |
| jpeg-js  | 0.4.4 | 纯 JavaScript JPEG 解码；测试生成 JPEG | BSD-3-Clause |
| iobuffer | 6.0.1 | fast-png 的二进制缓冲区依赖            | MIT          |
| fflate   | 0.8.2 | fast-png 复用已有的 PNG 压缩/解压依赖  | MIT          |

已核对安装包 LICENSE 与 npm 版本/许可元数据。来源：[fast-png](https://github.com/image-js/fast-png)（Michaël Zasso）、[jpeg-js](https://github.com/jpeg-js/jpeg-js)（Eugene Ware）、[iobuffer](https://github.com/image-js/iobuffer)（Michaël Zasso）、[fflate](https://github.com/101arrowz/fflate)（Arjun Barrett）。没有新增原生扩展或需执行安装脚本的依赖。zod、i18next、Vitest 继续使用工作区已有宽松许可版本。

CIEDE2000 公式按公开标准实现，数值测试采用 Sharma、Wu、Dalal 的公开补充测试样本：[The CIEDE2000 Color-Difference Formula: Implementation Notes, Supplementary Test Data, and Mathematical Observations](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/)，Color Research & Application 30(1), 21–30, 2005，DOI 10.1002/col.20070。未复制该网页的实现代码或第三方代码。

本轮新增图像测试数据全部由测试代码生成的几何图案或像素缓冲区组成，无第三方照片。既有 AI 评测的 30 张原创参考 PNG 未改动。色板映射、面积缩放、误差扩散、贪心铺砖、掩码连通域、图像合成及工作流状态机由本项目实现。

## M5-2a MCP 服务包

`@brickloop/mcp` 新增以下直接运行时依赖，均固定版本并使用宽松许可：

| 名称                      | 版本    | 用途                                                            | 许可证 |
| ------------------------- | ------- | --------------------------------------------------------------- | ------ |
| @modelcontextprotocol/sdk | 1.32.1  | 官方 MCP stdio、Streamable HTTP、客户端及协议类型               | MIT    |
| koffi                     | 3.3.3   | Windows 命名管道的当前用户 DACL、拒绝远程连接和非阻塞 Win32 I/O | MIT    |
| tsx                       | 4.23.15 | 复用工作区已有版本；开发态 Node 垫片加载 TypeScript 源码        | MIT    |
| zod                       | 4.6.7   | 复用 AI 包已有版本；宿主桥消息与文档工具 schema 校验            | MIT    |

来源与署名：[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)（Anthropic, PBC）、[Koffi](https://github.com/Koromix/koffi)（Niels Martignène）、[tsx](https://github.com/privatenumber/tsx)、[Zod](https://github.com/colinhacks/zod)。已核对安装包 LICENSE，并通过 `pnpm --filter @brickloop/mcp licenses list --prod --json` 检查该包依赖树，报告包含 MIT、ISC、BSD-2-Clause、BSD-3-Clause 等宽松许可。SDK 的 HTTP/SSE、Express/Hono、Ajv 等传递依赖按各自许可保留声明；未将工作区已有的其他许可变更为新许可。

Windows 使用 `@koromix/koffi-win32-x64` 3.3.3 的 N-API 预编译二进制（MIT），由 Koffi 的平台可选依赖提供。本次未放行 Koffi 安装构建脚本，未修改构建脚本白名单；已在 Windows x64 验证预编译模块与实际管道 ACL。其他架构发布时应随包分发匹配的 Koffi 模块与 LICENSE。Win32 系统 API 不引入第三方实现代码。

宿主桥协议、长度前缀分帧、连接审批、事务调度、活动日志和英文 MCP instructions 均为本项目编写；工具定义直接复用 `@brickloop/ai`。测试仅使用本机假宿主、假文档数据及本地 SDK 客户端，无模型请求、真实账号凭据或第三方工程素材。

## M7-2a Windows 打包与许可数据

| 名称             | 版本    | 类型与用途                                                 | 许可证 |
| ---------------- | ------- | ---------------------------------------------------------- | ------ |
| electron-builder | 26.15.3 | 开发；Windows x64 NSIS 安装包、应用图标/版本资源与文件关联 | MIT    |

源码与许可：[electron-builder](https://github.com/electron-userland/electron-builder)、[LICENSE](https://github.com/electron-userland/electron-builder/blob/master/LICENSE)。已核对安装包的 package.json 和 LICENSE。其 app-builder-lib、builder-util、builder-util-runtime 等打包依赖由 pnpm-lock.yaml 固定，仅用于构建；未新增应用运行时依赖。NSIS 安装器使用其 zlib/libpng 许可；相关工具仅从 electron-builder 官方发布渠道下载，缓存保留在 `.devdata/electron-builder-cache/`。不运行安装程序进行验收。

应用图标源自本项目菜单栏已有的环形积木 SVG，添加深色圆角背景和暖橙色笔画。`apps/desktop/build/icon.svg` 与包含 16、24、32、48、64、128、256 像素图像的 `icon.ico` 一并保存，不引入第三方图标素材。

`scripts/generate-licenses.mjs` 在打包时读取 `pnpm licenses list --json --prod`、完整依赖许可结果与本文，生成 `resources/licenses.json`。每条依赖包含 `name`、`version`、`license`、`repository`，并以 `production` 区分工作区生产依赖，以 `documented` 标记本文提及的包；保留上游许可表达式。JSZip 的双许可仍按上文选择 MIT。开发工具及工作区其他组件也列入清单，便于关于页完整展示本文涉及的依赖；这些记录不表示对应工具随应用运行。许可正文按内容 SHA-256 去重保存到 `resources/licenses/texts/`，本文副本保存到 `resources/licenses/third-party.md`。Electron 和 Chromium 的完整许可继续随运行时的 `LICENSE.electron.txt`、`LICENSES.chromium.html` 分发。

LDraw 原始文件只读复制，保留每个 DAT 的作者、历史和许可头，以及 `CAreadme.txt`、`CAlicense*.txt`、`VERSION.json`；不复制 `models/`、可执行工具或工具压缩包。示例包、连接器与碰撞数据继续适用本文 M1-1、M1-2、M3-1、M3-2 的来源和转换说明。生成的 `resources/licenses/ldraw-attribution.txt` 与 `licenses.json` 中的 `ldraw.attribution` 保留这些段落，供关于页显示。LDraw™ 商标由 James Jessiman 遗产管理方拥有并许可使用。

## M5-2 桌面 AI 接入补充

桌面应用新增工作区依赖 `@brickloop/ai`、`@brickloop/mcp`、`@brickloop/mosaic`，复用已有服务商 SDK、图像算法与 MCP 实现。直接声明 `zod` 4.6.7（MIT，用于 IPC/设置校验）、`koffi` 3.3.3（MIT，Windows 本机管道的原生依赖，构建时外置并在安装包中解包）；测试直接声明 `@modelcontextprotocol/sdk` 1.32.1（MIT，真实 stdio 客户端验收）。这些版本此前已由 AI/MCP 包使用，没有引入另一套协议实现。

`apps/desktop/src/renderer/src/assets/chatgpt-logo-white.svg` 来自 [OpenAI 官方登录按钮资源](https://developers.openai.com/assets/siwc/chatgpt-logo-white.svg)，仅用于 `Continue with ChatGPT` 登录按钮，按 [官方 UI/UX 指南](https://developers.openai.com/siwc/ui-ux-guidelines) 使用。ChatGPT 名称与标识属于 OpenAI；此品牌资源不作为本项目开源代码重新许可。

## M7-1a 宏数据与内置内容

未新增第三方依赖；宏 ZIP 与 SHA-256 复用已声明的 fflate、@noble/hashes，生成脚本复用 tsx、Prettier。io 的物理验收新增本工作区 `@brickloop/connect`、`@brickloop/collide` 开发依赖。

`library/macros/builtin/` 的六种拼法由本项目 `scripts/build-macros.mjs` 描述，不复制第三方模型；文件仅保存稳定零件/颜色 ID 与变换，不内嵌 LDraw 几何或缩略图。包围盒来自只读 LDraw 官方库，印刷件分组规则参考官方英文标题与基础件编号。LDraw 数据继续遵循上文 CC BY 4.0 来源、作者与署名说明，未改变官方文件。

## M7-2b 独立说明书 PDF 引擎

| 名称             | 版本    | 类型与用途                                       | 许可证      |
| ---------------- | ------- | ------------------------------------------------ | ----------- |
| pdf-lib          | 1.17.1  | 运行时；PDF 页面、图片、可选择文字与元数据       | MIT         |
| @pdf-lib/fontkit | 1.1.1   | 运行时；Noto Sans SC 字形读取与子集嵌入          | MIT         |
| pdfjs-dist       | 6.4.299 | 开发；提取 PDF 文本、验证坐标与字体字形          | Apache-2.0  |
| Noto Sans SC     | 2.004   | 字体资源；官方 SubsetOTF/SC 静态 Regular 与 Bold | SIL OFL 1.1 |

源码与许可：[pdf-lib](https://github.com/Hopding/pdf-lib)（Andrew Dillon）、[@pdf-lib/fontkit](https://github.com/Hopding/fontkit)（Devon Govett / Andrew Dillon）、[PDF.js](https://github.com/mozilla/pdf.js)（Mozilla Foundation）、[Noto CJK Sans2.004 官方发布](https://github.com/notofonts/noto-cjk/releases/tag/Sans2.004)。已核对安装包许可证和官方字体许可。PDF 引擎使用工作区 `core`、`catalog`（仅类型）、`io`、`i18n` 的公开接口，没有复制 Studio 的代码或数据。

字体下载固定到官方提交 `523d033d6cb47f4a80c58a35753646f5c3608a78` 的 `Sans/SubsetOTF/SC/`，清单与完整下载 URL 见 `library/fonts/fonts.json`，原始许可正文见 `library/fonts/OFL.txt`。`NotoSansSC-Regular.otf` 的 SHA-256 为 `faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9`；`NotoSansSC-Bold.otf` 为 `c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0`。原始字体不进 git，安装包分发时保留 OFL；输出 PDF 只嵌入所需字形子集。

`packages/instructions/src/fontkit.ts` 包含针对固定版 fontkit CFF 编码的局部兼容处理，修正重复字体字典映射和 CFF 头字段；不修改上游文件或字体资源。第三方传递依赖包含 `@pdf-lib/standard-fonts` 1.0.0（MIT）、`@pdf-lib/upng` 1.0.1（MIT）、`pako` 1.0.11（MIT AND Zlib）、已有 `tslib`（0BSD）；PDF.js 的可选测试绘图依赖 `@napi-rs/canvas` 1.0.11 及平台二进制为 MIT，Skia 与其组件按包内第三方许可声明保留。PDF.js 和可选绘图库不进入说明书运行时依赖。

测试 PNG 与示例 PDF 中的方块示意图均由本项目代码生成；没有使用第三方照片或 Studio 渲染素材。

## M10-1 搭建动画视频

| 名称       | 固定版本 | 用途                                                        | 许可证 |
| ---------- | -------- | ----------------------------------------------------------- | ------ |
| mp4-muxer  | 5.2.2    | 将 WebCodecs 的 H.264 帧封装为 MP4；moov 前置，便于分享播放 | MIT    |
| webm-muxer | 5.1.4    | 系统不支持 H.264 时，将 VP9 帧封装为 WebM                   | MIT    |

作者均为 Vanilagy。源码与许可：[mp4-muxer](https://github.com/Vanilagy/mp4-muxer)、[webm-muxer](https://github.com/Vanilagy/webm-muxer)。遵循 A-82 使用上述固定版本；上游已将后续开发迁移到 Mediabunny。本功能未引入 FFmpeg，也未复制动画参考项目的代码。几何、颜色与光照复用现有视口资源。
