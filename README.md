# ColdX

![ColdX 标志](plugin/client/assets/coldx-logo.png)

ColdX 是基于 **DeepSeek Harness 原生 WebUI** 的 AI 工作台。你描述任务，AI 使用文件、终端、子智能体和插件完成工作，也可以在对话中生成可交互页面；提交页面中的选择后，任务继续执行。

DSH 负责模型连接、会话、权限、工具运行和插件生命周期。ColdX 在这套原生运行时上提供统一界面、生成式交互和更清楚的执行过程。

## Windows 安装包

当前桌面版本为 **0.1.4 / Windows x64**。发行版本和安装附件见 [Releases](https://github.com/DCM-dc/ColdX/releases)，安装包名称为 `ColdX-0.1.4-win-x64.exe`。

- 安装包内置 Node、pnpm、锁定的 DSH 运行时和匹配的 Chromium headless shell，无需先安装开发环境或浏览器组件。
- 紧凑的一体式标题栏包含侧栏、前进/后退和文件/编辑/视图/帮助菜单，随 ColdX 深浅主题改变颜色；右侧保留原生窗口按钮，支持 F11 全屏。
- 首次启动在设置中配置模型。安装包不携带开发者的密钥、会话或工作文件。
- 应用使用独立的用户数据目录；卸载默认保留应用数据。Git、Python、编译器等任务工具按需另行安装。

Windows x64 的 0.1.1 已完成实际安装、启动、退出及卸载验收；各版本的验证范围见发行说明。当前安装包未进行代码签名。macOS、Linux 有构建配置，尚未完成实机验收；不能直接复用 Windows 的运行时资源，新增原生桌面控制目前仅支持 Windows。

### 0.1.4 新增

- **工作面板**：对话上方显示当前动作、子智能体和成果摘要；右侧统一查看进度、成果、文件、浏览器和电脑。
- **浏览器与电脑操作**：浏览器支持标签、导航、截图和手动接管；Windows 桌面支持窗口观察、真实截图、点击、输入、快捷键、滚动和拖动。AI 与手动操作共用任务归属和执行状态。
- **Superpowers**：模型推理强度滑轨上方的哑铃按钮开启公开工作流技能；首次默认关闭。内置经过版本校验的 14 项技能，更新下载后需确认装载。
- **插件修复**：安装失败或不支持一键安装的项目可选择“让 AI 安装/修复”，在当前任务内调查原因、安装和验证。
- **用量与活动**：左侧入口查看真实会话 Token、活动热力图、工具和技能使用；支持查询上游余额及低余额提醒。缺少数据时明确显示未知。
- **应用更新**：桌面版自动检查 GitHub Release 并下载可校验的安装包，确认后才启动安装；任务运行期间禁止安装。设置可关闭自动检查或下载。

详细功能与验收记录见 [0.1.4 工作台说明](docs/agent-workbench-2026-09-19.md)。

## 从源码启动

需要 **Node.js 24** 和 **pnpm 11.19.0**。克隆或下载本仓库后，在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm build` 会生成客户端、Logo 派生资源和 PDF 预览资源，干净克隆后需要执行。默认浏览器地址是 `http://127.0.0.1:3086/`。

使用另一个工作区：

```sh
pnpm start --cwd ../my-project
```

| 启动参数 | 用途 |
| --- | --- |
| `--cwd <目录>` | 文件和命令工具使用的工作目录 |
| `--home <目录>` | 指定 DSH 数据目录，默认是仓库的 `.runtime/` |
| `--port 0` | 自动选择空闲端口 |
| `--no-open` | 只启动服务，不自动打开浏览器 |

关闭浏览器不会停止后端；在启动终端按 Ctrl+C 停止服务。Windows 也提供 [Start-ColdX.ps1](Start-ColdX.ps1)。

首次使用时，在设置中添加模型提供方、Base URL、API Key 和模型；DeepSeek 引导可选择稍后配置。选择工作区及 **ColdX 创造工作台** 预设后即可开始。密钥由 DSH 宿主配置管理，不传给生成页面。模型、多模态和推理档位是否可用，取决于你配置的提供方。

## 日常使用

### 加号菜单与工作模式

输入框左侧的 **加号** 统一提供“文件和文件夹”“目标”“计划模式”和可用插件入口。

- **文件和文件夹**：上传本机文件、添加图片，或查找工作区文件并引用。普通文件一次最多 8 个，单个不超过 8 MiB；文件保存到当前工作区的 `.coldx/uploads/`，以引用方式加入对话。同名但内容不同的文件不会覆盖原文件。
- **Goal**：从下一条真实用户请求中生成或衔接目标，并持续推进；无需在菜单中填写目标。关闭模式会暂停仍在运行的目标。
- **Plan**：先生成计划，经过审阅后再执行变更。Goal 和 Plan 可以同时开启，输入框以统一的小标签显示选择。
- 新会话中的模式选择只保存草稿偏好，不会仅因切换模式就创建会话或发送消息。

图片支持原生附件预览、移除、粘贴和拖放，并通过多模态内容块发送；模型和网关需要支持图片。普通文件不会在每轮自动全文注入，AI 按任务需要读取。

### 模型与推理强度

点击模型名称打开紧凑的模型控件。内置 DeepSeek 显示名称与官方名称对齐，自定义名称保留。推理滑块只提供当前模型实际声明的档位，支持拖动、键盘调整和恢复默认；松开后保存，菜单保持打开。

界面保留轻量动效和最高档位反馈，同时尊重系统的“减少动态效果”偏好。缓存徽标只使用提供方已报告的 token 用量；缺失数据不显示为零，也不把缓存命中率当作生成质量评分。

### 工作面板、文件与子智能体

会话右上角的 **工作面板** 包含“进度”“成果”“文件”三个页面。宽屏使用右侧区域，窄屏使用抽屉。

- **进度**：查看当前动作、工具调用、子智能体和后台任务；长串过程以紧凑记录展示，必要时展开。
- **成果与来源**：查看生成页面、文件产物及对应来源；支持通过回答中的本地文件链接打开工作区文件。
- **文件**：在侧栏中预览文本、代码、Markdown、HTML、图片和 PDF，并进行引用、下载或在本机打开。PDF 支持翻页、缩放和文本选取；扫描件不会自动变成可搜索文字。
- **子智能体**：显示原生子任务的当前状态、失败原因和打开入口；可在其所属任务中查看文件和命令输出。

状态来自原生会话、工具和任务记录。未加载或无法核实的状态会明确说明，不把存在的文件或安装记录自动视为任务成功。

### 实时命令输出

在设置中打开 **终端面板**，可在会话下方查看 AI 通过原生 Bash / PowerShell 工具执行的命令、工作目录、实时输出及结束状态。Python 或编译命令经这些 shell 启动时，也会显示实际输出。

终端面板可以收起；关闭设置后停止订阅。历史命令仍可查看已结算的输出。它是命令观察面板，不是可发送 stdin 的交互式 PTY，也不汇总全部 Web/Host 内部日志；没有输出流的工具不会被补成模拟日志。

### 插件市场

左侧“设置”上方的 **插件市场** 从 [GitHub 的 dsh-plugin topic](https://github.com/topics/dsh-plugin) 发现社区项目。选择项目后可查看说明、源码、发布信息、兼容性与可安装包；通过核验的包可一键安装。

市场与 AI 共用安装服务和状态记录。安装失败可以重试，或选择“让 AI 安装/修复”交给当前真实会话；没有会话时会提示先打开任务。AI 会读取受限的失败记录，再通过原生工具安装和验证。需要配置或重启时会明确显示；关闭市场不会取消已经提交的手动安装。

“允许 AI 按需安装插件”默认开启。AI 可以使用 `coldx_plugins_search`、`coldx_plugins_inspect`、`coldx_plugins_install` 和 `coldx_plugins_status` 查找并安装所需能力。AI 安装要求当前会话为 **Full access**；关闭该开关不影响手动搜索和安装。

一键安装目前支持经过来源、精确版本、完整性与兼容性检查的已发布 npm 原生 bundle。只有源码、未发布或不兼容的项目会说明原因。topic 标签本身不是安全认证；市场不执行 README 中的安装命令，也不会自动重启正在工作的应用。

## 生成式交互

生成页面直接出现在对应的消息或工具调用位置，不替代对话和输入框，并可跟随 ColdX 的深浅主题切换。

`coldx_present_page` 可组合 HTML/CSS、SVG、Canvas 和 JavaScript；页面通过 `await ColdX.submit(value)` 提交结果，让原生工具等待继续。`coldx_interact` 适合有明确选项的决策、少量自定义输入和方案预览。

例如：

- “把这三种方案做成可以调参数的比较页面，我选好后继续实现。”
- “生成一个可编辑的文案对照表，把我提交的修改写回文件。”
- “并行检查前端和后端，展示各自进展，完成后汇总需要修复的问题。”

页面是否有价值由任务决定；普通回答可以正常结束，不要求每轮都生成界面。生成内容和实际工具执行仍需要模型及环境配合，不保证每次生成都成功。

## 开发与验证

```sh
pnpm build
pnpm test
pnpm desktop:dev
```

`pnpm test` 会先重新构建客户端，再运行单元与原生运行时集成测试。独立的浏览器测试位于 `test/*.browser.mjs`，需要相应的 Playwright 浏览器环境。

桌面版 0.1.2 起已携带浏览器自动化所需的 Chromium headless shell，无需另装。源码运行时可按需安装匹配组件：

```sh
pnpm computer:install
```

浏览器操作与 Windows 桌面控制位于工作面板对应页签；桌面控制需先开启。Windows 使用系统自带 PowerShell、Win32 与 UI Automation，不依赖 Python 或额外 SDK。WeChat、Blender 操作指南按需提供给模型；指南并不等于已经代替用户验证了每个第三方软件版本的全部操作。平台能力与验收范围见 [工作台说明](docs/agent-workbench-2026-09-19.md)。

在目标系统和架构上构建桌面发行版：

```sh
pnpm desktop:dist
```

Windows 产物输出到 `dist/desktop/`。跨平台原生依赖、Node sidecar 和 Electron 必须与目标系统匹配，构建细节见 [桌面打包说明](docs/desktop-packaging-2026-09-12.md)。

| 代码入口 | 内容 |
| --- | --- |
| [bin/coldx-web.mjs](bin/coldx-web.mjs)、[lib/profile.mjs](lib/profile.mjs) | Web 启动、工作区和原生 profile |
| [plugin/policy.mjs](plugin/policy.mjs)、[plugin/host.mjs](plugin/host.mjs) | 可编辑的 ColdX 策略与宿主集成 |
| [plugin/client/](plugin/client/) | 原生 slot 组件、主题、模型控件、文件预览与生成页面 |
| [plugin/terminal-host.mjs](plugin/terminal-host.mjs) | 原生命令输出流与会话归属 |
| [plugin/marketplace-host.mjs](plugin/marketplace-host.mjs) | 插件市场 RPC 与 AI 工具 |
| [plugin/computer-host.mjs](plugin/computer-host.mjs)、[plugin/windows/](plugin/windows/) | 浏览器、Windows 桌面控制与原生任务归属 |
| [plugin/superpowers-host.mjs](plugin/superpowers-host.mjs)、[vendor/superpowers/](vendor/superpowers/) | 原生技能提供器、公开技能与版本记录 |
| [plugin/usage-host.mjs](plugin/usage-host.mjs)、[plugin/updates-host.mjs](plugin/updates-host.mjs) | 用量、上游余额与确认式应用更新 |
| [desktop/](desktop/)、[scripts/desktop/](scripts/desktop/) | 独立窗口、运行时 staging 和安装包 |
| [examples/](examples/)、[test/](test/) | 交互示例与回归测试 |

## 实现边界与研究资料

ColdX 精确锁定 **DSH 0.1.1-rc.2**，原生兼容补丁由 `pnpm-workspace.yaml` 和 `patches/` 管理。升级 DSH 需要重新验证这些接口，不能只替换版本号。

生成页面运行在 `sandbox="allow-scripts"` iframe 中，没有父页面 DOM 或存储权限；CSP 限制外部脚本、网络连接、子 frame 和表单提交。页面展示与宿主工具执行是不同的权限边界，宿主工具仍遵循 DSH 权限控制。

会话和已发布页面可以从历史恢复，未提交的 iframe 内部草稿不会跨刷新保存。Host 重启会中断原有工具等待；旧页可回看，不代表可以继续原等待。动态 Cordis 定义只保存在当前进程，持久扩展应保存为原生插件或 preset。

下列文档保留研究日期和当时的实现记录；其中的后续建议不代表已经交付：

- [ColdX × DeepSeek V4.1 真实评测与完整研究](docs/research/deepseek-v41-agent-benchmark-2026-09-13.md)（固定三题通过两题，含失败复盘、图表、费用估算与 PDF 摘要；非全量排名）及 [原生评测工具](eval/benchmark/README.md)
- [DeepSeek V4.1 生成质量、任务成本与民间方法核查](docs/research/deepseek-v41-performance-token-efficiency-2026-09-12.md)（含实验矩阵与离线复现）
- [DeepSeek 质量、工具与上下文治理研究](docs/deepseek-quality-foundations.md)
- [DeepSeek Agent Harness 研究](docs/deepseek-agent-harness-research.md)
- [附件与多模态集成](docs/deepseek-attachment-integration.md)
- [插件市场发现与发行版验证](docs/plugin-marketplace-discovery-2026-09-12.md)
- [生成页面主题协议](docs/generated-page-theme.md)与 [PDF 预览实现](docs/pdf-preview.md)
- [可用性验收记录](docs/usability-acceptance-2026-09-12.md)
- [版本记录](CHANGELOG.md)

缓存优化以稳定前缀、按需读取和实际 usage 为依据；不会把检索、缓存或离线场景检查描述为已经训练模型或保证省下固定比例的费用。提供方协议与参数应以其当前官方文档为准。

## 鸣谢

感谢 **madd** 的梯子赞助。
