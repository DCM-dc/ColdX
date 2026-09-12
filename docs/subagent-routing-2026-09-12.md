# 子智能体路由与状态修复验证

验证日期：2026-09-12。版本：原生 DSH 0.1.1-rc.2 的最小兼容补丁。

## 根因

用户 PDF 根会话（会话编号未公开） 的 22 个子会话全部使用旧 `coldx-imported/deepseek-v4-flash` 路由，结束原因为 AUTH 认证失败。父会话实际请求已经使用 `deepseek-official/deepseek-flash`、推理强度 max。权限不是阻塞原因。

原生 Web 模型选择在请求流水线中覆盖 provider/model，未修改 Agent 创建时只读 options。原生子任务从 options 继承，因此仍访问旧路由；ColdX 旧 profile 还强制加入了 legacy 模型覆盖。

## 修改

- 子任务从父亲最近实际 requestHeader 继承 provider/model/maxTokens；显式子路由覆盖仍优先。可继续子会话的持久 descriptor 同步正确路由。
- 在相同模型路由上，新子任务仅首请求继承父亲显式 reasoningEffort；已持有自身请求历史的恢复任务保留自己的选择。
- profile 不再注入固定子模型。只移除旧版本生成的精确 model-only override，保留其他用户配置与自定义路由。
- 原生 subagent identity 投影新增可选 execution，按自身 descriptor 后的 turn/start、turn/end 折叠。fork descriptor 重置祖先结局；schema/version 更新让旧投影缓存重算。只传状态、时间、序号、白名单错误代码和有效 HTTP 状态，绝不传原始推理或错误正文。
- 工作面板显示最多 3 条近期简短通知，其余可展开；可点击原生子会话。失败显示明确原因，长任务 prompt 不再整段呈现。

## 验证

修复前，实际路由、spawn、fork、continuable 的 4 项原生集成测试全部失败；原生 outcome 测试也失败。

修复后定向回归 42/42：`node --test test/subagent-routing-native.test.mjs test/profile.test.mjs test/activity-model.test.mjs test/activity-components.test.mjs`。覆盖原生父请求模型切换、三种委派链路、effort 继承、显式子覆盖、fork 状态隔离、字段白名单、简短通知、22 子任务折叠和 profile 迁移。

在独立内存 DSH 上用当前授权官方配置做少量真实模型 canary（每请求最大 1024 tokens、无重试）：父请求 completed；通过原生 subagent 工具产生的子任务 completed，返回预期 CHILD_OK。父与子实际 requestHeader 都为 deepseek-official/deepseek-flash、reasoningEffort=max。未调用旧网关、未修改凭据。内存 canary 无持久化，所以结束后 child catalog 为空是预期行为；成功证据来自真实原生 subagent/end 事件及孩子实际请求头。

对用户已有 22 子会话重新运行原生 catalog，并经过 browser RPC schema 校验：22/22 保留 `execution.status=failed, code=AUTH`，不再整片“状态未知”。此检查只读已有日志，没有重跑用户任务。

本次子任务没有重启端口 3086 或执行构建。部署后浏览器验收由主任务统一完成。

## 浏览器解码与子会话只读访问补充

原生 `dsh-client-connection/lib/client.js` 内含发布时预编译的 `subagent.list` schema，单独更新 host-apiproxy 的 schema 不会更新这个包。新增第 6 个兼容补丁为实际浏览器 bundle 加上可选、严格类型的 execution 字段。直接加载发布 bundle，以其 AbstractApiClient.callUnary 解码真实 Response 包装的两项测试先失败后通过：保留状态、拒绝错误类型、删除未知 prompt/reasoning 字段，并兼容无 execution 的旧响应。独立复核后续 runtime catalog spread、store 和 ColdX selector 未发现额外字段丢失点。

增加只读 child RPC：`coldxFiles/listChildFiles`、`coldxFiles/readChildFile`、`coldxTerminal/readChild`，参数是 `{address:{parentSessionId,childSessionId,mode},request}`。它们直接验证原生子任务 catalog，读取已经存在的 Session/header，读后核对生命周期；绝不调用 generic Agent lookup 或恢复冷子任务。客户端使用原生 `ctx.sessions.subagentAddress(sessionId)` 或 `session.subagent.address`。上传保留原 root Agent 限制。

原生 RPC 测试确认另一父任务/错误模式不能读取该孩子；cold child 预览后仍无 live Agent；实际子进程输出仅出现在对应孩子的终端中。终端 record 的可选 cwd/command 改为缺失时不序列化，避免 Typert 对 undefined 字段拒绝整份流快照。

最新 QA 会话（会话编号未公开） 的子会话 在持久化 seq 21 以 completed 结束；当前原生 catalog 同样返回 completed，实际模型为 deepseek-official/deepseek-flash/max。
