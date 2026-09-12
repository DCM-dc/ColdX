# Codex、Qoder 与 ColdX：可验证能力和补齐顺序

检索日期：2026-09-12。竞品部分只使用实际打开的官方功能文档；没有实装 Qoder，没有用同一任务进行生成质量或成本跑分。ColdX 依据当前源码、README、当天验收报告，以及本轮主代理对正在执行的 PDF 任务的浏览器观察。本文的“缺失”仅指当前 ColdX 成品入口或闭环缺失，不表示 DSH 无法扩展该能力。

OpenAI 旧 `developers.openai.com/codex/...` 功能页目前重定向至 `learn.chatgpt.com/docs/...`。下文“Codex 桌面体验”仅指官方文档明确适用于桌面中的本地 Codex 的能力；不会将 ChatGPT Work 云端、CLI、IDE 的不同能力混作一个产品。Qoder 当前文档同时包含独立 Qoder 应用和 IDE Quest，Experts Mode 将明确标注为后者。

## 最重要的判断

ColdX 已经拥有 Goal、Plan、子智能体、后台任务、工具执行轨迹、文件上传和原生生成式交互。主代理本轮在真实页面看到：运行中的原生 Goal 及暂停/编辑/清除入口、22 个子代理的菜单、原生任务清单、活动侧栏和终端输出。因此下一阶段的重点是让这些能力协调、清楚、可验收，不能把它们重新列为“待开发”。

竞争差距更集中在交付和维护流程：文件能否预览并定点修改、代码变更能否与原工作隔离并审阅、长任务能否保留完成证据、重复工作能否变成可管理的自动化和知识资产。功能数量不证明完成质量；这次文档研究不能得出“某产品整体更强”。

## 功能核对

| 工作环节 | Codex 的官方能力 | Qoder 的官方能力 | ColdX 当前状态与真正差距 |
| --- | --- | --- | --- |
| 计划与持续目标 | `/plan` 和 `/goal`；Goal 可暂停、恢复、编辑、清除并接受继续对话的指引。[命令与 Goal](https://learn.chatgpt.com/docs/reference/slash-commands) | 独立应用有 Plan 和 Goal；计划说明范围、影响、风险、验收，目标执行并检查可测量结果。[Plan](https://docs.qoder.com/qoder/plan-driven)、[Goal](https://docs.qoder.com/qoder/goal-driven) | **已具备。** Coding mode 接到原生 Plan 审阅和 Goal，且真实任务正在使用。剩余是任务清单、Goal、当前动作的层级和文案统一；任务改动后的验收证据关联仍是**部分具备**。 |
| 并行子智能体 | 原生并行委派、结果汇总与活动显示，可配置专用 Agent；官方说明更多子代理通常也会消耗更多 token。[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | 独立应用可选择/自动调用扩展提供的专用 Agent；**IDE Quest Experts** 另有主代理协调、可点击的任务状态和模型/Skills/MCP 配置。[Subagents](https://docs.qoder.com/qoder/subagents)、[Experts](https://docs.qoder.com/user-guide/quest/experts-mode) | **已具备基础及真实执行。** DSH 有 spawn/fork、可继续后台子代理和 workflow；活动侧栏可打开子代理。应改善职责、运行/完成状态、产物和验证摘要，不能只放数量。成本分摊与并行效果评估**部分/待验收**。 |
| 代码隔离与审查 | Git worktree 支持同项目并行任务和 Local/Worktree handoff；Review 可比较 diff、逐行反馈、暂存/撤销/提交。[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)、[Review](https://learn.chatgpt.com/docs/code-review) | 独立应用有 Local/Worktree/SSH 工作区；Review 可选本轮、未提交、暂存、分支等范围。[环境](https://docs.qoder.com/qoder/execution-environments)、[Review](https://docs.qoder.com/qoder/review-and-commit) | **成品闭环缺失/原生底层待确认。** 目前读到的是通用文件编辑及工具 diff，不是可管理 worktree 与审阅交付的一套 UI。可经命令执行 Git 不等于已有此体验；应先确认 DSH 可复用接口，再加入口。 |
| 终端与过程可见 | 每任务集成项目/worktree 终端，用户可运行命令，Codex 可读取当前输出；支持可复用命令快捷操作。[Terminal](https://learn.chatgpt.com/docs/integrated-terminal) | 有任务终端入口和权限控制；Review 与终端互通。[Review 与 Terminal 入口](https://docs.qoder.com/qoder/review-and-commit) | **部分具备。** 命令、cwd、结算输出和退出码都是真实数据；当前面板依赖完成后的 resultView，不是实时字节流或交互 PTY。先统一入口、避免遮挡输入，再考虑原生事件扩展。 |
| 文件与交付物 | 桌面可并列预览文档、表格、演示、PDF；支持的预览可批注定点修改；可用时 HTML 有预览/源码切换。CLI 不包含这种视觉预览。[Work with files](https://learn.chatgpt.com/docs/artifacts-viewer) | 本轮确认任务中的代码 Review、Repo Wiki 和浏览器入口；未充分验证独立应用对所有 Office 格式的预览能力。 | **部分具备。** 本机文件上传/@ 引用、图片预览、内联 HTML 交互已具备；通用文档预览/批注闭环尚未验收。当前产物区中间脚本抢占正式交付物，来源还有路径重复。优先修这些，再加新面板。 |
| Skills、MCP、插件 | Skills 与 MCP 可以由插件打包；本地 Codex 的 MCP 配置和状态可管理，支持 STDIO/HTTP 与适配的认证。[Plugins](https://learn.chatgpt.com/docs/plugins)、[MCP](https://learn.chatgpt.com/docs/extend/mcp) | 独立应用有 Skills/Plugins/Connectors 的查找、安装、导入和管理；MCP 有表单和 JSON 入口。[Skills](https://docs.qoder.com/qoder/skills)、[Connectors](https://docs.qoder.com/qoder/connectors) | **部分具备。** pinned DSH 包含 skill、MCP、Cordis 插件机制，ColdX 可生成并挂载原生插件；生态发现、安装后状态、连接诊断和可复用任务配方未形成统一入口。原生能力不应重造。 |
| 定时工作 | 桌面定时任务可在本地目录/worktree 执行，管理状态及运行记录；依赖电脑和应用运行。[Scheduled tasks](https://learn.chatgpt.com/docs/automations) | 独立应用能配置时间/时区/过期时间，选择独立或合并任务，查看 Run history；同样需要应用运行。[Automations](https://docs.qoder.com/qoder/automations) | **部分底层，成品管理缺失。** DSH jobs/workflow 已存在，不能标成没有后台任务；但本次未见持久定时入口、错过时间处理、独立运行记录与通知管理。先明确生命周期再做设置页面。 |
| 长期记忆和项目知识 | 本地 Codex 有独立记忆存储和每任务读写控制；必须长期执行的约定应放 AGENTS.md/版本管理文档。[Memories](https://learn.chatgpt.com/docs/customization/memories) | 独立应用区分全局/项目记忆，可开关及检查文件；Repo Wiki 可增量更新、导出、作为任务上下文。[Memory](https://docs.qoder.com/qoder/memory)、[Repo Wiki](https://docs.qoder.com/qoder/repo-wiki) | **部分具备/范围未知。** ColdX 有原生会话持久化、压缩和 recall 来源投影；这不等于已经有可治理的跨任务记忆库。需要单独核实实际读写接口，新增前优先做来源、更新时间、失效条件和用户可编辑/删除控制。 |
| 持续改进 Agent 环境 | 通过规则、Skills、工具和验证流程组合实现；本轮没有认定存在某个与 Better Harness 完全相同的独立产品功能。 | Better Harness 审视反复失败的工作流，把问题转成合适的规则、Skill、hook 或脚本，并用后续代表任务验证。[Better Harness](https://docs.qoder.com/qoder/better-harness) | **部分具备。** 已有研究、稳定策略、30 场景离线夹具和集成测试；缺真实任务质量评测闭环。最值得移植的是“症状→证据→小修复→后续任务验证”，不能自动叠加越来越长的系统提示词。 |

## 优先取长补短：六项可验收改进

1. **先整理现有工作界面。** 左侧固定项目/会话；中央保持时间顺序的对话与生成交互；右侧一个可伸缩的工作详情区，容纳产物、来源、子代理；命令输出在约定的底部区域。模式/权限/模型只在 composer 的固定位置出现，运行进度在其上方，避免同一状态重复绘制。这里借鉴的是桌面工作流的空间分工，具体布局是针对 ColdX 的设计建议，并非竞品逐像素复刻。
2. **把“做完了”连接到证据。** 沿用原生 Goal 和 Plan，显示当前验收条件、最新已验证产物、仍未通过的检查。用户更改需求后，旧证据仍可查看，但不得自动满足新要求。验收：同一任务经历一次中途修订，能看到新的条件和重新验证结果。
3. **交付物优先。** 产物先呈现用户可用的 PDF、文档、网站和下载文件，中间脚本收在过程文件；来源按工作区规范路径聚合，保留定位范围。文件点击打开对应预览/真实位置。验收：同文件相对/绝对路径不重复计数，正式成果不淹没在脚本中。
4. **把子代理变成可理解的分工。** 沿用现有委派和状态，补齐每个子任务的职责、状态、产物、验证与费用摘要；失败或等输入排前，已完成默认收起。只有任务可独立运行且预期节约时间/提高质量才并行。验收看首个可用结果耗时与返工率，不看启动了多少代理。
5. **补工程交付闭环。** 对代码工作先做 worktree 状态与 scoped diff 审阅，再推进暂存/提交等操作；对非代码工作提供相应预览/批注。不要让普通用户为了查看生成 PDF 先理解 Git。验收：同一仓库两任务改动不会混进对方的“本任务产物”。
6. **把重复成功做法留成轻量资产。** 优先保存已验证的环境探测、文件处理、测试/打包命令和来源引用；按项目范围和当前版本读取。以后再做有运行历史的定时任务。记忆、任务状态、规范文档分开管理；避免把临时故障结论写成永恒规则。验收：第二次同类任务少重复探测，产物质量仍相同或更好。

## 这轮 UI 统一的具体尺度

建议只留一个弱蓝色强调色；表面以中性背景、1px 边界和少量层级为主。普通内容区不用玻璃渐变、大阴影、闪光、漂浮或多个同等醒目的卡片。按钮分主要/普通/静默三档，菜单、弹窗、表单、来源行共用相同字号、圆角、间距、焦点样式和图标尺度。开合保留短淡入和小幅位移，日常列表 hover 不跳动；尊重 reduced-motion。

这不是取消 ColdX 的生成式页面能力。固定外壳负责导航和稳定操作，任务内生成的页面负责表达数据、比较方案、收集用户输入。生成页仍归属原消息和原工具调用，不应把整个对话替换成随任务变化的仪表盘。

## 本地依据和限制

- [当天真实验收](../acceptance-2026-09-12.md)：上传、来源重复、正式产物、终端结算输出、原生兼容与连接边界。
- [README](../../README.md)：已实现的 Goal/Plan、生成页面、文件引用、活动侧栏与缓存统计。
- [原生配置接入](../../lib/profile.mjs)、[活动读模型](../../plugin/client/activity-source.mjs)、[客户端接入](../../plugin/client/client-source.mjs)：使用 DSH 会话、子代理、jobs、typed tool results 和 native slots。
- pinned DSH 自带 Cordis preset 已注册原生 goals、Plan 审阅、jobs、workflow、subagent、todo、skills；不存在为本报告另起运行时的必要。
- Qoder “Context compaction”页面第一次打开成功，但再次读取正文超时，本报告没有据此推断其压缩策略、效果或成本优势。所有“未知/待验收”都应在下一轮实测后更新。
