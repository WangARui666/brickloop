# Brickloop 桌面外壳

## 看图搭建与马赛克（M6-1b）

AI 助手的“按参考图生成”和“工具 → 按参考图生成…”使用同一输入对话框。图片可拖入、粘贴或选择文件，每张可设置视角；也可只给文字。计划表支持编辑、增删、拖动和键盘按钮排序。运行时任务卡固定在 AI 助手顶部，输入框发送补充要求，暂停/停止沿用同一个宿主事务与手工编辑锁。停止保留已完成工作，审阅条可整轮撤销。报告中的“导出 .io…”打开现有导出流程。

“工具 → 马赛克…”在 Worker 中计算预览，只使用当前数据包中的普通矩形平滑板或 1×1 圆板及实际可生产配色；新子模型连同当前模型中的引用一次提交。尺寸上限为 256×256 格。圆板不参与相邻格合并；生成的是平面图案，不自动添加底板。

离线验收使用 `e2e/image-model.spec.ts` 的本机假模型，包含 IMG-01、IMG-02、IMG-04、IMG-05（使用 IO 包读回）与 MOS-01。`e2e/ai.spec.ts` 同时覆盖 M5-2 的界面修正。两种窗口尺寸的正式截图位于 `evidence/m6-1b/`，截图等待有限动画结束。

从仓库根目录运行真实评测（必须先在当前 PowerShell 会话中设置 `BRICKLOOP_EVAL_API_KEY`，不要把 Key 放进命令行）：

```powershell
node scripts/devenv.mjs pnpm ai:eval --provider openai --model <模型名称>
node scripts/devenv.mjs pnpm ai:eval --provider compatible --model <模型名称> --base-url http://127.0.0.1:11434/v1 --cases text-01,image-
```

支持 `openai`（Responses）、`compatible`、`anthropic`、`gemini`。`--cases` 用逗号分隔，匹配案例编号前缀或需求文本；省略时执行全部 40 例。入口复用 Electron 测试构建和启动方式。每个案例新建文档，使用 400 次/30 分钟预算并跳过计划确认；图片由该次显式评测命令授权发送到所选服务商。Key 仅在主进程从环境变量读取，不保存到提供商配置，不进入日志、结果或参数。

临时用户数据固定为 `.devdata/ai-eval-profile`，正常完成和异常退出的清理路径都会删除它；如果该目录已存在，入口会报错以保留其中的数据。结果写入 `packages/ai/test/ai-eval/results/<时间戳>/results.json` 和 `summary.md`，包含有效率、连通分量、各视角 IoU/色差、件数、颜色数、耗时、费用和停止原因。未知价格的费用为 `null`（摘要显示 `unpriced`），不会按零费用处理。真实效果评测需要用户自行运行；自动测试只使用本机假模型和临时合成凭据。

本包提供 Electron 主进程、沙箱 preload 和 React/Ant Design 工作区。零件库、色板、数据包管理和真实零件预览已接入；预览不修改工程。编辑命令继续禁用，放置属于后续编辑功能。

## 安装与运行

在仓库根目录运行：

```powershell
pnpm install
pnpm verify
pnpm -F @brickloop/desktop build
pnpm e2e
pnpm dev
```

也可使用 `pnpm setup` 安装。首次运行普通 `pnpm install` 就会准备 Electron，无须手工设置环境变量。Electron 44 的 npm 包移除了自动下载二进制的安装脚本；根 `postinstall` 通过 `scripts/devenv.mjs` 显式运行官方 `electron/install.js`，安装器会复用已安装版本和下载缓存。

`.npmrc` 注册的 `scripts/pnpmfile.cjs` 在依赖安装前调用同一环境函数，设置临时目录，并合并根 `package.json` 与既有工作区的构建脚本白名单。目前只允许 Electron 和 esbuild。

所有路径根据仓库位置计算，脚本没有写死盘符。仓库位于 E 盘时，以下数据均留在 E 盘：

| 用途                  | 仓库内路径 / 环境变量                                |
| --------------------- | ---------------------------------------------------- |
| Electron 下载缓存     | `.devdata/electron-cache` / `electron_config_cache`  |
| 工具临时文件          | `.devdata/tmp` / `TEMP`、`TMP`、`TMPDIR`             |
| Node 编译缓存         | `.devdata/node-compile-cache` / `NODE_COMPILE_CACHE` |
| Playwright 浏览器缓存 | `.devdata/playwright` / `PLAYWRIGHT_BROWSERS_PATH`   |
| Vite 开发缓存         | `.devdata/vite-desktop`                              |
| 开发用户数据          | `.devdata/dev` / `BRICKLOOP_DATA_DIR`                |
| E2E 用户数据          | `.devdata/e2e/case-*`，每用例隔离，结束后清理        |
| 单元测试临时数据      | `.devdata/desktop-unit/settings-*`，结束后清理       |
| 构建输出              | `apps/desktop/out`                                   |
| 截图、测试日志与报告  | `apps/desktop/test-results`                          |

E2E 使用已安装的 Electron，不需要运行 `playwright install` 下载独立 Chromium。`test-results`、构建输出和 `.devdata` 均被 Git 忽略。

## 进程与设置

- 主进程负责文件读写和设置。`resolveDataDirectory` 是纯函数，优先使用 `BRICKLOOP_DATA_DIR`，否则使用 `%APPDATA%\Brickloop`。在 Electron 初始化前设置 `userData`、`sessionData`、日志和崩溃目录。
- `settings.ts` 提供纯编解码函数；`settings-file.ts` 负责文件适配。`settings.json` 保存 `language`、可选的 `activePackId` 和 `favoriteColors`，兼容旧设置。写入同目录临时文件后重命名，串行处理连续保存。损坏文件重命名为 `settings.corrupt-<时间>-<UUID>.json`，保留原始字节，再恢复中文默认值。其他读写错误不冒充文件损坏。
- `shared/api.ts` 定义 IPC 通道、API 类型与参数校验；主进程同时校验调用者必须为当前窗口的主框架。
- preload 是独立 CommonJS 文件，暴露 `window.brickloop` 的已校验应用与目录接口，以及 `brickloopMeshRequest` 消息端口请求。没有任意通道或文件路径访问接口。启用 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`；禁止新窗口、页面导航、webview 和权限请求，并设置 CSP。
- 应用内菜单负责语言切换；渲染进程中的 Zustand 保存界面状态。语言成功写盘后，i18n、Ant Design locale、窗口标题与页面 `lang` 同步更新。重启时从磁盘恢复语言。
- 主进程、preload 与渲染进程有各自的 strict tsconfig。目录包公开入口的类型解析需要 Node 类型声明；渲染器只使用 `import type` 引入目录/几何类型，不包含 Node 运行时代码。聚合 `tsconfig.json` 供根 ESLint 配置分析整个包。
- `theme.ts` 集中定义设计令牌及 Ant Design 映射；CSS 只引用颜色变量。左右面板支持折叠、拖动调整宽度和分隔条方向键调整。

## 验证

`pnpm verify` 会通过根脚本自动检查本包类型、lint、格式、多语言键以及单元测试。`pnpm -F @brickloop/desktop test` 可只运行桌面单元测试。

`pnpm e2e` 独立构建后运行 Playwright `_electron.launch`。UI-01 覆盖空目录首次启动、中文菜单与状态栏、实际进程安全参数、面板占位/折叠/调整宽度和最小窗口；UI-02 覆盖菜单中切换中英文、两种语言的写盘及重启恢复，并分别保存截图。它不会下载额外浏览器或关闭其他 Electron 应用。

Windows 分数缩放可能让 `BrowserWindow.getSize()` 的读数相对配置值多一个 DIP；测试只对默认尺寸容许 1 DIP 舍入，最小尺寸和安全配置仍严格断言。

## 零件库与数据包

`main/library-paths.ts` 集中配置开发库 `library/ldraw`、开发示例包 `library/packs/demo`，安装后分别使用 `process.resourcesPath` 下的 `library/ldraw`、`library/packs/demo`。目录、网格、缩略图缓存位于用户数据目录的 `cache/catalog`、`cache/mesh`、`cache/thumb`；`pnpm dev` 对应 `.devdata/dev/cache`。导入包存入用户数据目录 `packs`，保证安装目录和仓库内置示例包只读。缺少库时显示获取命令和中文引导。

IPC 通道及运行时校验集中在 `shared/api.ts`、`shared/library-api.ts`。主进程通过公开 `CatalogService`、`PackStore`、`importPack`、`diffPacks`、`exportTemplate` 接口提供服务。导入先返回校验报告和差异，确认后写入已审阅的数据快照；导入源由原生对话框选择，渲染器只持有会话标识。XLSX 入口读取所选文件所在的完整模板目录，需要同目录的 `pack.json`、`parts.xlsx`、`colors.xlsx`。导出空白/当前模板使用 `.brklpack`，其中含可编辑的 XLSX 文件。

`main/mesh-worker.ts` 在 Node Worker 内解析网格，并使用 `createMeshCache` 校验完整依赖内容。Worker 使用 transfer list 转移独立 ArrayBuffer。Electron 的 `MessagePortMain.postMessage` 仅支持转移 MessagePort，主进程到页面仍有一次结构化复制；端口直达页面避免再次经过 contextBridge 复制大数组。一般调用者仍可使用 `brickloop.meshGet`，视口使用 `mesh-client.ts` 的端口通道。这里不宣称主进程到页面实现了零复制。

缩略图使用一个离屏 128×128 渲染器，统一三分之四视角、透明背景和 LDraw 71 号中性浅灰。键只包含 PartId、依赖网格哈希与缩略图版本，不随当前色变化。队列去重，滚动时暂停新图生成；PNG 由主进程校验并原子写入。内存只保留最近 128 个网格和 512 张缩略图。网格使用 76px 宽、76px 图格（内含 64px 图），下面独立两行名称，固定行高虚拟滚动。

`@brickloop/viewport` 的 `setParts` 按 PartId / ColorId 合并 InstancedMesh，固定色面另建材质批次。普通边线按 LDraw 边线色绘制并合并；暂不绘制条件边线。透明色使用 alpha 混合，金属、镀铬、珠光、橡胶、夜光使用不同材质参数；尚无环境反射贴图或闪粉/斑点微表面纹理。

`e2e/library.spec.ts` 覆盖真实 3001 搜索/几何/缩略图/换色、收藏设置、模板保存、含一处错误的包显示第 4 行、忽略错误行后的差异与导入、切回示例包以及全库虚拟滚动采样。两种内容区尺寸的截图为 `test-results/screenshots/m1-3-1440x900.png`、`m1-3-1100x700.png`，性能记录为 `test-results/m1-3-performance.json`。端到端测试只替换原生对话框的选定路径，其余校验、导入、写盘和渲染使用正式接口。

## 文档编辑与投影

`renderer/src/document-store.ts` 持有唯一的 `DocumentSession`。编辑通过 `dispatchEdit` 或 `begin → executeCommand(transactionBase) → preview → commit/cancel`，选择和按出现隐藏通过工作区更新。数值输入使用世界坐标；核心负责换回当前子模型局部坐标。工具/选择变化结束按键合并。主窗口后续保存成功时调用 `documentSession.markSaved()`，不要自行改 dirty 标记。保存、复制与文件读写仍由后续文件工作流接入。

`packages/viewport/src/document-projection.ts` 使用公开 `expandInstances` 展开共享定义。每个 PartId / ColorId 保持一个 InstancedMesh（固定色面为几何组和材质数组），容量按需倍增。矩阵、实例颜色及边线矩阵只上传变化的槽位；边线使用实例化几何。拾取先测出现包围盒，再用定义级 three-mesh-bvh 局部射线，返回完整路径。遮罩按所选出现压紧，仅渲染实际选中/悬停的实例；屏幕膨胀宽度为选择 2 CSS px、主选 3 px、悬停 1 px / 50%。

左键选择/框选，Alt+左拖旋转视图，中键/右拖平移；右键单击打开菜单。放置按包围盒顶面或地面确定支撑高度，向上对齐竖直步长以免穿入支撑。例如两块 3001 在板高档叠放的原点高度为 -24 / -56 LDU；这是包围盒与网格放置，未做凸点连接求解。Shift+单击连续放置，Esc 取消。连接与碰撞、已连接选择不在本轮范围。

桌面形状分类与排序位于 `shared/catalog-categories.ts`，不改目录包公开接口。`main/catalog-cache.ts` 在用户目录 `cache/catalog/desktop-snapshot.bin` 缓存目录、色表与已解析示例包。热启动核对配置/目录/示例包元数据后直接读取快照；启动后再做完整目录源检查，发现库内原位修改会刷新服务与缓存，零件库面板刷新后显示新结果。

`pnpm e2e` 使用 `--mode test` 构建；仅此模式载入 `editor-test-api.ts`，提供测试快照、坐标投影和性能夹具。普通开发和正式构建不暴露该接口。`e2e/editor.spec.ts` 实际操作鼠标、工具栏、属性输入和快捷键，验证放置/叠放、移动和旋转手柄事务、Esc、按键合并、¼ 格、颜色、隐藏、删除、框选、共享编辑与保存点标题。性能测试分别测场景内移动单件与 1,000 件批量移动；保留实际帧间隔和更新/提交耗时，不将机器负载相关计时作为单元测试断言。

`pnpm perf` 默认将结果写入 `.devdata/perf-results/`。需要更新私有仓库的 `docs/perf/data` 时，在仓库根目录的 PowerShell 会话中先设置 `$env:BRICKLOOP_PERF_OUTPUT = Join-Path (Get-Location) 'docs/perf/data'`，再运行 `pnpm perf`；完成后用 `Remove-Item Env:BRICKLOOP_PERF_OUTPUT` 清除覆盖设置。

交付记录位于 `test-results/m2-3-verify.txt`、`m2-3-e2e.txt`、`m2-3-performance.json`；截图位于 `test-results/screenshots/m2-3-*.png`，包括 1440×900 / 1100×700 放置预览、选中描边、移动/旋转手柄和属性面板。

## Windows 内部发行包（M7-2a）

在仓库根目录运行 `pnpm package`。命令通过 `scripts/devenv.mjs` 依次正式构建桌面应用、裁剪并校验资源、生成许可清单、调用 electron-builder，再核对免安装目录中的资源哈希。正式构建没有 `brickloopEditorTest` 测试接口。

| 内容                             | 位置                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| 正式应用构建中间文件             | `dist/desktop/out/`                                                     |
| 裁剪资源与逐文件 SHA-256 清单    | `dist/packaging/resources/`、其中的 `resource-manifest.json`            |
| 中文 NSIS 安装程序               | `dist/Brickloop-0.12.6-win-x64-setup.exe`（文件名随桌面包版本变化）     |
| 免安装目录                       | `dist/win-unpacked/`，直接运行 `Brickloop.exe`                          |
| 大小及资源校验报告               | `dist/package-report.json`                                              |
| electron-builder / NSIS 下载缓存 | `.devdata/electron-builder-cache/`                                      |
| Electron / npm 下载缓存          | `.devdata/electron-cache/`、`.devdata/npm-cache/`                       |
| 临时文件、Node 与其他工具缓存    | `.devdata/tmp/`、`.devdata/node-compile-cache/`、`.devdata/tool-cache/` |

安装程序提供简体中文界面，可选择安装目录，仅为当前用户安装，创建开始菜单和桌面快捷方式。安装完成后不自动启动应用。卸载不删除用户工程或用户数据。注册 `.brkl` 与 `.brklpack` 的打开命令，Windows 将所选文件的带引号路径传给 `Brickloop.exe`。

当前发行包不做代码签名。Windows SmartScreen 可能显示“Windows 已保护你的电脑”，发布者显示“未知发布者”。确认文件来自 GitHub Releases、且 SHA-256 与同一版本附带的 `SHA256SUMS.txt` 一致后，点击“更多信息”→“仍要运行”。如果组织策略不提供“仍要运行”，联系管理员处理。无需关闭 SmartScreen。校验命令示例：`Get-FileHash -Algorithm SHA256 .\dist\Brickloop-0.12.6-win-x64-setup.exe`。

打包资源从 `process.resourcesPath` 解析，布局为 `resources/library/ldraw/`、`library/packs/demo/`、`library/connectors/`、`library/colliders/`、`library/macros/`、`fonts/`（两份 OTF、fonts.json 与 OFL）。内置资源只读；开发环境的库路径保持不变。`resource-manifest.json` 记录逐文件大小/哈希、分类汇总和排除项目。汇总不包含清单自身，避免自引用。除后缀检查外，还检查 PE/ELF/Mach-O 魔数；XLSX、`.brklpack` 和 `.brklmacro` 内部成员同样检查，不会将工具 ZIP 混入数据资源。`node scripts/devenv.mjs node scripts/release-checks.mjs` 验证改名二进制、归档嵌套与正常数据包边界。

关于页通过受限 IPC 读取 resources/licenses.json，显示依赖、LDraw 署名和 Noto Sans SC OFL。打包时与 docs/third-party.md 及原始许可正文核对。

运行 `node scripts/devenv.mjs node scripts/packaged-smoke.mjs`，仅启动 win-unpacked。覆盖零件库、放置、brkl 保存、IO 包读回 io、宏与图案、中文 PDF 字体嵌入、关于许可、AI 设置、首次与第二次进程文件投递、MCP 发布配置和含空格路径。正式构建不使用编辑器测试接口；独立用户数据结束后删除，报告与导出文件保留到 dist/release-evidence。不会安装、注册关联或创建快捷方式。

主进程已处理首次启动参数与 second-instance 文件投递；brkl 自动打开，同一文件切换已有标签，brklpack 进入审阅。实际安装、Windows 双击文件关联与卸载由用户人工验收。

正式配置在 `%APPDATA%\Brickloop`，恢复与缓存在 `%LOCALAPPDATA%\Brickloop`；旧数据支持迁移及失败回退。开发和测试用 `BRICKLOOP_DATA_DIR` 隔离配置，`launchElectron` 要求它是绝对路径。

## M5-2 AI 与外部智能体

主进程 `ai-service.ts` 运行 `runAgentTurn`、服务商适配器、ChatGPT OAuth、加密凭据、额度账本与 MCP 宿主。`editor-host.ts` 仅通过受信任窗口的请求/响应 IPC 调用渲染进程。`ai-editor-host.ts` 使用真实 `DocumentSession`、core 命令总线和连接/碰撞检查；AI 与 MCP 共用这个宿主，不复制文档作为另一个权威状态。

Ctrl+K 打开 AI 助手；设置菜单或面板齿轮进入 AI 设置。API 密钥只经安全桥写入 Electron `safeStorage`，后四位以外不返回界面。每个服务商使用独立、无持久化的 Electron 网络会话，支持系统代理及 HTTP/SOCKS。ChatGPT 使用 M5-1 OAuth，不读取其他客户端的凭据，不在额度用尽时自动切换计费方式。

AI 请求开始即锁定文档；视口仍可旋转。首个修改调用开启唯一事务，所有修改在同一 `DocumentSession` 累积；停止时提交已完成修改。审阅撤销只在该事务仍为最新事务时可用，避免撤销后续人工修改。原子批量失败只回滚本批，保留本轮之前已完成的命令。

所有 31 个工具及 3 个文档方法由相同宿主处理。当前工具都在调用内完成，没有后台任务；查询/取消不存在的任务返回 `JOB_NOT_FOUND`。`export_io` 始终打开既有导出保存对话框，`destination: default` 在尚未配置默认输出目录时同样要求选择位置。参考图和渲染结果按 SHA-256 资源引用保存，工程包含 `ai/history.jsonl`；关闭记录开关后不再追加记录。图像对比拒绝空前景，不把两张空白图判为建模成功。

MCP 默认关闭，在「设置 → 外部智能体」启用；设置页按当前路径生成 Codex/Claude Code 配置。开发入口是 `packages/mcp/bin/brickloop-mcp.mjs`，可运行 `node scripts/devenv.mjs pnpm mcp:shim`。发布构建额外生成 `out/main/mcp-shim.js`，安装包根目录的 `brickloop-mcp.cmd` 使用随应用发布的 Electron Node 模式运行它，不需要系统 Node。设置页直接生成 Brickloop.exe 与发布 mcp-shim.js 参数，并设置 ELECTRON_RUN_AS_NODE=1；避免 cmd 的二次引号处理，支持含空格安装路径。原生 Koffi 模块作为运行时依赖解包。可选本机 HTTP 需先生成访问令牌，只有显式启用才监听。

离线验收：`node scripts/devenv.mjs pnpm verify` 和 `node scripts/devenv.mjs pnpm e2e`。`e2e/ai.spec.ts` 启动本机 OpenAI 兼容假服务，覆盖 AI-03–AI-08，使用合成凭据、独立用户数据目录、真实渲染进程和官方 SDK stdio 客户端。截图位于 `apps/desktop/evidence/m5-2`，包含 1440×900 与 1100×700 两种尺寸。此测试不验证真实服务商或 OAuth 账号可用性。

手动验证 AI-01/AI-02：在主窗口添加自己的服务商，测试连接并选择模型；启用 ChatGPT 登录后在系统浏览器授权，确认账号、动态模型列表、套餐提示和一次流式回复。验证多账号切换、退出、额度错误提示、图片首次发送许可及实际网络代理。ChatGPT 登录的授权资格由 OpenAI 决定；拒绝时保留功能开关和用户主动配置 API Key 的入口。发布安装包的入口、原生模块与安装路径仍应执行安装包冒烟验证。

使用说明截图单独运行 `node scripts/devenv.mjs pnpm docs:screenshots`，不纳入默认 e2e。无 win-unpacked 时加 `--grep-invert MCP` 跳过发布版一组，打包后用 `--grep MCP` 重拍；68 张 PNG 位于 docs/user-guide/images，清单与人工验收见 docs/user-guide/screenshots.md 和 docs/release/0.12.6.md。
