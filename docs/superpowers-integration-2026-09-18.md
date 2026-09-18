# Superpowers 与插件安装修复

本实现采用 [obra/superpowers](https://github.com/obra/superpowers) 的公开技能库，
版本 6.3.0，固定提交 `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`。
[上游 MIT 许可证](../vendor/superpowers/LICENSE) 与作者版权声明随发行包保留。
这不是 Codex 私有运行时或内部工具的移植。

## 使用方式

模型强度菜单左上方的哑铃开关作用于当前 ColdX profile，默认关闭；不创建
会话、不发模式消息、不修改模型档位或草稿。保存期间保留按钮焦点，所以
原生模型菜单持续打开。版本按钮与设置页可查看当前版本和待装载更新。

开启后，14 个技能通过每个真实 Agent 自己的 DSH skill provider 暴露名称与
说明。模型调用原生 `skill(name)` 才读取正文；参考 Markdown 按需读取。
现有单一 operating-policy 段落中只追加短引导和平台适配说明，不再注册一份
系统提示词，也不把全部技能正文每轮注入。项目/用户技能继续遵从原生目录
优先级。原生子智能体获得自己目录中的同一固定版本。

原生 registry 先比较作用域，再比较 rank，因此 agent 范围的 bundled provider
会先查询明确不带 scope 的 host catalog，对已有项目、用户和运行时同名技能
让位；只用 rank 600 不足以保证这种优先级。父子 Agent 的 native 回归验证了
项目覆盖用户、用户覆盖 bundled，以及删除覆盖后恢复 bundled。

上游 40 份 Markdown/许可证文件保持原文。此发行不包含可执行脚本；原文提及
可选 visual-companion 时，适配提示明确使用 ColdX 现有页面和实际工具。
用户已授权的操作不重复征求同一权限，原生 Plan 模式仍控制实施边界。

## 更新与版本固定

`plugin/superpowers-store.mjs` 管理 profile 下 `.coldx-superpowers` 的状态、
版本与临时下载。启动后自动检查，成功检查间隔 24 小时；用户可关闭自动
检查或手动检查。公开 GitHub 的主分支提交先变成候选，然后下载 `LICENSE`
及 `skills/**/*.md`。不会执行远程 npm、启动脚本或自动装载。

下载只访问固定 GitHub 域名，拒绝重定向、路径穿越、符号链接、非普通文件、
截断树和超过文件/总量上限的内容。文件 Git blob、长度和 SHA-256 全部校验。
下载失败保留当前活跃版本，清理本次临时目录。用户点击“装载更新”时再次
校验磁盘内容，并检查候选身份与当前版本；有并发变化则要求刷新。

正在运行的父任务和其原生子智能体固定在原版本，整个任务族空闲后才采用
新版。正在执行的技能不会在更新确认中途换正文。关闭技能开关会立即从
原生目录移除这一 provider 的条目。

## 安装失败后的 AI 修复

插件详情中，安装失败或需要配置/重启时提供“让 AI 修复安装”。尚无可验证
发布包的项目提供“让 AI 安装 / 检查安装方法”。它把限定插件的诊断通过
`agent.followup` 排入当前真实主会话；没有会话时要求先打开会话，不伪造新任务。
原安装所属会话不同则提供“打开原任务”，不得挪用其他任务。
子智能体发起的安装保留 `ownerSessionId` 作为原始来源，另由真实 native
ownership 链计算并保存 `rootSessionId`，供主任务界面定位与修复派发。
子智能体释放后，主任务仍可修复；其他主任务仍被拒绝。旧记录只有在原子
智能体还存活、可核实 native ownership 时才补全路由，不根据传入 ID 猜测归属。

用户仍可一键安装；AI 路径尊重市场里的允许开关与当前会话 Full access。
接受前及真正派发前重新核验会话/权限/允许开关。相同 requestId 幂等，不同
窗口对同一未完成修复重复点击也只派发一条原生消息。

安装账本保留原 job、最多 10 条历史尝试、修复链与有限错误输出。包管理器
stdout/stderr 保留有限尾部并移除认证字段；过长被截断的首行整体丢弃。
诊断作为不可信数据嵌入修复请求，不把 README 当执行命令。只有原生安装
状态确认为 `active` 才显示修复已启用；模型解释、安装文件存在或入队成功
都不等同于已启用。重启时未完成修复变为需关注，不虚报仍在执行。

## 原生 API 与验收

- `coldxSuperpowers/state`, `setting`, `check`, `stage`, `activate`：`{args:{request}}`。
  `setting` 支持 `enabled/autoCheck/expectedRevision`；`stage` 需要候选 ID；
  `activate` 需要候选 ID 与 `expectedActiveCommit`。
- `coldxMarketplace/repair`：`{jobId,sessionId,requestId}`，或未发布项目的
  `{id,packageId?,sessionId,requestId}`；返回 repairId 与 ownerSessionId。
- 客户端 `ModelControl` 接收独立 `superpowersControl` 节点；市场从原生
  `sessions.list.getSnapshot().current` 读取当前主会话，并使用 `sessions.open`。

验证包括实际 DSH Agent/skill 目录与 skill 工具调用、父子任务版本固定、
更新候选校验与回退、原生 repair followup 归属/幂等/失败恢复、包管理器错误
输出，以及真实 React/Playwright 原生 ModelSelect 菜单和市场修复交互。
所有模型任务使用拒绝 pre-step 或受控 RPC，不调用收费模型。这里的验证
证明功能契约与交互，尚不能证明某个模型的最终生成质量或 token 收益。
