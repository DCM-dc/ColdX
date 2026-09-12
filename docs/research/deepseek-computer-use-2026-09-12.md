# DeepSeek 原生视觉与 ColdX 浏览器操作

核对日期：2026-09-12。本文区分官方公开能力、本地已安装代码和真实验证结果。

## 官方能力边界

1. 当前 `deepseek-flash` 支持图片输入。旧 `deepseek-v4-flash-vision-exp` 名称被最新 Flash 承接。支持 PNG、JPEG、GIF、WebP，适合读取截图；`detail: low` 会缩小到 512×512，不能把这种低分辨率图片的坐标直接当成原始视口坐标。[官方图像理解](https://api-docs.deepseek.com/zh-cn/guides/vision/)
2. Responses API 能把工具返回的图片放进 `function_call_output.output`；但 `computer_use`、`mcp`、`web_search` 等内置工具会被忽略。视觉理解和鼠标键盘执行是两层能力，接入模型名称本身不会增加电脑驱动。[官方 Responses 支持表](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
3. Function Calling 只生成工具请求，函数由宿主执行。思考模式可以调用工具；无需另造一个 ColdX agent loop。[官方 Tool Calls](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/)
4. DeepSeek 的“接入 Agent”入口现在指向 Harness 官方站点。[官方 Harness 入门](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)
5. DSH 原生 MCP 插件把工具注册到 `ctx.tools`，支持 stdio、HTTP、取消、超时、断线处理以及附件图片结果。没有默认启用的 MCP 服务。它是工具桥，不是网页 WebMCP 执行器。[官方 MCP 插件说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)
6. Microsoft 的 Playwright MCP 提供 DOM、截图、坐标、键盘等浏览器操作。其公开 `createConnection(config, contextGetter)` 可接入宿主创建的浏览器上下文；不能由此宣称已获得操作系统桌面的控制能力。[官方项目](https://github.com/microsoft/playwright-mcp)、[公开 API](https://github.com/microsoft/playwright-mcp/blob/main/index.d.ts)

## 采用的链路

`ColdX 当前 DSH Agent → coldx_browser → agent.ctx 内原生 dsh-mcp-client → 独立 stdio Playwright MCP → 官方 Chromium headless shell → 原生 image attachment → 模型及工作面板`

- 固定 `@playwright/mcp@0.0.80`，其上游固定 Playwright `1.63.0-alpha-2026-08-31`；来源为官方 npm 发行包，不依赖 Codex 内部插件或运行库。
- 每个 Agent 独立 MCP 连接、Chromium 进程和内存 context。没有读取现有浏览器 profile、登录态、用户桌面或连接外部 CDP。
- 初始只公开 `coldx_browser`。调用后当前 Agent 得到 14 个浏览器工具：导航/后退、结构/截图、控件点击/输入/下拉选择、键盘、坐标点击/移动/拖动/滚动、标签页、关闭。
- 默认不注册任意 JavaScript、Node 执行、Cookie/存储导出、网络任意请求和上传工具。导航入口只允许 HTTP(S) 或 `about:blank`；截图支持安全的单层 PNG/JPEG/WebP 文件名，拒绝路径、冒号、保留设备名等。MCP cwd 与当前会话的 `.coldx/browser/<session-hash>` 输出目录一致。
- 这是能力裁剪与会话隔离，不是针对恶意网站的完整 OS 沙箱。网页内容仍须作为不可信数据；不应将网页文字升级为系统指令。
- DSH 已装原生 Chat Completions 适配器会将工具图片映射为相应工具结果之后的 user 图片块，保留调用顺序，符合 DeepSeek 图片角色限制。没有更换当前模型/密钥/推理档位。

## 实现位置

- `plugin/computer-preset.mjs`：固定公开工具清单、隔离输出目录、运行时安装检测、参数边界。
- `plugin/browser-driver.mjs`：公开 Playwright MCP API 的 stdio 入口，创建新的 Chromium 内存 context，关闭 context 时同时关闭所属 browser。
- `plugin/computer-host.mjs`：原生 bootstrap、权限 guard、工具事件观察、关闭/取消、截图只读预览。
- `lib/profile.mjs`：全局 Host 挂载，使第一次模型请求即能发现 bootstrap。
- `patches/@deepseek-ai__dsh-mcp-client@0.1.1-rc.2.patch`：新增可选精确 `allowedTools`；namespace 由原生 `scopeOf(ctx)` 限定。省略 allowlist 的普通 MCP 行为保持不变。
- `scripts/install-browser.mjs` 和 `pnpm computer:install`：运行此固定 Playwright 的官方浏览器安装器。桌面 stage 同步携带脚本及 npm 锁定依赖。

当前 Windows 机器下载的完整 Chrome for Testing 在进程启动时返回 `spawn UNKNOWN`，同版本官方 `chromium.launch({headless:true})` 能运行 headless shell。因此通过公开 `contextGetter` 提供已经独立创建的 context，避免 MCP CLI 的完整 Chrome 频道覆盖。MCP 0.0.80 的该公开适配器要求 `isolated:false`，因为 context 已由宿主隔离；这不代表使用持久 profile。

## 工作面板接口

- `coldxComputer/read({agentId,request:{afterRevision,waitMs}})`，`waitMs` 为 0–20000。
- `coldxComputer/close({agentId,request:{}})`，只关闭该 Agent 的浏览器。
- 子会话使用 `readChild` / `closeChild`，传 `{address:{parentSessionId,childSessionId,mode},request}`。复用原生目录归属校验，不绕过 generic Agent resolver、不恢复子 Agent。
- 结果包含 `{version:1,revision,enabled,available,connected,browserOpen,records}`。`connected` 表示驱动已经连接；`browserOpen` 表示有实际成功操作后的浏览器状态。
- 每条记录关联真实 `callId`、状态、时间和可选 `{previewAttachment:{mime,base64}}`。只读取真实结果已保存的原生附件，不因 UI 轮询再次截图或增加模型上下文。单会话保留最近 24 条操作、最近 2 张预览；源附件仍由 DSH 管理。
- 面板记录是当前 Host 生命周期内的观察缓存，重启不会恢复浏览器登录态或重新执行历史操作。模型会话中的附件/原生工具事件由 DSH 持久保存。
- 上游截图工具指定 `filename` 时仅返回导出文件链接，省略时才返回图片。bootstrap 已明确这个区别：视觉推理和面板截图应省略文件名；导出文件时可以传安全 basename。没有把文件链接冒充图片结果。

## 已运行的验证

`node --test test/computer-native.test.mjs test/desktop-stage.test.mjs test/profile.test.mjs`：18/18 通过，其中：

- 两个 Agent 使用相同稳定 namespace，工具实现和连接互不相同；没有全局泄露 MCP 工具。
- 子 Agent 未启用自己的浏览器时无法操作父连接；冒充另一个父会话不能关闭子浏览器；合法子关闭不影响父浏览器。
- 本地测试页真实坐标点击后文字改变；截图成为原生 image attachment；RPC 返回 PNG 与保存附件逐字节一致；关闭后可再次打开。
- 指定安全文件名的截图真实保存于本会话输出目录，路径/设备名被拒绝；导出与图片返回两种上游语义分别验证。
- 真实 DSH agent loop 与本地 fixture provider 验证：第一轮只有 bootstrap，下一轮请求自动含截图等新增工具，无需重建 Agent。该项不调用付费模型。
- 桌面 stage 精确复制安装脚本并保留现有原生 patch 应用机制；npm lock 含相同 MCP 与 Playwright 固定版本。

真实 DeepSeek 对截图的识别与自主点击由主任务另行验收。本文不将确定性驱动测试称为模型视觉成功，也不宣称已验证 macOS/Linux 原生桌面操作。
