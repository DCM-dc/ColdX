# DeepSeek Agent Harness 研究与落地边界

更新于 2026-09-06。本文只记录本轮已经由 DeepSeek 或 DeepSeek Harness 官方资料确认的行为，以及一次局部网关协议 canary。ColdX 当前锁定 `@deepseek-ai/dsh 0.1.1-rc.2`；DSH 官方站点是滚动文档，可能描述比 rc.2 更新的实现，因此文中的“官方行为”“rc.2 本地事实”和“ColdX 方案”必须分开理解。方案项只有在安装版本、提供方能力和端到端测试同时通过后才算可用。

## 结论

| 主题 | 已确认事实 | ColdX 决策 |
| --- | --- | --- |
| Thinking | 工具循环必须完整回放既有 `reasoning_content`；省略会破坏协议 | 由模型适配器保存并回放，界面不展示，提示词不复制 |
| 前缀缓存 | DeepSeek 自动匹配完整前缀，官方 usage 区分 hit 与 miss | 只用 read 与 uncached input 计算缓存读取率，稳定内容前置 |
| 系统提示词 | DSH 用 `PromptSection` 组织稳定段，用 `PromptContext` 记录变化的上下文快照 | 每类约束只设一个所有者，去掉重复注入和纠正回合 |
| 模型分工 | DeepSeek 官方 Claude Code 配置展示了 root Pro、subagent Flash 的路由 | 作为能力门控方案；不能据此宣称 rc.2 已自动支持 |
| Retry | DSH 把重试当作原生持久事件和模型尝试，不需要模型再次“决定重试” | Activity Lens 投影当前尝试，只展示经过清理的运行事实 |
| Responses | DeepSeek 支持 Responses 线格式，但状态、角色、工具和参数存在明确兼容边界 | 保留 Chat 基线，以隔离适配器做 A/B，达标后再迁移 |

## 1. Thinking 与 reasoning replay

[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) 明确区分了普通多轮对话与带工具的思考循环：

- Thinking 当前默认开启，默认 reasoning effort 为 high；官方定义的 effort 映射并不是每个客户端标签都对应一个独立档位。
- Thinking 模式下，`temperature`、`top_p`、`presence_penalty` 和 `frequency_penalty` 不生效。不能靠反复改这些参数提升创造性，也不应让无效变化扰动稳定请求前缀。
- 一旦请求包含工具，后续请求必须完整带回此前 assistant 消息中的 `reasoning_content`，同时保留对应 `tool_calls` 和工具结果。任何一段历史 reasoning 被漏掉，都可能得到 HTTP 400。
- 没有工具时不需要回放 reasoning；发送了也会被忽略。

因此，ColdX 应把 reasoning replay 视为适配器协议状态，而不是系统提示词内容。适配器保留原始顺序和归属，agent loop 只消费可见回答、工具调用及结果；Activity Lens 不显示原始 reasoning，也不把它写入摘要、错误详情或重试提示。这样既满足协议，又避免隐藏推理泄漏和第三次提示词注入。

## 2. 精确前缀缓存与指标

[DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) 说明缓存默认启用，命中条件是请求开头与已缓存内容完整一致。缓存单元会在请求边界形成，长内容还可能按内部间隔形成；创建缓存可能需要数秒，服务只保证尽力命中。缓存复用的是前缀预填充计算，回答仍会重新生成。

DeepSeek Chat usage 的官方字段是：

- `prompt_cache_hit_tokens`：从缓存读取的输入 token；
- `prompt_cache_miss_tokens`：没有命中、需要新计算的输入 token。

DSH 投影到 ColdX 后对应 `cacheReadTokens` 与 `uncachedInputTokens`。ColdX 的缓存读取率应严格计算为：

```text
cacheRead / (uncachedInput + cacheRead)
```

只有这两个字段同时存在时才展示比率；两者都为零才展示 `0`。`cacheWriteTokens` 不属于本次请求输入的 read/miss 分割，`outputTokens` 是生成成本，两者都不能进入分母。提供方不报告字段时状态是未知，不是零命中。

为了提高真实命中率，请求应把高复用内容固定在前：提供方和模型不变量、确定排序的工具清单、稳定身份与工作规则、不可变检查点，然后再追加会话历史、易变上下文和当前输入。工具定义、段落顺序或空白变化都会改变精确前缀，不能把“语义相同”当作缓存相同。

## 3. DSH `PromptSection` 与 `PromptContext`

[DSH System Prompt Assembly](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/system-prompt) 给出了两个不同的原生扩展面：

- `PromptSection` 用于系统提示词片段。片段按 `order` 排序，同序时再按名称的 code-unit 顺序排序；它可以是静态文本，也可以在组装时求值。相同注册进程内的 section 是只读定义。
- `PromptContext` 用于会变化、但仍需可回放的上下文。DSH 按顺序生成上下文快照；只在快照变化，或压缩移除了旧快照时，才把完整当前快照追加到保留历史之后。

ColdX 的落地原则是单一所有者：身份、执行闭环、UI 生成规则和工具选择规则各自在一个稳定 `PromptSection` 中定义；Goal、Plan、工作区状态和阶段性摘要等动态事实进入 `PromptContext` 或原生会话事件。不要同时在 preset、provider system prompt 和运行时 correction 中重复同一段规则。动态状态没有变化时不重复写入，这同时减少 token 和缓存前缀抖动。

上述是基于 DSH 官方扩展模型的设计方向。是否能在 rc.2 使用某个具体注册签名，仍需以已安装包的类型、运行测试和真实会话日志为准。

## 4. Root Pro 与 child Flash

[DeepSeek 的 Claude Code 集成](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/) 给出了明确的模型分工先例：默认/root 使用 `deepseek-v4-pro[1m]`，subagent 使用 `deepseek-v4-flash`；配置中的 Opus 路由到 Pro，Haiku/Sonnet 路由到 Flash。这说明 DeepSeek 官方认可“强模型负责主任务、快速模型负责子任务”的 agent 配置。

[DSH Subagent](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subagent) 则说明，子智能体可以带 provider/model 等 `agentOptions`，但只有提供方能力声明支持覆盖时才会生效。进程内提供方可以合并覆盖；部分外部 ACP 提供方会拒绝这些选项。可继续的子智能体还必须保存已经解析的 provider、model 和 reasoning 配置，不能在恢复时静默换模型。

ColdX 可采用以下能力门控路线：

1. Root 用 Pro 处理目标分解、架构决策、跨文件整合和最终验证。
2. Child 用 Flash 处理边界清晰、可独立验收的检索、局部实现和测试任务。
3. 分派前检查提供方是否支持 per-agent model override；分派后从原生记录核对实际解析出的模型。
4. Flash 结果必须回到 root 汇总和验收，不能因子任务“完成”就推断主目标完成。

这仍是 ColdX 的路由方案，不是对 DSH 0.1.1-rc.2 默认行为的描述。官方 Claude Code 示例也不能证明任意自定义网关或 DSH 提供方已经实现同样的覆盖语义。

## 5. DSH 原生 retry 事件

[DSH Persistence Catalog](https://deepseek-harness.github.io/deepseek-harness/en/reference/persistence-catalog) 把 `llm/retry` 定义为排定重试的持久记录，把 `llm/retry-started` 定义为等待结束、下一次模型尝试开始前的持久转换。[DSH LLM Streaming](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/llm-streaming) 进一步说明一次 adapter 调用对应一次 provider attempt，库级隐式重试应关闭；失败以安全、提供方中立的结构进入 agent loop，再由原生策略决定恢复或结束。

ColdX 不应通过额外系统提示或用户消息要求模型重试。Activity Lens 直接读取 DSH Chat 中当前 `model-retry` 尝试，并采用以下可见状态：

| DSH current attempt | Activity Lens | 含义 |
| --- | --- | --- |
| `scheduled` | `waiting` | 已排定，等待下一次尝试 |
| `started` | `running` | 下一次 provider attempt 已开始 |
| `cancelled` | `cancelled` | 这条重试链已取消 |

标题应包含当前次数和最大次数。详情只允许 provider、delay、failure code 与清理后的 message；`policyKey`、stack、prompt、reasoning 以及旧尝试内容都不进入界面。这样能让用户看到模型正在等待或再次请求，同时不暴露策略内部标识和敏感上下文。

官方滚动文档还描述了比上述事件更完整的失败与默认策略语义。ColdX 在 rc.2 上只依赖已经由安装包和测试确认的节点字段，不把最新文档中的默认次数或错误分类反向宣称为 rc.2 能力。

## 6. Responses API 的兼容边界与 A/B 路线

[DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/) 支持 Responses 风格请求、带单调 `sequence_number` 的语义 SSE 事件，以及 `completed`、`incomplete`、`failed` 等终止事件；流不会再附加 Chat Completions 的 `[DONE]`。但它不是 OpenAI Responses 的完整替换：

- 服务保持无状态，`previous_response_id`、conversation 和 `store` 不受支持；
- `developer` role 按 user 处理，不能依赖它保持独立的高优先级语义；
- 工具只部分兼容。function 与 web search 有支持，custom tool 只支持特定的 `apply_patch` 形式；file search、code interpreter、computer use、MCP 等内置工具会被忽略；
- `parallel_tool_calls` 和 `max_tool_calls` 等字段没有 OpenAI 同名参数的控制效果；
- `prompt_cache_key` 与缓存保留参数不支持，DeepSeek 仍自动管理前缀缓存；
- 不支持的参数可能被静默忽略，HTTP 200 本身不能证明协议语义等价。

[Create Response API Reference](https://api-docs.deepseek.com/api/create-response/) 是适配器的线协议依据。[DeepSeek 的 Codex 集成](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) 证明官方提供了基于 Responses 的 Codex 接入路径，但不证明现有 DSH Chat adapter 可以只改 URL 就获得相同能力。

建议保留两条可回滚路线：

| 路线 | 用途 | 进入条件 |
| --- | --- | --- |
| A：现有 Chat/DSH adapter | rc.2 生产基线 | 继续运行已有工具、会话、重试和 reasoning replay 回归 |
| B：隔离 Responses adapter | 实验组 | 独立实现事件解析、状态管理、角色降级和工具能力门控 |

A/B 使用相同的长前缀任务和工具任务，至少记录任务成功率、有效工具调用率、协议修复率、provider attempts、首 token 时间、缓存读取率、总输入与输出 token。B 只有在真实工具闭环、取消、错误、重试和历史恢复都达到基线后才可扩大；若某字段被静默忽略或能力未声明，应立即回到 A，而不是用提示词模拟缺失协议。

## 7. 当前网关的两轮协议 canary

本轮对现有网关 base URL 的 `/chat/completions` 做了一个局部两轮探针，模型为 `deepseek-v4-flash`，Thinking 开启。探针没有记录具体提示文本或 API key。

| 轮次 | 请求形态 | 结果 |
| --- | --- | --- |
| 1 | 最小工具定义，并要求模型产生一次工具调用 | HTTP 200；`finish_reason=tool_calls`；返回 `reasoning_content`，工具参数与定义精确匹配 |
| 2 | 原样回放第一轮 assistant 的完整 `reasoning_content`、`tool_calls`，再附工具结果 | HTTP 200；`finish_reason=stop`；返回可见文本；usage 为 `cache_read=941`、`cache_miss=132` |

按 read/(miss+read) 计算，这次第二轮缓存读取率约为 `87.7%`。这里的 `cache_read`、`cache_miss` 是该网关返回的字段名，不能替代 DeepSeek 官方字段契约。

这个 canary 只确认了当前网关、当前模型和这组最小输入可以完成 Thinking 工具调用、完整 reasoning replay、工具结果续写和缓存 usage 返回。它不代表其他网关、其他模型、并行工具、长上下文、重试错误或 Responses 路线已经兼容，也不能替代 DSH 端到端会话测试。

## 8. 实施顺序

1. 先固定 `PromptSection` 的内容与确定顺序，把动态事实收敛到 `PromptContext`/原生会话事件，消除多次提示词注入。
2. 保持 Chat 路线为基线，持续验证 Thinking 工具回放和精确缓存 usage。
3. 用提供方能力门控 root Pro、child Flash，并在每个子智能体记录中核对实际模型。
4. 把原生 retry current attempt 投影到 Activity Lens，不增加任何重试提示词。
5. 最后建立隔离的 Responses A/B 适配器；用同一任务集和上述指标决定是否扩大。
