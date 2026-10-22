# @brickloop/mcp

让外部智能体通过官方 MCP SDK 操作正在运行的 Brickloop。包不持有文档，不读取工程、不调用模型、不读取 Codex / Claude 的账号凭据。stdio 垫片和可选 HTTP 服务都只把工具调用转给本机宿主。

默认不启动：导入包、调用 `createMcpHostServer()` 均不监听；桌面设置明确启用后调用 `start()`。桌面弹窗、设置、真实 EditorHost、日志持久化和安装包入口由 M5-2 接入。

## 公开接口

| 导出                                                                                             | 用途                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `createMcpHostServer(options)`                                                                   | 创建惰性宿主服务，返回 `start()`、`close()`、`disconnectAll()`、`connections()`、`activity()` 和 `pipeName` |
| `McpHostOptions`                                                                                 | `pipeName?`、`host: EditorHost & DocumentsHost`、`approve(client)`、`onEvent?`、`handshakeTimeoutMs?`       |
| `DocumentsHost`、`documentSchemas`                                                               | 三个文档工具的方法和严格参数 schema                                                                         |
| `createMcpServer(options?)`                                                                      | 创建官方 SDK `Server`，可接 stdio 或自定义 MCP transport；仍经本机桥转发                                    |
| `startMcpHttpServer({ token, port?, pipeName?, timeoutMs?, onEvent? })`                          | 显式启动 IPv4 loopback Streamable HTTP；返回 `url`、`disconnectAll()`、`close()`                            |
| `generateAccessToken()`                                                                          | 宿主生成 32 随机字节的 base64url Bearer 令牌；本包不保存令牌                                                |
| `BridgeClient`、`BridgeClientOptions`                                                            | 直接桥客户端；`call(name, arguments, { signal?, timeoutMs? })` 和 `close()`                                 |
| `getMcpCallContext()`、`McpCallContext`                                                          | 在宿主工具或事务钩子内获取客户端身份、连接 ID、请求 ID 与 `AbortSignal`                                     |
| `createMcpTools()`、`MCP_INSTRUCTIONS`                                                           | 31 个共享编辑器工具 + 3 个文档工具；英文操作规则                                                            |
| `resolvePipeName()`、`BRIDGE_VERSION`、`DEFAULT_TIMEOUT_MS`、`MAX_FRAME_BYTES`                   | 端点集中配置与协议常量                                                                                      |
| `bridgeMessageSchema`、`BridgeMessage`、`BridgeRequest`、`BridgeResponse`、`BridgeError`         | 严格桥协议定义                                                                                              |
| `ClientIdentity`、`ActivityEvent`、`McpHostServer`、`McpHttpServer`、`McpEditorHost`、`HostTool` | 接入类型                                                                                                    |

`createMcpTools()` 原样使用 `@brickloop/ai.createEditorTools()` 的名称、英文描述、JSON Schema 和修改标记。MCP 层采用 SDK 低层 `Server` 的 `tools/list` / `tools/call`，避免第二次转换 JSON Schema。现有 AI 包已导出所需接口，本次不需要新增 AI 导出。

`render_views` / `compare_to_reference` 的 AI `ImageBlock` 转为 MCP `image` content；文本保留完整 `ToolResult` 包装。工具失败以 `isError: true` 加 `{ ok: false, code, message }` 返回。宿主未运行时，消息精确为 `Brickloop is not running`；列出静态工具无需宿主在线。

## 桌面宿主接入

1. 实现 `EditorHost` 的 31 个方法和 `beginTransaction(label)` / `commitTransaction()`。通过已有命令总线执行和校验，`batch.atomic` 的回滚由宿主负责。
2. 实现下表的 `DocumentsHost`。三个方法均返回 AI `ToolResult`；成功必须带 `introducedIssues: []`、`warnings: []`。文档打开与激活会改变后续工具的目标，但不修改文档内容，不创建文档撤销事务。
3. 用 `approve(client)` 接桌面确认弹窗。客户端名称和版本来自 MCP initialize，是未经认证的显示信息，不能用名称作为权限凭据；界面按普通文本显示。审批发生于首次访问宿主的工具调用，批准前无工具能读取或修改文档。每条新桥连接都经过此回调；桌面如需记忆选择，由桌面实现策略。
4. 仅在用户启用设置时启动服务；状态栏可读取 `connections()`，活动面板使用 `onEvent`。
5. 关闭设置或退出应用时 `await close()`。一键断开调用 `disconnectAll()`；如果启用了 HTTP，也调用 HTTP 的 `disconnectAll()`。已断开垫片不会自动重新申请连接，外部客户端必须重新启动 MCP 会话。

| 宿主方法              | 参数                     | 建议成功 `data`                                           |
| --------------------- | ------------------------ | --------------------------------------------------------- |
| `list_documents`      | `{}`                     | `{ documents: [{ id, name, active }], activeDocumentId }` |
| `open_document`       | `{ path: string }`       | `{ documentId, name, active: true }`                      |
| `set_active_document` | `{ documentId: string }` | `{ documentId }`                                          |

`open_document` 的路径是用户输入。宿主需沿用桌面文件打开策略、确认和工程格式检查；不得将它变成任意文件读取接口。`export_io` 继续遵守 AI 包的 `default` / `ask_host` 策略。

```ts
import {
  createMcpHostServer,
  getMcpCallContext,
  generateAccessToken,
  startMcpHttpServer,
  type McpEditorHost,
} from '@brickloop/mcp';

// editorHost 由桌面适配器提供；方法内部可调用 getMcpCallContext()?.signal。
declare const editorHost: McpEditorHost;
const mcp = createMcpHostServer({
  host: editorHost,
  approve: (client) => showExternalAgentApproval(client.name, client.version),
  onEvent: (event) => appendLocalActivity(event),
});
await mcp.start(); // 只放在设置开启分支中。

// 可选 HTTP，同样只在用户开启后运行；令牌由桌面安全保存，不写入日志。
const token = generateAccessToken();
const http = await startMcpHttpServer({ pipeName: mcp.pipeName, token, port: 32145 });

// 一键断开：停止既有会话，但继续接受需要重新确认的新会话。
mcp.disconnectAll();
await http.disconnectAll();

// 禁用/退出：关闭监听，并等待已经进入宿主的命令提交完成。
await http.close();
await mcp.close();
```

### 事务、并发与取消

宿主库在所有 MCP 连接之间串行执行全部工具，包括查询、打开文档和激活文档。每个通过参数校验且实际开始的修改调用执行一次 `beginTransaction('外部智能体：<工具名>')` 和一次 `commitTransaction()`，整个 `batch` 只有外层的一对钩子。宿主方法不能再次开启同一事务；桌面还需协调手工编辑与内置 AI 的文档锁。

参数无效、审批拒绝、排队中已取消的调用不会打开事务。宿主操作抛错或返回失败时，已开启的事务仍提交，以保留已完成修改的整体撤销能力。`beginTransaction` 必须在失败时不留下已开启事务；提交失败后本实例拒绝后续操作并返回 `HOST_UNAVAILABLE`，需桌面恢复事务后重建 MCP 宿主实例。

取消和超时会立即回答客户端、触发上下文 `signal`，阻止排队调用继续进入宿主。原有 `EditorHost` 没有 signal 参数，正在执行的宿主方法若不读取 `getMcpCallContext()`，会继续执行直到返回；库始终等实际方法和提交完成才释放队列。取消不声称回滚，不自动重试修改。宿主长期任务应读取上下文 signal，并保证最终结算，否则后续调用及 `close()` 会等待该任务。桌面可以把 signal 继续传入渲染进程任务。

## 桥协议 v1

使用本地流上的 JSON-RPC 2.0。每帧为 **4 字节无符号大端长度 + 该字节数的 UTF-8 JSON**，长度不包括前缀；最大 32 MiB。支持任意分包、粘包和多字节字符。非法 UTF-8、非法 JSON、超长帧或不符合协议 schema 的消息关闭连接，不记录原始内容。

| 消息                      | 方向                      | 结构与行为                                                                           |
| ------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `hello`                   | 客户端 → 宿主，请求       | `id`、`params: { versions: [1], client: { name, version } }`；一次协商并等待批准     |
| hello 响应                | 宿主 → 客户端             | 同一 `id`，`result: { kind: 'hello', version: 1, connectionId }`                     |
| `call`                    | 客户端 → 宿主，请求       | `id`、`params: { tool, arguments, timeoutMs }`；批准后才接受                         |
| result 响应               | 宿主 → 客户端             | 同一 `id`，`result: { kind: 'result', value: ToolResult }`                           |
| `notifications/cancelled` | 客户端 → 宿主，通知       | `params: { requestId }`；匹配正在排队/执行的请求                                     |
| `event`                   | 宿主 → 已批准客户端，通知 | `params: ActivityEvent`；仅允许的活动元数据                                          |
| `bye`                     | 双向通知                  | `params: { reason: 'closed' \| 'disconnected' \| 'shutdown' }`；断流也等同终止与取消 |

所有消息带 `jsonrpc: '2.0'`；请求 ID 为 1–128 字符的字符串，垫片使用 UUID。连接内尚未完成的重复 ID 被拒绝。协议错误用 JSON-RPC `error`：`-32001` 版本不兼容、`-32002` 宿主拒绝连接、`-32003` 未完成批准、`-32600` 重复/无效请求。工具业务失败使用 `ToolResult`，不泄漏宿主异常堆栈。

默认调用预算 60 秒，允许 1–600,000 ms。垫片总预算包含连接和审批等待；宿主另对收到的 `call` 实施预算，涵盖排队。握手默认 60 秒，宿主可用 `handshakeTimeoutMs` 调整弹窗等待。MCP SDK 的取消通知映射到桥取消通知。全宿主最多 32 条连接、64 个排队/执行调用；HTTP 最多 32 个会话，闲置 30 分钟清理。

```json
{
  "jsonrpc": "2.0",
  "id": "request-2",
  "method": "call",
  "params": { "tool": "get_selection", "arguments": {}, "timeoutMs": 60000 }
}
```

上例是帧内 JSON，不是换行分隔协议；MCP stdio 外侧的消息分帧由官方 SDK 处理。

## 端点与本机权限

- Windows 默认 `\\.\pipe\brickloop-mcp-<当前用户名>`。`koffi` 调用 Win32 API 建立受保护 DACL：仅当前进程用户 SID 可访问，同时显式拒绝网络登录 SID，并使用 `PIPE_REJECT_REMOTE_CLIENTS`。首个实例使用 `FILE_FLAG_FIRST_PIPE_INSTANCE`，已有监听时失败，绝不接管它。非阻塞字节管道转换为 Node Duplex，不依赖 PowerShell/.NET 子进程。
- 非 Windows 默认 `<tmpdir>/brickloop-mcp-<uid>/host.sock`。父目录必须为当前用户所有且权限 0700，socket 权限 0600；符号链接或宽松权限目录被拒绝，不自动覆盖已有 socket。自定义路径也必须满足这些要求，父目录由本包建立时仅建立这一层。
- `resolvePipeName(override?)` 集中处理路径；显式参数优先，其次 `BRICKLOOP_MCP_PIPE`，再其次平台默认值。Windows 只接受 `\\.\pipe\brickloop-mcp-*`，不接受远程 UNC/TCP；Unix 仅接受最多 100 字节的绝对路径。
- HTTP 只绑定 `127.0.0.1`，逐请求验证 `Authorization: Bearer <token>`（摘要常量时间比较），同时校验 Host 与 Origin。查询参数不能携带令牌；没有匿名初始化、匿名 SSE 或仅凭 session ID 访问的路径。HTTP 调用仍通过同一桥审批和事务队列。
- 管道 ACL、用户目录权限和令牌保护本机用户边界；客户端自报名字不是操作系统身份。同一用户下的其他进程属于相同本机信任边界。

## 日志与隐私

`activity()` 仅保留最近 500 条内存事件。`onEvent` 提供 `connected`、`rejected`、`disconnected`、`started`、`finished`，字段限于随机连接 ID、ISO 时间、已知工具名、结果类别和耗时。参数、结果、文档名、路径、图片、任意异常文本、令牌与客户端自报名称均不写活动日志；这是基于字段白名单的脱敏，不依赖识别所有密钥格式。

库不写磁盘日志。桌面若持久化 `onEvent`，应只在本机保存并按 06 §9 默认清理超过 7 天的记录。不要在桌面回调里重新添加原始参数、凭据或工具结果。回调抛错不会改变工具执行。外部客户端能收到它主动查询的文档数据和图片；其模型服务商与数据去向由外部客户端管理。

## 启动与客户端配置

工作区要求 Node >= 22.13，先安装依赖。入口使用已有 `scripts/devenv.mjs` 的环境配置，将临时目录和缓存放在仓库 `.devdata`；Windows 示例路径在 E 盘。入口只向 stdout 输出 MCP 消息，诊断写 stderr。

```powershell
node scripts/devenv.mjs pnpm mcp:shim
# 无包管理器输出的协议入口（外部客户端采用下面这条形式）：
node scripts/devenv.mjs node packages/mcp/bin/brickloop-mcp.mjs
```

`pnpm mcp:shim` 用于人工开发；外部 MCP 配置直接启动 Node 和 bin，避免包管理器横幅污染 stdout。bin 内部复用 devenv 环境配置且禁用 tsx 临时转换缓存。不要使用 `npx` 从网络获取本私有包。`--pipe` 和 `--timeout-ms` 可覆盖本地端点和预算；`--help` 写 stderr。

### Codex（stdio）

将以下段落合入用户自己的 `config.toml`；不要覆盖其他配置。将示例中的 `D:/path/to/brickloop` 替换为本地仓库根目录的绝对路径，入口文件为仓库内的 `packages/mcp/bin/brickloop-mcp.mjs`。字段依据 [OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp)。

```toml
[mcp_servers.brickloop]
command = "node"
args = ["D:/path/to/brickloop/packages/mcp/bin/brickloop-mcp.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 90
```

首次调用时在 Brickloop 确认连接。客户端工具超时建议大于桥预算 60 秒，留出错误响应和事务收尾时间；长任务可同时调整 `--timeout-ms` 与客户端配置。

### Claude Code（stdio）

在项目 `.mcp.json` 合入以下配置，同样将 `D:/path/to/brickloop` 替换为本地仓库根目录；也可用 Claude Code 的本地 MCP 配置界面填写相同 command / args。

```json
{
  "mcpServers": {
    "brickloop": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/path/to/brickloop/packages/mcp/bin/brickloop-mcp.mjs"]
    }
  }
}
```

### 可选 HTTP

桌面开启 HTTP 后显示实际 URL；下例假设端口固定为 32145。将宿主令牌安全传入客户端进程环境，不把真实值放入仓库或命令日志。

```toml
[mcp_servers.brickloop]
url = "http://127.0.0.1:32145/mcp"
bearer_token_env_var = "BRICKLOOP_MCP_TOKEN"
tool_timeout_sec = 90
```

```json
{
  "mcpServers": {
    "brickloop": {
      "type": "http",
      "url": "http://127.0.0.1:32145/mcp",
      "headers": { "Authorization": "Bearer ${BRICKLOOP_MCP_TOKEN}" }
    }
  }
}
```

stdio 与 HTTP 示例选择一种注册，避免同名服务冲突。切换令牌时关闭旧 HTTP 实例，再使用新令牌启动。

## 校验与交付边界

```powershell
node scripts/devenv.mjs pnpm --filter @brickloop/mcp typecheck
node scripts/devenv.mjs pnpm --filter @brickloop/mcp test
node scripts/devenv.mjs pnpm verify
```

测试使用官方 SDK 客户端启动真实 stdio 子进程，连接测试创建的本机假宿主；覆盖 34 个工具定义、查询/修改、文档工具、图片、审批拒绝、未启动、参数验证、batch 事务、串行化、超时/取消、断开、脱敏、协议分帧、版本协商、HTTP 令牌和 Host/Origin。Windows 测试直接读取实际管道 DACL 并与当前用户 SID 比对。测试不调用模型或外网。

当前开发入口是工作区 Node 脚本，依赖工作区源码、`tsx` 与公共 devenv 脚本。桌面发布打包时需生成独立入口/可执行 shim、包含相应平台的 Koffi N-API 预编译模块，并保留许可；本包不修改桌面打包配置。Unix 权限分支需在 Linux/macOS CI 上运行验证，本次 Windows 工作区不代表已完成这些平台验收。实际命令总线、弹窗、状态栏、设置、文件授权和跨内置 AI 的文档锁由 M5-2 完成。

文件：`src/tools.ts` 定义工具和规则；`protocol.ts` 定义消息与帧；`local-transport.ts` / `windows-pipe.ts` 实现本机传输；`host.ts` 实现审批、事务和活动；`bridge-client.ts` 实现桥客户端；`server.ts` / `http.ts` / `cli.ts` 实现 MCP 传输和入口；`bin/brickloop-mcp.mjs` 为启动器；`test/` 为离线测试。
