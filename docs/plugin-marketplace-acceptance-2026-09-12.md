# ColdX 插件市场验收

## 使用入口

侧栏“设置”上方的“插件市场”提供搜索、仓库详情、安装、安装记录与 AI 安装开关。打开市场不创建会话。发现来源为 [GitHub dsh-plugin topic](https://github.com/topics/dsh-plugin)，发行包与原生契约依据见 [发现与兼容性研究](plugin-marketplace-discovery-2026-09-12.md)。

“允许 AI 按需安装插件”默认开启。四个原生工具覆盖搜索、检查、安装和状态读取；安装要求当前 live Agent 具有 Full access，关闭开关只禁止 AI 安装。UI 与 AI 读取同一份安装任务记录，不依靠模型文字判断是否成功。

## 运行与失败边界

- 安装使用原生 DSH CLI、精确 npm 版本、固定 registry 与完整性校验；不执行仓库说明里的命令或安装期脚本。
- 原生 bundle 的新增条目可以热启用。改变已运行条目、替换已导入模块版本需要重启，不自动中断任务。
- 校验失败的包从下次启动列表中停用；保留失败状态和重试入口。原有插件实例不会为了安装被自动重启。
- 重复点击共用一个任务；不同安装串行运行。关闭市场不会取消已提交的手动安装；AI 可以取消自己的排队安装，也可以停止等待共享的用户安装。
- 安装记录与实际加载状态分别核验。文件存在不等于启用；保存失败有独立提示。损坏的历史文件保留副本后恢复市场。
- 原生运行时依赖复用当前 DSH，拒绝安装另一份 Cordis/DSH 实例以免产生不兼容的服务身份。

## 验证方法

常规回归使用 `pnpm test`。UI 使用 `node --test test/marketplace-ui.browser.mjs test/sidebar-keyboard.browser.mjs test/ui-consistency.browser.mjs`，覆盖原生 React 交互、请求竞争、真实状态更新、失败重试、窄屏、深色模式、键盘关闭与焦点恢复。

`node scripts/verify-marketplace-native.mjs` 是需联网的独立验收：创建临时 DSH profile，通过原生 AI 工具搜索、核验并安装 [dsh-status-rotator](https://github.com/01Virex/dsh-status-rotator)，再确认原生 loader 的启用状态、UI RPC 的同一任务记录与原 Agent 身份。它不读取用户模型配置，不调用付费模型，也不向用户当前 profile 安装该插件。

AI 工具调用测试验证工具和运行时链路；不等于已经评测真实模型会在所有任务中选对插件。GitHub-only、未发布精确版本、普通依赖或不兼容仓库不提供一键安装，详情会说明原因。

## 最终执行结果

- `pnpm install` 已应用当前锁定版本的两项原生补丁；`pnpm test` 完成客户端构建，**498/498 通过**。
- 市场、侧栏键盘与界面一致性的浏览器检查 **6/6 通过**。
- 实网脚本通过原生 `tools.execute` 完成搜索 → 详情 → 安装 → 状态查询，实际安装 `dsh-status-rotator@0.17.2`，状态 `active`、loader state `2`，UI RPC 记录一致，原 Agent 身份保持不变；付费模型调用数为 `0`。
- 该次独立验收将 `acceptance.json` 写入系统临时目录下的 `coldx-marketplace-native-*` 文件夹；该本机产物不随源码发布。没有向用户当前 profile 安装测试插件。
- 当前 `http://127.0.0.1:3086/` 已重启并用 computer use 实际打开市场：入口位于设置上方，真实搜索命中已核验版本并显示安装按钮。
- AI 开关关闭后，重新打开市场仍为关闭；验收完成后恢复为开启，原生设置文件确认 `agentInstallEnabled: true`。市场关闭后仍停留在原有“新会话”，没有创建额外会话。

真实 Host 验收还发现并修复了 `loader` 依赖声明缺失：安装器需要通过当前插件的 Cordis context 读取原生 loader，不能只在 root context 的单元夹具里验证。修复后重新执行完整回归和实网脚本，均通过。
