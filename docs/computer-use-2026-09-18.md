# ColdX 电脑与浏览器操作

## 交付范围

工作面板增加独立的“浏览器”和“电脑”页。浏览器支持地址栏、标签页、后退、前进、刷新、截图、人工接管和停止。电脑页支持 Windows 10/11 已运行应用的窗口列表、聚焦、可见窗口截图、点击、双击、拖动、滚轮、Unicode 文字输入和快捷键。模型通过原生 DSH 工具使用这些能力；没有另建模型循环。

截图可在适合宽度与 100% 原尺寸间切换，原尺寸使用滚动条或聚焦容器后的方向键查看。缩放仅改变本地视图，不请求额外截图。人工接管后可点击或拖动画面、使用键盘，也可先点击输入框，再用下方文字框键入中文。画面在操作完成后更新，不是视频流。

接管会先阻止新的模型动作，等待正在执行的有界操作结束并更新观察，界面在此期间显示“等待当前操作完成”。“停止”会立即取消排队和正在执行的宿主操作，并释放自有 helper / 独立浏览器；停止桌面控制不会退出用户软件。

本版的原生桌面输入后端仅支持 Windows。macOS/Linux 明确显示桌面能力不可用，仍可使用独立浏览器。窗口列表只包含正在运行的应用；未提供任意可执行文件启动器。微信、Blender 的指南按观察到的进程加载，描述联系人核对、编辑区与模式、结果验收等操作逻辑；未对用户私人微信或 Blender 文件进行实测。

## 归属与观察

- 每个会话使用独立浏览器上下文，不读取用户已登录的 Edge/Chrome 配置。
- 同一 ColdX 后端进程只有一个物理桌面控制持有者，所有动作串行；不同会话不能相互输入。
- 桌面输入绑定窗口句柄、进程、窗口位置与最新 observationId。窗口位置或前台变化时，旧观察失效。人工点击 ColdX 控件导致前台变化时，只恢复已核对身份和位置的原目标。
- 坐标基于截图原始像素，界面缩放不会改变工具坐标。点击与滚轮会检查目标位置是否被其他窗口覆盖。
- 图像是当前可见屏幕的窗口区域，遮挡会出现在截图中。辅助 UI Automation 信息有数量、深度和遍历限制，不读取密码控件值。
- 子任务的 RPC 验证直接父子关系及当前 live Agent。已结束子任务仅展示历史；不会为了点击控件悄悄恢复子任务。
- 图片经原生 DSH attachments 入库，再交给支持图像的模型。截图和网页/应用内容作为外部数据处理。

## 运行与打包

原生后端为 `plugin/desktop-control.mjs`、`plugin/windows/computer-worker.ps1`、`plugin/windows/computer-native.cs`，以 Windows PowerShell 5.1 编译并运行随包提供的 C#，调用 Win32 与 UI Automation。动作仅使用固定 JSON 协议，用户文字不拼进脚本；不依赖 Codex 私有组件、Python、.NET SDK 或付费原生包。

现有 desktop stage 递归带入 plugin 目录，因此 helper 和 `plugin/computer-guides/*.md` 一同交付，无需下载额外桌面驱动。浏览器沿用锁定版本的 Playwright MCP 与打包的 Chromium headless shell。企业受限 PowerShell、UAC 安全桌面、提升权限的软件以及部分不响应标准键盘输入的软件可能拒绝操作，界面保留真实错误，不尝试绕过系统权限。

当前桌面互斥范围是单个 ColdX 后端进程。不要同时从多个独立 ColdX 后端控制同一物理桌面。首次 PowerShell 启动和 Add-Type 编译有独立的 60 秒上限；收到编译完成握手后才发送动作。每个动作仍有 15 秒上限，超时停止自有 helper；启动过程中也能立即取消，不等待握手。编译错误保留诊断，探针测试报告实际启动耗时。长时间输入和拖动检查取消信号并在 finally 中释放所按的键或鼠标按钮。

## API

`createComputerComponents(React, rpc)` 保留 `useComputer`、`ComputerStatus`、`ComputerPreview`，增加 `ComputerWorkspace({ sessionId, state, pane, view })`。`state` 使用 `useComputer` 的返回值；`view` 接受 `browser` / `desktop`，省略时读取共享 pane。pane 继续负责对话框位置、焦点、Escape 和 Tab 导航。

`coldxComputer` version 1 状态兼容旧字段，新增 `capabilities`、`browser`、`desktop`、`readOnly`。RPC 为 `desktopEnable`、`desktopWindows`、`desktopObserve`、`desktopAction`、`desktopPause`、`desktopStop`、`browserAction`；每个都有验证归属的 `Child` 路由。读状态不触发截图或输入。

模型工具 `coldx_computer` 的 action 包括 `windows`、`focus`、`observe`、`click`、`double_click`、`drag`、`scroll`、`type`、`key`、`stop`。浏览器仍通过 `coldx_browser` 延迟启用，沿用原生 MCP 工具执行与事件记录；扩展 `browser_forward`、`browser_reload`、`browser_state` 和 `browser_type_focused`。

## 验证

离线测试覆盖真实 DSH 服务注册、子任务归属、图片附件、浏览器工具事件，以及窗口身份、过期观察、暂停/停止、错误页面导航后的活跃标签、输入协议和前端缩放。它们验证基础设施合同，不是模型任务成功率评测。

本地 Playwright 页面完成实际导航、前后历史、多标签切换关闭、中文输入与截图。原生 Windows 验收使用自有 WinForms 窗口，完成点击、中文输入、Ctrl+A、拖动、滚轮和截图；测试关闭自有窗口，不触碰私人软件。

```powershell
node --test test/browser-transport.test.mjs test/computer-client.test.mjs test/desktop-control.test.mjs test/computer-runtime.test.mjs test/computer-native.test.mjs
$env:COLDX_DESKTOP_SMOKE='1'
node --test test/desktop-windows.test.mjs
```

实际 WinForms 测试默认跳过，设置上述变量才会打开测试窗口。`test/computer-preview.browser.mjs` 使用本地 Playwright 验证窄面板原尺寸查看与缩放后的点击坐标；运行时可通过 `COLDX_BROWSER_PACKAGES` / `COLDX_TEST_CHROMIUM` 指向锁定浏览器依赖。

## 实现依据

- [Win32 SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)：输入事件及权限限制。
- [EnumWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumwindows)、[SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)：窗口枚举和前台约束。
- [UI Automation](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-overview)：辅助控件信息。
- [线程 DPI awareness](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setthreaddpiawarenesscontext)：截图及输入坐标一致性。
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)：公开 Transport 接口与 Apache-2.0 许可证。扩展层不依赖其私有请求处理器。
