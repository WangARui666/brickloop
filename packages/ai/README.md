# @brickloop/ai

## M6-1b 桌面接入

桌面入口已在 `apps/desktop` 接入 `runImageToModel`，复用 AI 服务商、EditorHost、事务与审阅。`ImageToModelOptions` 可传入既有 `ledger`、`prices` 和 `budget.dailyCostLimit`；理解计划和各搭建轮共用同一账本，达到每日上限返回 `daily_cost_limit`。宿主在规划前提供当前数据包颜色 ID，实际放置仍强制检查零件范围、分类和色板。对比工具的 `images` 提供参考图、渲染图两个原图，`comparisonImage` 保留并排合成图。界面展示原图，`resultContent` 仅把合成图作为图片内容块交给模型，图片数据不会进入工具文本，也不会重复计入上下文。

真实评测入口为根脚本 `pnpm ai:eval --provider <openai|compatible|anthropic|gemini> --model <名称> [--base-url <地址>] [--cases <编号前缀或文本>]`，通过 `node scripts/devenv.mjs` 运行。Key 只读 `BRICKLOOP_EVAL_API_KEY`。独立 Electron 数据目录为 `.devdata/ai-eval-profile`，结束时删除；结果目录为 `packages/ai/test/ai-eval/results/<时间戳>/`，已加入忽略规则。详细运行说明与离线验收见 `apps/desktop/README.md`。

## M6-1a：看图搭建逻辑与图像对比

新增根导出 runImageToModel、structurePlanSchema、structurePlanJsonSchema、parseStructurePlan、selfCheckComplete、transitionPhase、summarizeImageModelReport，以及配套输入、事件、报告类型。英文提示词位于 src/workflows/image-to-model/prompts.ts。所有文档修改继续通过 EditorHost，所有推理通过 ModelProvider；没有新增网络或文件读写入口。

    const task = runImageToModel({
      provider, model, host: editorHost,
      input: {
        description: '红色屋顶的 6×6 小房子',
        images: [{ name: '正面', image: imageBlock, view: 'front' }],
        targetSize: { width: 6 },
        palette: { source: 'factory' },
        parts: { source: 'factory' },
        style: '先搭主要轮廓',
      },
      budget: { toolCalls: 400, durationMs: 30 * 60 * 1000 },
      directStart: false,
      onState: updateTaskCardAndDocumentLock,
    });
    for await (const event of task.events) {
      if (event.type === 'plan') showEditablePlan(event.plan);
      // 对话框确认时调用 task.confirmPlan(editedPlan)；无效编辑返回结构化 issues。
      if (event.type === 'comparison') showComparison(event.comparison);
    }
    const report = await task.result;

输入可仅有文字，也可有 1–8 张图；视角是 front/back/left/right/top/isometric/unknown。targetSize 接受任一或多个正数格尺寸，或 small/medium/large；palette 支持 factory/project/custom 与 colorIds；parts 支持 factory/categories/all 与 categories。选择限制传入模型提示，宿主仍须在工具执行时强制检查实际目录约束。工厂限制校验必须清零；允许非工厂件的输入不能让流程把未清零结果声明为通过。

计划包含 name、components 和 buildOrder。每个部件含稳定 id、name、size（宽/深/高均为格）、colors、partTypes、connections（target 部件 ID、description、可选连接器名称）。解析器容忍 JSON 代码围栏、前后说明、plan 外层对象、数字尺寸字符串、单项颜色/类型字符串，以及省略的顺序（采用部件列表顺序），并返回 repairs。重复 ID、缺少几何尺寸、不完整顺序、悬空或自引用关系仍被拒绝。模型计划最多修复三次，确认前不修改工程。

状态依次经过 understanding → preparing → building/checking（按部件重复）→ assembling/checking → finishing → finished。state 含 componentId、componentIndex、round、toolCalls、elapsedMs、paused、awaitingConfirmation、documentLocked。onState 在控制操作和收尾时也立即通知；界面需据 documentLocked 禁止手工编辑。提交失败时该标志保持 true，交由宿主恢复事务后自行解锁。

- events 是有背压的异步生成器，消费才开始任务。不能只等待 result；界面卸载前应 stop 并消费到结束，或关闭迭代器。消费方提前退出也会完成事务收尾。
- pause 在下一个模型请求/宿主工具边界阻止新操作；正在运行的原子宿主命令会完成。resume 继续，stop 和外部 signal 中止后续工作并提交已完成修改，保留整轮撤销能力。等待计划确认或暂停时 stop/时限仍有效。
- interject(text) 将补充要求按时间顺序合并进后续上下文，后来的冲突要求优先；正在返回的旧工具调用会被拒绝并交回模型重新决策。暂停状态下插话不会自动恢复任务。对计划结构的明确编辑使用 confirmPlan。
- 默认预算为 400 次、30 分钟；等待用户确认和暂停均计入墙钟时限。所有工具尝试（包括无效模型参数）、准备参考图、模型摘要和自动检查均计数；batch 外层算一次，内部沿用现有 80 操作上限。达到预算不会为报告额外调用工具。
- preparing 开始唯一的外层事务；参考图、所有部件、修改和组装都包含其中。内部复用 runAgentTurn 的模型/工具处理与 compressHistory，内部事务入口为空操作，最终只调用一次真实 commitTransaction。报告不另外调用模型。
- 每轮自动 validate → render_views → 每张参考图 compare_to_reference → get_model_summary；所有问题清零且各视角 IoU/色差质量均无超过 epsilon 的改善才结束。色差转为 1/(1+色差) 比较，默认 epsilon=0.005；无参考图只要求校验清零。未清零不会因指标停滞而退出，继续到修复、预算或用户停止。
- 每个修改轮只携带当前计划、要求、宿主摘要与最近一次渲染/对比。旧轮次工具历史不重复发送；单轮过长时复用 M5-1 压缩。完整校验/对比历史保存在报告供审阅。

### M6-1a 宿主返回数据契约

沿用 ToolResult 的 ok/data/introducedIssues/warnings 包装，以下是成功 data 的必要字段。宿主若使用其他字段名，在 EditorHost 适配器处归一化；不需要改动 core。

| 工具                 | 工作流需要的数据                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| add_reference_image  | referenceId（也接受 id）；unknown 不传 view，随后临时按 isometric 比较，报告 assumedView=true                           |
| create_submodel      | submodelId、instanceId；可选完整 modelPath，否则采用 [instanceId]。操作应已在父模型留下引用实例，组装不会再次自动实例化 |
| batch                | results 与 operations 同序，每项为完整 ToolResult；外层 introducedIssues 为汇总                                         |
| validate             | issues 为全量数组，各项至少有 kind；空数组才视为通过，缺字段不是通过                                                    |
| render_views         | images 为非空 ImageBlock 数组；根据传入 modelPath、views 渲染                                                           |
| compare_to_reference | iou 为 0–1 有限数、images 为非空对比图数组；可选 colorDifference（非负数或 null）                                       |
| get_model_summary    | 任意 JSON 摘要，建议包含 partCount、colorCount 非负整数，报告缺失时保留 null 并列为未完成统计                           |

报告包含计划、部件与宿主路径、整体最新校验、checks（每部件/每轮检查）、comparisons（每图/每轮 IoU、色差、图片和视角假设）、最近渲染、零件/颜色数、用量、预算消耗、事务状态、unfinished 和通过 i18n 生成的 summaryZh。中途停止不会把旧校验当成最终通过，也不会把未统计数值填零。界面保留/撤销/继续修改和 .io 导出仍由 M6-1b 接入；结束后可使用现有 host.export_io，工作流本身不导出文件或启动后台编辑任务。

### 纯图像对比

算法位于 src/vision/，根导出 extractForeground、silhouetteIoU、sideBySide、compareImages。选择放在 AI 包是因为掩码和对比服务于 compare_to_reference；色彩公式从 @brickloop/mosaic 复用。

extractForeground 从边缘像素的主色簇估计背景，通过 CIEDE2000 阈值（默认 12）和透明度去背景，再用四连通分量去除噪点（默认小于 2 像素或最大分量的 1%）。可显式覆盖背景、阈值、最小分量。多数边缘透明时采用 alpha 前景，避免与背景同色的可见对象丢失。返回掩码、像素数、背景和前景边界。

compareImages 要求参考和渲染具有相同像素尺寸和视角，计算前景轮廓 IoU、量化主色簇均值的 CIEDE2000 色差，以及包围盒宽高比对数差。不会独立裁切或对齐对象以提高 IoU。两张空掩码的 IoU 定义为 1，但主色差和边界比例差为 null，宿主应同时检查 pixels，不能把空白当作建模成功。复杂背景、物体贴边和阴影需要宿主调阈值或预处理，不属于语义分割。

sideBySide 接收两个 RGBA 缓冲区，可不同尺寸，顶部对齐、白色补齐，默认间隔 8 像素，保留原图 alpha。宿主负责 PNG 编码并转换为 ImageBlock；算法不访问 three.js、Electron 或磁盘。

### 测试与本轮边界

新增 test/image-to-model.test.ts 用脚本化假 ModelProvider 与假 EditorHost 覆盖 IMG-01、IMG-02、IMG-04 逻辑路径、确认、插话、暂停/停止、预算、时限、失败提交和校验拒绝；test/vision.test.ts 验证掩码、解析 IoU、主色差和 RGBA 合成。真实几何有效性、.io 互操作和界面截图由宿主集成测试负责。

既有评测集实际位于 packages/ai/test/ai-eval/：20 条文字、20 组原创图（10 单视角、10 双视角，共 30 PNG），案例定义见 cases.json，素材来源说明见 docs/third-party.md。M6-1a 不修改这批素材，不新增真实模型运行入口；主窗口把 execute 回调接到 runImageToModel 后再运行真实评测并持久化结果。本轮不提供 pnpm ai:eval、界面对话框、任务卡片或截图。

M5-1 的独立 AI 核心。核心入口不导入 Node 内建模块或 Electron；OAuth 本机回调服务器从 `@brickloop/ai/node` 导入。包不读取工程文件、不操作真实文档、不弹界面，也不保存明文凭据。宿主负责编辑器命令、加密存储、界面和用户选择。

## 公开接口

| 入口                   | 接口                                                                                                              | 用途                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `@brickloop/ai`        | `ModelProvider`、`ModelInfo`、`ModelCapabilities`、`ChatRequest`、`Message`、`ChatEvent`、`AiError`、`TokenUsage` | 统一消息、模型目录与事件流                                                      |
| 同上                   | `PublicAiError`、`publicAiError`                                                                                  | 公开错误：类别、代码、HTTP 状态、请求 ID、最多 300 字的脱敏服务商说明及结束原因 |
| 同上                   | `ModelCapabilities.contextWindow/maxOutputTokens/reasoningReplay`、`presetCapabilities`                           | 已核实模型窗口与输出上限；预设未知上限返回 null；DeepSeek 工具请求回传思考状态  |
| 同上                   | `AgentTurnOptions.maxOutputTokens`、`AgentResult.maxOutputTokens`                                                 | 请求输出上限覆盖与实际发送的上限，仍受模型、131072 和输入预算约束               |
| 同上                   | `WorkflowReport.failure`                                                                                          | 失败阶段、轮次、智能体停止原因、公开错误与尝试次数                              |
| 同上                   | `Message.providerState`、`ContextOptions.reasoningReplay`                                                         | 兼容接口思考内容状态；较早回合缺少状态时投影为确定性摘要                        |
| 同上                   | `OpenAIResponsesProvider`                                                                                         | API Key 或 ChatGPT 套餐的 Responses API                                         |
| 同上                   | `OpenAIChatCompatibleProvider`、`compatiblePresets`                                                               | 兼容接口与九个服务商/本地服务预设                                               |
| 同上                   | `AnthropicMessagesProvider`、`DEFAULT_ANTHROPIC_MODEL`、`anthropicEffortPresets`                                  | Claude Messages；默认模型为 `claude-opus-5-5`                                   |
| 同上                   | `GeminiProvider`、`ProviderOptions`、`ProviderFailure`                                                            | Gemini 与通用传输设置；模型列表失败提供脱敏的 `error`                           |
| 同上                   | `SecretStore`、`ApiKeyStore`、`CredentialError`、`maskSecret`、`redact`                                           | 宿主加密存储接口、Key 显示与日志脱敏                                            |
| 同上                   | `EditorHost`、`EditorTool`、`ToolResult`、`ToolOutput`、`ToolInput`、`ToolName`、`ValidationIssue`                | M5-2 的编辑器适配契约                                                           |
| 同上                   | `createEditorTools`、`toolSchemas`、`mutationNames`、`resultContent`                                              | 全部 31 个工具、zod / JSON Schema、图片结果转换                                 |
| 同上                   | `gridToLdu`、`lduToGrid`、坐标与矩阵 schema                                                                       | 网格/LDraw 单位换算与校验                                                       |
| 同上                   | `runAgentTurn`、`AgentTurnOptions`、`AgentBudget`、`AgentEvent`、`AgentResult`                                    | 迭代工具调用、预算、取消和事务                                                  |
| 同上                   | `buildSystemPrompt`、`compressHistory`、`estimateInputTokens`                                                     | 稳定系统提示、历史压缩、可替换的 token 估算器                                   |
| 同上                   | `InputTokenMeter`、`ContextOptions.meter`                                                                         | 可配置图片估算，按实际用量校准并复用单次投影计数                                |
| 同上                   | `priceTableSchema`、`defaultPriceTable`、`estimateCost`、`DailyCostLedger`                                        | 可编辑价格表与每日累计                                                          |
| 同上                   | `withPrivacyPolicy`、`createPrivacyFetch`、`isLoopbackEndpoint`、`writeDebugEvent`                                | 本地模式、首次图片许可、脱敏日志与保留期限                                      |
| 同上                   | `evaluationCases`、`evaluateSuite`                                                                                | 20 条文字与 20 组参考图评测、指标记录                                           |
| `@brickloop/ai/node`   | `ChatGptAuth`、`ChatGptAuthOptions`、`ChatGptAccount`、`ChatGptAuthError`                                         | 登录、账号切换、刷新、退出、套餐模型目录                                        |
| `@brickloop/ai/prices` | JSON 文件                                                                                                         | USD / 百万 token 单价，由宿主复制为可编辑设置                                   |

## 宿主接入

```ts
import { buildSystemPrompt, createEditorTools, runAgentTurn } from '@brickloop/ai';
import { ChatGptAuth } from '@brickloop/ai/node';

// secretStore 的 set 必须原子替换完整值，并由宿主加密。
const auth = new ChatGptAuth({ store: secretStore, openExternal, enabled: settings.chatGptEnabled });
const account = await auth.signIn();
const provider = auth.createProvider(account.id);
const tools = createEditorTools();
// 在会话开始时构建一次；不要在每次请求中加入日期或更新此 system。
const system = buildSystemPrompt({ modelSummary: initialModelSummary });
const turn = runAgentTurn({
  provider,
  model: selectedModel,
  system,
  history,
  userMessage,
  tools,
  host: editorHost,
  signal: abortController.signal,
});
for await (const event of turn.events) renderEvent(event);
const result = await turn.result;
```

`events` 是有背压的异步生成器，消费时才开始工作。`result` 在消费结束或跳出迭代并完成事务收尾后解析。`turn.cancel()` 和外部 signal 都会停止新请求及新工具；正在运行的宿主命令允许完成。调用方须消费或关闭事件迭代器，不能只等待尚未开始迭代的 `result`。`provider_state` 仅用于原样回传签名内容，不应显示或写入调试日志。

工具调用先累积到完整响应，检查终止事件，然后校验参数。无效 JSON/schema 以 `error` 事件的 `invalidCall` 携带可恢复的调用标识；运行时回传 `INVALID_ARGUMENTS`，不调用宿主。其他 `error` 终止本轮。所有并行调用的结果放在同一条 `tool` 消息。适配器负责转换为各家协议。

首个通过校验的修改工具前调用一次 `beginTransaction`；正常结束、取消、模型错误、消费方跳出迭代都在 `finally` 中调用一次 `commitTransaction`。只读轮次不创建事务。提交失败返回 `COMMIT_FAILED`，宿主负责显示恢复操作。

工具数默认 80，时长默认 600000 ms，单次输入默认模型上下文的 60%。工具预算耗尽时禁止继续执行工具，并在剩余时长和输入预算内请求一次中文总结；工具定义保持稳定。`batch` 算一次外层工具调用，内部最多 80 个操作。输入估算包含系统提示、工具定义、历史、图片和修复提醒；默认使用保守字节估算与图片预留量，宿主可注入精确 tokenizer。压缩替换旧工具结果、丢弃完整旧轮次，保留当前请求、近期调用结果和宿主摘要；仍超限则返回 `input_budget`。

`introducedIssues` 会持续出现在后续提示中，直到 `validate` 成功返回 `data.issues: []`。无法修复时结果中保留 `unresolvedIssues`。宿主应在审阅界面展示它，不应把模型的自然语言“完成”当作校验通过。

## EditorHost 契约

方法名与工具名一致；参数类型为 `ToolInput<'place_part'>` 等，执行结果为 `{ ok: true, data, introducedIssues, warnings }` 或 `{ ok: false, code, message, details? }`。返回值必须可 JSON 序列化。宿主异常被转换为无敏感内容的 `HOST_ERROR`。

- `x` / `z` 为格，按 0.5 格校验；`level` 为板高，正值向上。`gridToLdu` 使用 `(20*x, -8*level, 20*z)`。反向换算保留精度，不自动吸附。
- 网格 `rotY` 为 0/90/180/270；`matrix_ldu` 按 LDraw 的 `[x,y,z,a,b,c,d,e,f,g,h,i]` 顺序，负 Y 向上。任意 `rotate` 使用向上为正的轴；真实文档的矩阵和旋转换算由宿主实施。
- 宿主负责工厂目录约束、连接器查询、放置前检查、命令执行和每次修改后的增量校验。
- `batch` 委托宿主一次调用；`atomic:true` 必须全成或全败，`data` 返回逐项结果和汇总，外层 `introducedIssues` 为汇总校验。工具层不尝试通过反向命令模拟回滚。
- `render_views` / `compare_to_reference` 的成功 `data` 必须含 `images: ImageBlock[]`；可以同时含视角、IoU、色差等字段。文本结果序列化时移除 base64 图片并拆为图片内容块。
- `validate.data.issues` 是全量问题列表。空列表表示当前检查通过。
- `export_io.destination` 仅允许 `default` / `ask_host`，不接受模型给出的任意磁盘路径。宿主使用已配置目录或显示路径确认。
- 异步 `job_status` / `job_cancel` 由宿主管理。宿主必须使修改任务与本轮事务的生命周期一致。

完整工具名：`get_model_summary`、`list_instances`、`get_instance`、`get_selection`、`search_parts`、`get_part_info`、`list_colors`、`find_connection_candidates`、`place_part`、`move`、`rotate`、`set_transform`、`set_color`、`replace_color`、`delete`、`create_group`、`ungroup`、`create_submodel`、`instantiate_submodel`、`make_unique`、`batch`、`validate`、`render_views`、`compare_to_reference`、`get_bom`、`suggest_factory_substitutes`、`add_reference_image`、`make_mosaic`、`export_io`、`job_status`、`job_cancel`。

## 模型与传输

所有适配器接受注入 `fetch`、凭据字符串或异步凭据函数、可选 `baseURL` 和逐模型 `modelCapabilities`。代理由宿主提供的 fetch/transport 实施，包括系统、HTTP 和 SOCKS 代理；核心包不读取系统代理或启动代理进程。SDK 自动重试关闭，避免工具/额度错误被重复提交。

Responses 原生支持工具结果中的图片；不支持该形式的部署可配置 `toolResultImages: 'user-message'`。兼容接口总是在并行工具结果之后追加图片 user 消息。Anthropic 直接把图片放进 `tool_result`。Gemini 使用 `inlineData`。

ChatGPT 模式仅使用 Responses 与账号模型目录，固定 `store:false`、`stream:true`、`instructions`、完整 `input` 和命名空间函数工具；不发送 preview 禁止字段，不切换计费路径。`include: ['reasoning.encrypted_content']` 用于无服务端存储的推理内容回传。只有 `response.completed` 成功；额度两个错误码均为 `quota_exceeded`。

Anthropic 使用 `adaptive`、`output_config.effort`、`auto` 工具选择、顶层 ephemeral 缓存及 eager input streaming。软件快速/均衡/深入默认映射 low/medium/high；构造选项 `effort` 可进一步选 xhigh/max。默认服务端回退可关闭。完整 assistant 内容块（含思考签名）原样保留；`thinking-binding-controls-2026-08-01` 配合 `drop_block` 处理历史压缩造成的前缀变化。`max_tokens` 和 refusal 均在工具执行前截断。

兼容预设中的 `vision` / `tools` 表示该平台提供相应能力，不保证每个模型都支持。模型元数据优先来自目录；无法获取上下文大小时使用 128000 的默认值，宿主必须按选定模型覆写，尤其是 Ollama/vLLM 的实际加载上下文。平台变更 Base URL 或能力时可直接覆写构造选项。

## ChatGPT 登录细节与文档空白处理

实现依据是 `.devdata/reference/siwc/` 中的官方副本；副本不属于交付文件。端点由 `https://auth.openai.com/.well-known/openid-configuration` 发现，验证 issuer 及同源的授权/token/JWKS/revocation 端点。默认推理仍为 `https://api.openai.com/v1`。

| 项目               | 本包选择                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 回调路径、等待时间 | 固定 `/auth/callback`，每次 127.0.0.1 随机端口，默认等待 5 分钟；完成、取消、错误均关闭监听器                                                                           |
| state/nonce/PKCE   | 32/32/64 字节密码学随机值，base64url；SHA-256 PKCE；state 常量时间比较；一次消费回调                                                                                    |
| 存储布局           | 一个原子更新的 `ai:chatgpt:state` 记录包含 host ID、账号、active ID 和令牌；SecretStore 宿主负责加密、文件位置与持久化                                                  |
| 账号标识           | 验证后的 issuer + subject + clientId 对应本地 UUID；同 email 的不同注册保持分离                                                                                         |
| JWKS / JWT         | jose 缓存并按未知 kid 刷新；仅 RS256/ES256；检查签名、issuer、audience、exp、iat、nonce、azp，允许 5 秒时钟误差                                                         |
| 刷新时机           | 每次取 token 时在到期前 60 秒刷新，可配置；遵守 earliest_refresh_at；数字解释为 Unix 秒，字符串解释为 ISO 日期；无后台定时刷新                                          |
| 刷新 ID token      | 若返回则重新验签、校验同一 subject/client，若含 nonce 则匹配原 nonce；未返回时保留原 ID token 仅作登录 hint                                                             |
| 刷新 scope         | 返回 scope 时重新检查套餐权限；省略时保留原 grant，符合刷新请求省略 scope 的语义                                                                                        |
| 刷新并发           | 相同 SecretStore 实例内串行，避免旋转令牌竞态；宿主应让一个主进程拥有该账号会话，跨进程协调由宿主负责                                                                   |
| 新注册 code 失效   | `invalid_grant` 错误携带已签发的 `clientId`；宿主可用 `signIn({ registrationClientId })` 发起全新授权；不保存未经验证的账号身份                                         |
| 缺少套餐权限       | 保留验证通过的身份，标记 `planEnabled:false`，取推理 token 时拒绝；显式 `requestPlanConsent:true` 使用 `prompt=consent`，不发送未确认部署的 force_reconsent             |
| 退出登录           | 先停止该 provider 的请求；撤销刷新令牌，网络/5xx 最多三次，间隔 250/500 ms；无论远程结果如何均清本地令牌，保留注册/host ID；返回 `remoteRevocationConfirmed` 供宿主提示 |
| 功能开关           | `setEnabled(false)` 禁止登录、取 token、列模型和新推理，并中止本实例的登录/推理；不自动切换到 API Key                                                                   |
| 测试覆盖           | 生产默认 HTTPS；仅测试允许覆写到 127.0.0.1 HTTP。没有“跳过验签”选项，没有真实账号或真实密钥                                                                             |

官方补充参考：[登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[OIDC/JWKS](https://developers.openai.com/siwc/website)、[会话与退出](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[preview 限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。内部本地应用的接入资格仍由授权服务决定，D1 的关闭开关由宿主设置控制。

## 费用、隐私和评测

`prices.json` 提供标准文本/图片请求的已核对起始价格，按模型/服务商覆盖即可编辑。缓存写入单价可单独配置。ChatGPT 套餐仅显示“使用套餐额度”。未知模型费用为 `null`，不当作免费；配置每日上限时必须有该模型价格和 `DailyCostLedger`。宿主持久化 `ledger.snapshot()`，并共享同一账本。每日按 UTC 结算，跨午夜的一轮计入开始日；上限用于拒绝下一轮，不能截断已发生的服务商消费，也不能对并发请求提供预扣款保证。

价格来源（2026-10-16）：[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5)、[Gemini](https://ai.google.dev/gemini-api/docs/pricing)。估算不包含长上下文阶梯加价、优先服务、缓存储存费或托管工具收费。

本地模式应同时使用 `withPrivacyPolicy` 和 `createPrivacyFetch`：前者在发送模型请求前检查服务商及首次云端图片许可，后者拒绝非 127.0.0.1/::1 地址并禁止 HTTP 重定向。提供方/模型和数据去向由宿主界面显示。`writeDebugEvent` 只记录事件类型、用量或脱敏错误，不记录请求内容、图片和签名；由本机 `LocalLogStore` 清理超过 7 天的记录。历史是否保存、图片资源哈希和工程打包属于 M5-2 宿主工作。

`test/ai-eval/cases.json` 含 20 条文字和 20 组图片需求。30 张 PNG 为本包自行生成的几何参考图（10 组单视角，10 组双视角），无外部素材。`evaluateSuite` 接受宿主执行/测量与保存回调，记录碰撞、连通分量、工厂约束、IoU、色差、件数、时间与费用。真实文档/真实模型评测需 M5-2 接入后执行，不能把这里的假响应测试当作建模有效率。宿主可保存到 `test/ai-eval/results/`；本包不擅自写工程或评测目录。

## 验证与文件布局

```powershell
node scripts/devenv.mjs pnpm --filter @brickloop/ai test
node scripts/devenv.mjs pnpm verify
node scripts/devenv.mjs pnpm exec tsx --no-cache packages/ai/scripts/generate-eval-references.ts
```

测试禁用默认外网 fetch；四家 SDK 走注入的 SSE/JSON 夹具。OAuth 测试只允许 127.0.0.1，使用临时 RSA 密钥与本地假服务器完成真正的 PKCE/JWKS 流程。没有 live smoke 脚本，也没有自动读取真实 API Key 的路径。

- `src/types.ts`、`src/secrets.ts`、`src/coordinates.ts`：统一契约、安全存储、坐标。
- `src/providers/`：四种官方 SDK 适配器及错误分类。
- `src/tools/`：31 个 zod schema、英文描述及宿主分派。
- `src/agent/`：循环、系统提示、历史预算和压缩。
- `src/node/`：OAuth 和 Node 专属导出。
- `src/cost.ts`、`prices.json`、`src/privacy.ts`：价格、账本、隐私接口。
- `src/evaluation.ts`、`scripts/generate-eval-references.ts`、`test/ai-eval/`：评测定义、可再生参考图。
- `test/*.test.ts`、`test/helpers.ts`：离线回归测试。

M6-1a 按决策 A-19 同步更新了根 `pnpm-lock.yaml`；包的直接依赖均精确固定。合并时一并保留锁文件更新，再执行 frozen-lockfile 安装。
