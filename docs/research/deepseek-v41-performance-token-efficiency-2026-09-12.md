# DeepSeek V4.1：生成质量、任务成本与 ColdX 优化方案

ColdX 最值得投入的方向，是让模型更少走错路、更快取得有效证据，并可靠地完成任务。把提示词变得更长、把 reasoning 一律拉满、或者追求缓存徽标接近 100%，都不能单独实现这一目标。对于 DeepSeek，缓存输入很便宜，反复生成、返工和无效工具循环往往更值得控制。

本文以生成质量为第一约束：先保证交付、事实、交互和验证，再比较完成同一任务所需的总 token、费用和时间。核查截止 2026-09-12，模型范围以官方 **DeepSeek-V4.1-Flash** 为主；旧 V4/V3/R1、其他模型、社区网关和自托管结果均单独标注。V4.1 发布仅约两天，当前还没有足够社区复现支持“某套偏方统一提升多少”的结论。[^1]

配套材料：[实验矩阵](deepseek-v41-experiments-2026-09-12.json)、[ColdX 离线探针结果](deepseek-v41-local-probe-2026-09-12.json)、[探针源码](../../scripts/research/probe-deepseek-efficiency.mjs)。模型质量 A/B 尚未运行；离线探针验证的是宿主行为，不是模型智力。本报告和候选提示不会自动注入线上会话。

## 1. 优先决策

| 优先级 | 应做什么 | 为什么 | 完成标志 |
|---|---|---|---|
| P0 | 修正完成语义和 usage 统计，再建立每任务账本 | 当前离线夹具发现无正文也可能完成、未知缓存被投影成 0% | 协议夹具覆盖正常停止、仅 reasoning、截断、缺失 usage；未知保持未知 |
| P1 | 在工具结果首次进入上下文前减少无关内容 | 避免大日志、重复文件和大量中间数据在后续每次请求重放 | 保留完整文件和定位；关键证据可恢复；任务质量不降 |
| P1 | high 作为现有基线，按任务类别试 low / high / max | effort 改变计算量，不能保证每题单调变好 | 先通过质量门，再选择成本较低的配置 |
| P1 | 保持稳定系统前缀、工具序列和合法 reasoning replay | 错误回放可能请求失败；随意改写历史可能重建缓存 | 真实 hit/miss 和费用有记录，协议无退化 |
| P2 | 小范围 PTC、带验证的恢复策略、按任务检索的经验 | 降低往返与重复试错，同时控制额外编排成本 | 对应任务集出现可重复收益，简单任务不被拖慢 |
| P3 | 用可执行反馈优化提示；有训练资源后再评估权重训练 | 托管 API 客户端无法直接训练供应商权重 | 区分提示适配、经验记忆和真正的 RL，分别计费验收 |

这里的优先级是工程判断，不代表这些修改已经上线。源码观察以 ColdX `2818efdedfe5b28c36f6e56628671ca82c7dc68f`、锁定的 DSH `0.1.1-rc.2` 及仓库兼容补丁为基线。[^38]

## 2. 先确认使用的究竟是什么模型和协议

### 模型名与公告变化

官方当前 `deepseek-flash` 对应 V4.1-Flash；旧 `deepseek-v4-flash` 和 `deepseek-v4-flash-vision-exp` 转发到它。当前价格页仍提供 V4-Pro-0813。9 月 10 日公告曾给出 Pro 的后续转发时间，但最新价格页明确继续提供 Pro；不应继续照搬已被修订的退役安排。第三方 URL 上同名模型不自动等于官方权重、参数处理和价格。[^1][^2]

每次实验必须固定提供方、端点、模型请求值、响应模型值、日期、客户端版本和实际参数。模型自称“我是 V4.1”，以及界面上的展示名，都不构成路由身份证据。网关不返回的内部实现只能记为未知。

### 能力合同与容易误用的参数

| 项目 | 当前官方资料支持的结论 | ColdX 应采取的做法 |
|---|---|---|
| 推理档位 | 托管 API 使用字符串 `none/low/high/max`；权重 encoder 支持 1–100，公开 low/high/max 对应 50/75/100 | 发送 canonical 字符串；不能把 encoder 的任意整数能力当成 API 合同 |
| 输出预算 | Chat 生成总量（含 reasoning）上限 393,216；省略时非思考 8K、思考 64K、max 档 128K；输入与生成合计仍受 context 限制 | 当前源码配置 384,000 是显式 cap，不是精确 API 最大值；cap 不等于实际用量 |
| 采样 | thinking 下 temperature 不生效、top_p 下限 0.95；非 thinking 下 top_p 固定 1.0；frequency/presence penalty 已废弃 | 不在 thinking 场景宣传 temperature=0 等“神值” |
| 强制工具 | Chat thinking 下不支持 required/指定工具 | 使用支持的选择模式和本地参数校验，不靠强制工具补偿提示不足 |
| 严格 schema | beta strict 有约束，不能照搬所有 JSON Schema 关键字 | 按端点验证 schema 和拒绝路径，保留本地验证 |

以上分别依据 Chat schema、Thinking Guide、工具指南和官方 encoding。托管参数、自托管推荐值以及第三方兼容参数需要分开处理。[^3][^4][^5][^6]

在 thinking 工具会话中，后续带 tools 的请求需要完整回放历史 assistant 已返回的 `reasoning_content`，包括没有调用工具的历史 turn；删掉它可能触发协议错误，也不应为未返回 reasoning 的消息编造内容。这个回放本身会增加后续输入，不能把“清理所有历史思考”当成无损节省。最新 Chat streaming 说明在 `[DONE]` 前最后一个 chunk 提供 usage：choices 恰有一项，finish_reason 非空，没有新增内容，而非额外的空 choices 用量包；adapter 应覆盖这两种供应商形态。[^3][^4]

Responses 兼容端点仍是无状态接口；`previous_response_id`、`context_management`、缓存保留/键参数和若干内置工具不能按 OpenAI 原端点语义推定。Anthropic 兼容的 `thinking.budget_tokens`、`cache_control` 也不能用作 DeepSeek 的硬预算或缓存开关。优先保留 DSH 原生 DeepSeek adapter，换端点必须有合同测试。[^7][^8]

### 技术报告对“拉满”的真实支持范围

官方报告 p34 和 Appendix B.2/p48–49 表明 effort 控制计算倾向，并非硬 token 预算。编程任务准确率曲线存在平台或回落，不能推出每个任务 max 都更准确；“中档拿到大部分能力”的概括也不是各 benchmark、各档位都满足的保证。p35/Figure 9 中 DeepSWE 的 effort80 和 max 约为 130K 与 215K，属于读图近似值，前者并没有低于后者一半。[^9]

因此质量优先的方案是保留 high 基线，对困难任务单独比较 max；对于纯格式化、简单抽取才试 low/none。失败升级也需要新证据，例如可复现测试失败或未解决的约束，避免把同一长提示重新跑一遍当作恢复。

## 3. “少 token”和“少钱”需要两本账

任务总 token 应包含主代理、子代理、摘要、标题等辅助请求以及失败重试。每个请求采用 `input_tokens + output_tokens`；reasoning 若已经包含在 output 中，只作为分项展示，不能再加一次。usage 缺失时报告覆盖率和未知部分，不制造完整账单。

官方 Flash 价格快照如下，单位为每百万 token；这是官方价格，不是任何第三方网关报价。高峰为北京时间工作日 9–12、14–18，其余时段半价。[^2]

| 时段 | 输入 cache hit | 输入 cache miss | 输出 |
|---|---:|---:|---:|
| 高峰，人民币 | ¥0.04 | ¥2 | ¥8 |
| 谷时，人民币 | ¥0.02 | ¥1 | ¥4 |
| 高峰，美元 | $0.006 | $0.30 | $1.20 |
| 谷时，美元 | $0.003 | $0.15 | $0.60 |

依据这个快照，**1 个输出 token 的标价等于 200 个缓存输入 token，或 4 个未缓存输入 token**。5,000 个无效输出 token 的价格等于 100 万个缓存输入 token。这是价格比例计算，不是性能实测；它解释了为什么应优先观察空转推理和返工。

```text
request_cost = (cache_miss × miss_price
              + cache_hit × hit_price
              + output × output_price) / 1,000,000
task_cost = 所有请求费用 + 外部工具/计算费用
cost_per_accepted_task = 所有尝试的总费用 / 验收通过的任务数
```

如果 accepted=0，应报告无法计算/无穷成本，不删除失败样本。已包含在任务账本中的摘要和子代理调用不要二次加钱。当前上下文占用与累计 input usage 也是两个不同指标：历史被压缩后，累计用量不可能倒退。

### 为什么压缩可能反而更贵

下面是一个**假设算例**，不是 ColdX 或网关测量：改写旧历史使 200,000 个原本缓存的保留 token 需要重新计算，同时删掉 80,000 个未来每轮可缓存 token。

```text
一次重建的额外费用 = 200,000 × ($0.30 − $0.006) / 1M = $0.0588
以后每次节省费用   =  80,000 × $0.006 / 1M          = $0.00048
静态回本轮数       = 0.0588 / 0.00048                = 122.5
```

忽略摘要费用、质量、延迟和实际缓存变动，至少要 123 次后续调用才覆盖这个重建差额。真实服务不一定满足假设，但足以说明“上下文短了，所以账单一定下降”的推理不成立。更稳的候选是**首次写入工具结果时就提取有效信息**；历史压缩则在阶段转换或必要时执行，并测量重建开销。

## 4. 缓存和上下文治理应怎样配合

当前缓存指南要求匹配已持久化的前缀单元。`A+B` 后发 `A+C` 不保证第二次已经命中 A；服务识别并持久化公共前缀后，后续请求才可能命中。缓存构建和清理是 best effort，不能把历史公告的 64-token 粒度或报告内部 72 小时保留机制，当成当日托管 API SLA。`user_id` 还会隔离缓存。[^9][^10][^11]

Manus 的原始工程经验支持稳定前缀、确定性序列化、保留可恢复文件引用；它的内部 action masking 并不意味着所有 API 都开放同样的 logit 控制。[^12] 对 ColdX，具体可以这样组织：

1. 系统层只放稳定职责、工具契约和完成语义；避免开头不断变动的时间、随机例子和重复注入。
2. 工具注册保持稳定顺序；能力首次加载有明确边界，不在每次调用前随机重排、删加全部 schema。
3. 当前目标、验收条件、失败证据和新检索内容作为后续上下文增量；不要每轮重写早期系统块。
4. 保存完整日志和文件，在模型上下文中返回定位、关键片段与结果摘要；需要时再打开。
5. 压缩保存任务约束、已作决定、失败原因、产物路径和待办，并保持 tool call/result 配对及协议要求的 reasoning。

“The Complexity Trap”在 Qwen/Gemini 与 SWE-agent 上发现，简单遮蔽旧 observation 经常有成本优势，LLM 总结并不稳定胜出；但其 Gemini thinking 的某个设置也出现显著 solve-rate 下降。窗口大小、价格模型和任务长度影响结论，不能把论文标题理解为完全无损。[^13] 包含 V4 Flash 的 observation-masking 研究同样提醒：稀疏证据适合筛选，激进遮蔽也可能丢掉有效信息；它不是 V4.1 复现。[^14]

ColdX 可先做三层上下文：最近行动保留完整细节；已完成阶段保留证据索引与决策；跨任务经验按需要检索。这里是工程方案，不是另造代理循环。状态、调用、权限仍归 DSH；界面的折叠展示不应修改原始持久化记录。

## 5. 让模型务实、自主、能生成好页面

### 明确任务契约，减少空泛角色设定

社区 `dsh-prompt-optimizer` 把目标、事实、范围、约束、完成标准和交付分开，有助于检验需求是否完整，但目前属于作者经验与模板实现，缺少 V4.1 受控收益实验。[^15] 可测试的做法是保留同等信息、消除冲突，而不是把一句需求自动膨胀成几千字。

下列为 **ColdX 候选规则草稿**，不是现有系统提示，也没有注入线上：

```text
从请求、工作区事实和已有决定中确定要交付的结果与验收条件。
信息足够时直接执行；只在缺失信息会改变正确性或授权边界时停下。
选择能推进任务的最短有效行动；发现失败时带着新证据调整方法。
页面任务交付可使用的页面：真实内容、必要交互、深浅主题、窄屏与错误状态。
需要用户选择时，在当前工具调用处生成交互，并在提交后继续原任务。
依据测试、浏览器状态、文件和其他可核验结果判断完成，不以自己的描述代替验证。
答复说明结果、可点击产物和仍未解决的问题，细节与任务复杂度相称。
```

保持创造性需要给予目标层的自由，同时固定真正重要的约束。页面任务可以在验收中要求内容层次、清晰视觉方向和真实交互，避免对每一处布局写死模板。模型应根据已有设计系统选择实现，不用每次展示一份长计划、输出多套页面或反复解释设计哲学。

### 生成之后的检查比“你是顶级设计师”更有价值

建议把页面任务的完成条件落到实际检查：页面是否渲染，主要操作是否有效；深色/浅色和窄屏是否可读；文件或产物链接能否打开；有无运行错误；修改有没有破坏已有交互。浏览器验证只在能发现相关问题时使用，截图、DOM 和错误日志各自回答不同问题，避免每改一行都完整截图。

同一错误连续出现时，恢复策略应要求新信息：看实际错误、缩小复现、确认版本或读取相关源码。社区 anti-stuck 插件提供这种实现思路，但其 n=1、字符估算用量的案例不能证明普遍提升。[^16] 原生工具错误和失败证据应保留；重复相同调用不能获得无限重试许可。

### 不把简短回答误当作简短计算

先测“只缩短最终答复”，再测短草稿。Chain of Draft 原论文使用 GPT-4o/Claude 3.5 Sonnet，部分任务省输出且保持或提高准确率，但 GSM8K 从约 95% 降至约 91%，zero-shot 差距更大；不能只摘录最高省 token 百分比。[^17] 强制每步五个词或强制反复自省，均不应成为 V4.1 生产默认值。

短且清楚的交付说明通常是产品改进；是否减少 reasoning，需要真实 usage 分项证明。更长推理也不必然更好，一项研究在 R1 的 1.5B/7B/8B 蒸馏模型上观察到强制续写思考的收益饱和和退化；它未测试完整 R1 或厂商 reasoning_effort，不能作为 V4.1 的既定失败率。[^18]

## 6. 工具、PTC、多模态和子智能体

### 工具数量不是唯一变量

官方报告 Appendix B.2 对比 Standard、PTC 和 Minimal scaffold，工具面与执行形式同时变化；这不是只改变工具数的因果消融。因此不能从某个 scaffold 分数直接推出“越少工具越聪明”或“所有事情都用 bash”。[^9]

当前 ColdX 浏览器工具已有按需加载，native schema 也有确定性排序。下一步应检查工具语义是否重叠、描述是否重复、返回内容是否适合下一步决策，而非先把正确机制拆掉。

### PTC 适合大量机械编排

PTC 指程序化工具调用：让代码完成多次调用、过滤和聚合，只把必要结果返回模型。Anthropic 在其复杂研究任务中报告输出中间数据减少的收益，但 Claude 的比例不能当 DeepSeek 指标。[^19]

DSH `dsh-ptc-plus` 当前作者矩阵为 9 类任务 × 2 次 × 2 组，共 36 个 sessions；记录的路由名为 `opencode-go/deepseek-v4-flash`，底层权重版本未核实，比较已经使用 PTC 的 DSH 加/不加插件。模型逻辑请求步骤 66 对 88、token traffic 729,642 对 942,901、盲评 138/162 对 118/162，显示值得复验的信号；但两组分别 2/18 和 5/18 超过机器预算，整体没有通过 machine acceptance。被测版本和实验日期未能从当前报告确认，不能套用旧实验版本。[^20] 另一个小型直接工具/PTC 基准提示，只有几次明确读取时，强制写编排代码未必划算。[^21]

ColdX 候选策略是：少量确定动作直接调用；批量检索、计算、格式转换用程序；需要中途判断的步骤交回模型。持久 REPL 要验证旧变量、重复执行副作用、取消恢复和权限传播。它不能代替完成验证，也不能脱离 DSH 自建权限更宽的执行器。

### 图片需要按任务选择分辨率

当前官方 Vision 页给出每图最多 1,024 tokens，旧摘要里的 384 已过时。Files API 复用 file_id 减少重复上传，不代表每次视觉理解免 token；PDF/Office 不属于该 Files API 支持的图像格式。[^22][^23] 社区 V4.1 原始探针发现尺寸影响计量，detail 提示在其测试未改变结果；这是小型协议/计费观察，不是裁剪后视觉质量相等的证明。[^24]

对界面任务，先使用可定位的 DOM/文本处理确定操作，需要判断视觉或坐标时提供截图；对 PDF 保留文字层、页码、表格与必要页面图。试原图、适度缩图和相关区域裁剪三组；小字和跨区关系必须验收。多张局部图可能更贵，也可能失去全局关系。不要根据 low 名称承诺固定节省。

### 子智能体需要明确的收益条件

子代理适合独立调查、不同文件模块、独立验证等可以并行的任务。Anthropic 的研究系统经验表明多代理可能明显增加总用量，其“约 15 倍”参照是普通聊天，不能说成比单代理多 15 倍，更不能当 DeepSeek 的固定倍数。[^25]

建议给每个子任务最小必要材料、明确交付、可核验来源及边界，主代理汇总差异而非粘贴完整聊天。记录每个子任务的真实调用、耗时、成本和失败。启动前先考虑是否比本地几次确定性工具调用更划算；需要串行共享大量上下文时，不为了“并行”强拆任务。

## 7. 民间偏方逐项判定

证据等级：**A** 为当前官方协议；**B** 为可复核的研究或配对实验，但需检查模型与任务；**C** 为作者现场记录或实现；**D** 为未受控主张、口号或反例。等级表示证据来源，不表示可以直接上线。

| 做法 | 证据与适用范围 | 判定和可执行试法 |
|---|---|---|
| 六要素任务模板、末尾重申关键限制 | C，V4.1 社区模板 [^15] | 值得试等信息结构化，不能发明需求；只重申关键约束 |
| 只减少最终答复的重复解释 | 工程候选 | 优先小试；验收产物、事实和必要说明不减，单列 reasoning 与 final |
| Chain of Draft、每步极少词 | B，原论文其他模型；C，V3/R1 个例 [^17][^26] | 小题探索；原论文也有准确率下降，不做复杂编码默认 |
| 请求完整重复两遍 | B，含 V3 的非推理实验；推理组总体收益弱 [^27] | 仅短抽取/分类的候选；输入增多，不能叫免费省 token |
| 中文/英文“解锁能力” | C，V4/V4.1 相反体验 [^28] | 固定等义内容再盲评；明确最终语言可以改善一致性，不证明隐藏智力 |
| “we need”开头、特定人称 | D，V4 Pro 个例及挑选成功样例 [^29] | 不据措辞判定路由；改测冲突提示和无关工具消融，保留全部失败 |
| 删除所有 system、变成零工具 | C/D，社区提示/插件机制 [^29][^30] | 会移除任务能力与必要契约；只测试无关内容，不全删 |
| 复制泄露的其他产品提示 | 无 V4.1 等质收益证据 | 不把别家工具名、内部流程和格式直接注入；只研究公开可验证的设计原则 |
| 无限反思、每次都 max | A/B 并不支持普遍单调提升 [^9][^18] | 以可执行失败证据触发一次有界恢复，记录所有额外调用 |
| temperature=0、“神奇采样值” | A，thinking 下 temperature 无效 [^3] | 先核实参数生效；自托管吞吐脚本不是准确率基准 |
| 持久 PTC REPL | B/C，DSH 插件小规模配对，路由标签不证明底层权重 [^20][^21] | 批量任务优先候选；简单任务保留直接调用对照 |
| 大日志 spill、有界预览、定位后再读 | C，原作者纠正后的 DSH 现场记录 [^31] | 检查真正进入上下文的数据；完整证据可恢复，避免盲删中段 |
| 遮蔽旧工具观察、混合摘要 | B，含 V4/其他模型 [^13][^14] | 检查证据召回、重读、缓存重建和质量；窗口值不能照抄 |
| 每轮注入全库记忆、所有 skills | C，约 310KB/轮图记忆现场问题 [^32] | 按任务取少量可追溯内容；稳定前缀不要随检索结果重写 |
| TOON/TRON 代替全部 JSON | B，其他开源模型格式实验 [^33] | 可试规则表格的 tool-result 表达；保持 native 工具 wire grammar 和 schema |
| gzip/base64 压缩后让模型直接看 | 无 V4.1 质量证据；工程推论 | 字节压缩不等于 token 减少；压缩适合存储，交给模型前由程序解码/筛选 |
| 图片 low、裁剪、复用 file_id | A+C，官方与 V4.1 小样本 [^22][^23][^24] | 测实际计量和小字正确率；上传复用不等于视觉 token 免费 |
| 无限/解锁插件让模型更聪明 | D，主要拒答评分及离线提示检查 [^30] | 不作为默认能力优化；只比较无害任务正确率，不能用拒答减少代替质量 |
| 量化、并发或自托管吞吐“吊打官方” | C，硬件与短输入测速 [^34] | 分离部署效率和质量等价；模板、量化、工具解析、长上下文都需要回归 |
| fake cache key、强制缓存字段、半夜 Batch 折扣 | A 不支持这些泛化 [^7][^8][^10] | 只按支持端点及实际 hit/miss 判断；错峰价格已验证，额外 Batch 折扣未找到合同 |

三个特别值得纠正的案例：V4.1“省 43% tokens”的 Reddit 比较中，新模型还有任务进行中/待做，旧模型已完成全部 11 项，完成条件不等价；DSH #4758 作者已经撤回“spill 未装配”的初始判断；`dsh-ptc-plus` 搜索摘要里旧 28-session 数字也不是当前 36-session 报告。阅读原帖、修订和失败样本，比收集成功截图更有用。[^20][^31][^35]

格式压缩尤其容易掩盖损失。“Notation Matters”在 prompt mode 下测试较小开源模型，未测试 V4.1：改写模型输出的工具调用格式会产生解析失败和多轮级联错误；只压缩输入的组也同时改了 schema 与结果，不能归因于结果压缩单项。[^33] 对 ColdX 的建议是先测规则数据结果的表达，保留 native 工具调用协议。

## 8. ColdX 当前源码和离线行为

这里区分**已复现行为**、**源码事实**和**待验证风险**。没有读取私人会话、密钥或本机提供方配置；默认配置描述不代表当前活跃会话路由。可重复探针与静态指标见配套 JSON，完整方法见脚本。[^38]

安装仓库锁定依赖后，在仓库根目录执行 `node scripts/research/probe-deepseek-efficiency.mjs` 即可输出 JSON。该命令使用内存合成 adapter，不发起真实模型请求。当前结果已重复运行核对一致；更新 DSH 或相关源码后，版本、指纹及观察结果可能变化。

| 类型 | 观察 | 对质量/费用的影响 | 下一步 |
|---|---|---|---|
| 已复现 | 合成模型仅返回 reasoning 后 stop；可见正文 0，native 和 ColdX flow 均 completed | 可能把没有交付当成成功 | 区分正常可见停止、合法控制标记、无结果停止；保留现有“不强制输出”行为 |
| 已复现 | provider usage 未报告缓存字段，累计投影补 0，徽标变为已知 0%；reasoning 分项丢失 | 当前徽标无法可靠评价优化；缺失与真实零混淆 | 保留字段报告状态和计量来源，补逐请求维度 |
| 源码事实 | 默认生成配置是官方 deepseek-flash、thinking/high、1M context、384,000 output cap | 与旧研究取样时默认路由不同 | 旧文档保留时间边界；实测记录实际路由，不从默认推断 |
| 源码事实 | 浏览器按需挂载、schema 排序、reasoning 回放和子代理路由继承已有实现 | 有利于协议与缓存稳定 | 保留并增加真实供应商合同夹具 |
| 源码事实 | 工具结果 pruner 在压力/overflow 路径触发；未必在每个长结果首次出现时调用 | 大结果可能在达到阈值前重复回放 | 测首次 observation 有界化与后续定位读取 |
| 源码风险，未复现 | runtime context 在 pre-step waterfall 前生成，压缩在 waterfall 内发生 | 同一步可能使用压缩前快照 | 构造隔离压缩夹具后再判断是否修复 |
| 源码风险，未复现 | max-tokens 状态有粘滞终止路径；shell-only 路径发现可能遗漏子目录指令 | 截断恢复与约束读取需覆盖 | 分别构造截断继续和 shell-only 子目录场景 |
| 尚未实现 | 自动 effort 路由、完整长期记忆晋级和真实模型评测运行器 | 提示里的愿景不能视作运行时能力 | 先完成观测，再逐项实现与验收 |

默认 compaction 压力为窗口约 80%、保留近期约 16%，是原生内部预算；不能直接说模型精确占用了 800K/160K tokens。摘要请求有自己的输入输出费用，默认路径也可能继承当前 high，不应漏计或免费化。

五个 ColdX preset 工具定义序列化共 6,556 个 JavaScript 字符；PERSONA 与 OPERATING_POLICY 合计含分隔符 5,870 字符。两者都**不是模型 token 数**，工具统计也不包括完整 native preset、Host browser、marketplace 或用户插件。可以消融重复描述，但不能据此声称整个请求减少某个百分比。

源码锚点：默认配置 [`lib/profile.mjs`](https://github.com/DCM-dc/ColdX/blob/2818efdedfe5b28c36f6e56628671ca82c7dc68f/lib/profile.mjs#L314)，缓存显示 [`session-controls-source.mjs`](https://github.com/DCM-dc/ColdX/blob/2818efdedfe5b28c36f6e56628671ca82c7dc68f/plugin/client/session-controls-source.mjs#L26)，浏览器加载 [`computer-host.mjs`](https://github.com/DCM-dc/ColdX/blob/2818efdedfe5b28c36f6e56628671ca82c7dc68f/plugin/computer-host.mjs#L58)，策略 [`policy.mjs`](https://github.com/DCM-dc/ColdX/blob/2818efdedfe5b28c36f6e56628671ca82c7dc68f/plugin/policy.mjs#L9)。原生依赖位置和版本由探针附录记录，避免将 node_modules 内部实现误当 ColdX 自有源码。

## 9. 可执行的评测与落地顺序

### 先过协议和质量门

离线阶段不调用模型，先覆盖上述完成语义、缺失 usage、最终流式 chunk、reasoning replay、截断后恢复与压缩时序。记录现状的探针和验证目标的回归测试用途不同：不能把观察到的缺陷写成必须永远成立的产品契约。

之后才运行真实供应商 canary：固定一个官方路由及一个需要支持的网关，验证参数、stream、tools 和图片。每个端点独立报告结果，不能把某个网关的“200 成功”视作全部能力生效。依赖输出的 paid runs 尚未执行，实验矩阵状态全部为 `not_run`。

### 任务集与单变量比较

建议使用 8 类 × 3 题的固定公开或合成工作夹具，配套确定性的产物验收；不要将私人聊天作为默认评测集。

| 任务族 | 必须验收的结果 |
|---|---|
| 页面生成与后续修改 | 首次可用、交互有效、深浅主题、窄屏、修改保持已有能力 |
| 真实缺陷定位与修复 | 失败可复现、针对性检查通过、无无关破坏 |
| 多文件阅读与精确编辑 | 正确文件和符号、修改范围、事实引用 |
| PDF/图像/表格理解 | 页码来源、小字、跨页关系与计算结果 |
| 文档或结构化产物 | 文件可打开、内容完整、输出 schema 正确 |
| 批量工具编排 | 全量处理、边界记录、失败不隐藏、副作用不重复 |
| 中途纠正和长会话 | 新要求优先、旧约束保留、正确恢复 |
| 可拆分子任务 | 分工有效、归属明确、合并结果正确、成本全计 |

先用 6 题 × 每组 2 次发现协议/明显退化，不能据此宣布胜出。正式候选用 24 题 × 每组 3 次作为起点，按任务配对、随机交错顺序；此样本量也未必足以证明质量等价。不同任务族分别分析，防止大量简单题掩盖页面或复杂编码退化。

每次只改变一个变量：最终答案长度、effort、工具结果形态、PTC、摘要方式、记忆检索或提示结构。固定模型、任务、工具集、环境快照、权限和执行预算；冷热缓存分组，记录各个请求的真实 hit/miss，而非假定等待几秒就暖缓存成功。

### 指标、停止和晋级

主要指标是产物验收率、严重错误、未经证实的完成和用户可见回归。次要指标包括总 token、uncached/cached input、reasoning/final output 的可用分项、总费用、每成功任务费用、重复工具调用、恢复次数和时间。P50/P95 必须连同样本量报告；小样本的尾部指标只作描述。

质量门首先要求固定硬门槛全部通过，无新增严重回归；再比较每个任务族的成功情况和盲评。对于“同等质量”，应预先设定业务可接受的差距及置信区间方法，不能把“不显著”写成“相等”。本方案建议质量优先发布采用 0 个百分点的非劣界限；若样本无法支持结论，保留现有默认并扩大评测，不降低门槛迎合成本数字。该界限是工程选择，不是论文结论。

候选只在有成本/时间收益且通过质量门后晋级；失败、提前结束、工具超预算、重试和摘要都算入该候选。网关未报告用量时可以报告质量和已知部分，不能得出完整费用优势。每项状态、变量与停止条件已列入实验矩阵。

## 10. 长期记忆与真正的自我改进

ACE 研究以 DeepSeek-V3.1 非思考模式等骨干验证增量经验条目、反思和整理；它优化上下文而非更新模型权重。研究也指出反复整体重写记忆可能丢掉细节。该机制值得迁移测试，但其性能数字不能作为 V4.1 或 ColdX 已有收益。[^36]

ColdX 的候选记忆条目应保存：适用任务/环境、事实与做法、原始证据链接、成功/失败记录、版本、失效条件。任务开始只取相关条目；实际验证后才能把候选经验晋级。过期依赖、已经修复的错误和相互矛盾条目要可撤回。使用 SQLite 或其他数据库是存储选择，本身不会提高模型能力。

SWE-Pruner 的小模型筛选源码提供另一个方向：根据当前任务挑出相关行，在其测试范围减少上下文。[^37] 对 ColdX 先尝试确定性的检索/过滤，再考虑额外小模型；后者的部署、延迟、漏证据及推理费用必须全算。自托管部署和训练应在已有稳定任务集后评估，不能以开源或本地运行等同零成本。

### 托管模型能做提示优化，不能由客户端直接训练供应商权重

| 路线 | 实际更新对象 | 对 ColdX 的适用性 |
|---|---|---|
| GEPA 式反思提示搜索 | 根据执行反馈产生、比较和选择提示版本，模型权重固定 | 可使用托管推理 API；尚无 V4.1/ColdX 收益证据 |
| ACE 式经验适配 | 有版本和证据的经验条目、检索与增量更新 | 可以作为 DSH 原生上下文扩展，需防止错误经验传播 |
| LightningRL 等权重训练 | 将轨迹与奖励转成训练数据，更新可训练 policy 模型 | 需要自托管权重或有训练权限的后端，不能靠普通 DeepSeek 推理 API 完成 |

GEPA 原始 v1 使用 Qwen3-8B 和托管 GPT-4.1-mini，测试四个任务集；它展示的是固定权重的提示优化。候选生成、执行、反思、筛选本身需要大量 rollout，不是免费提升，也不能把相对特定训练基线的 rollout 比例当成线上任务省 token 倍数。[^39]

Agent Lightning 原论文的 LightningRL 在 Llama-3.2-3B-Instruct 上训练 SQL、RAG 和计算器任务；其中的兼容 API 是训练后端提供模型的接口，不会赋予客户端修改外部供应商权重的能力。当前框架文档已进入 v1.0 开发版并使用 GPU 训练栈，不能直接套用旧接入示例。[^40][^41]

近期可以先做窄范围 GEPA 式实验，只搜索任务胶囊、工具说明或验证策略，冻结协议和授权边界。训练/验证/测试按任务来源拆分，候选生成器不能修改验收测试或读取隐藏答案；页面质量增加独立视觉评审。所有优化成本都需按实际复用次数摊销：`每任务摊销成本 = 优化总成本 / 复用次数 + 运行成本`。一次性任务通常不适合大规模提示搜索。

真正的 RL 应等到有稳定任务分布、可靠环境反馈和明确训练后端再评估。奖励可来自测试通过、产物有效、约束满足和失败恢复，而不是模型自评“已完成”；必须防止只通过删测试、跳任务、缩短回答等方式获取高分。token 惩罚只能在完成质量约束下参与优化，训练 GPU、环境执行、失败恢复和评测成本都要纳入。

近期最有价值的顺序仍是：可靠完成与计量 → 真实任务评测 → 工具结果/effort 单变量试验 → 带证据的经验积累。这样每次改进都有机会真正降低返工，而不是只让一次回答变短。

## 来源

以下动态页面均于 2026-09-12 核查；日期未标注时不推断发表时间。论文使用所链接版本，社区数据保留任务、模型和样本限制。官方文档与官方模型报告之间有冲突时，正文已说明；社区链接不代表安装推荐。

[^1]: DeepSeek，2026-09-10，[V4.1-Flash 发布公告](https://api-docs.deepseek.com/news/news260910/)。用途：发布时间与早期别名计划；后续计划以当前价格页修订为准。
[^2]: DeepSeek，[当前中文价格表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)与[英文价格表](https://api-docs.deepseek.com/quick_start/pricing/)。用途：当前模型身份、峰谷时间和单价；本报告算例自行计算。
[^3]: DeepSeek，[Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)。用途：参数、输出上限、采样、stream usage。
[^4]: DeepSeek，[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。用途：推理档位、reasoning replay 和工具协议。
[^5]: DeepSeek，[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。用途：工具选择、strict beta 与 schema 边界。
[^6]: DeepSeek，[V4.1 encoding README](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/encoding/README.md)，核查时文件提交 `dba1be0`。用途：权重侧 1–100、前缀与 DSML；不等同托管 API。
[^7]: DeepSeek，[Responses API Guide](https://api-docs.deepseek.com/guides/responses_api/)。用途：兼容字段、无状态、内置工具和预算边界。
[^8]: DeepSeek，[Anthropic API 兼容](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/)。用途：budget_tokens/cache_control 支持范围。
[^9]: DeepSeek，2026-09-10，[DeepSeek V4.1 Technical Report](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/main/DeepSeek_V41_Tech_Report.pdf)，p19–20、p34–35（Figure 9）、Appendix B.2/p48–49。核查文件 SHA256：`ba68e2e40408125ae6d2f63a9a241b61c73910691c74ec1a2a7023c851eac08d`。用途：effort、scaffold 和内部缓存与 API 合同的区别。
[^10]: DeepSeek，[KV Cache Guide](https://api-docs.deepseek.com/guides/kv_cache/)。用途：持久前缀单元、best effort 与命中条件。
[^11]: DeepSeek，[Rate Limit/User Isolation](https://api-docs.deepseek.com/quick_start/rate_limit/)及[2024-08-02 历史缓存公告](https://api-docs.deepseek.com/news/news0802/)。用途：user_id 隔离与旧 64-token 说法的时间边界。
[^12]: Yichao “Peak” Ji / Manus，2025-07-18，[Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)。一手工程经验，不是 DeepSeek 专项基准。
[^13]: JetBrains Research 等，2025-10-27 v3，[The Complexity Trap](https://arxiv.org/html/2508.21433v3)，Tables 1、4，成本方法与局限。用途：observation masking、摘要、缓存成本和质量回归。
[^14]: i-DeepSearch，2026，[Observation Masking 原始实现](https://github.com/i-DeepSearch/observation-masking)及[论文 arXiv:2606.00408](https://arxiv.org/abs/2606.00408)。包含 V4 Flash，未验证 V4.1。
[^15]: zhang-jiazhi，[dsh-prompt-optimizer task-strength 模板](https://github.com/zhang-jiazhi/dsh-prompt-optimizer/blob/main/templates/_shared/task-strength.md)。V4.1 作者模板，未发现受控收益实验。
[^16]: Classicoke，[cleverer-dsh](https://github.com/Classicoke/cleverer-dsh)。用途：anti-stuck 实现思路；单次、字符估算案例不作精确 token 基准。
[^17]: Xu 等，2025-02-25，[Chain of Draft: Thinking Faster by Writing Less](https://arxiv.org/html/2502.18600)，Tables 1、5。用途：短草稿及原论文的质量损失；模型为 GPT-4o/Claude 3.5 Sonnet。
[^18]: 2025-10-23 v3，[Does Thinking More Always Help? Mirage of Test-Time Scaling in Reasoning Models](https://arxiv.org/html/2506.04210v3)。用途：R1 蒸馏模型强制续写思考的收益边界，未测 V4.1 或厂商 reasoning_effort。
[^19]: Anthropic，2025-11-24，[Introducing Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use)。用途：PTC 的机制和 Claude 自有任务测量，不外推比例。
[^20]: muyuanjin，[dsh-ptc-plus 当前 README](https://github.com/muyuanjin/dsh-ptc-plus/blob/main/README.md)及[评测协议](https://github.com/muyuanjin/dsh-ptc-plus/blob/main/docs/evaluation.md)。当前 36-session 作者实验，记录 opencode-go/deepseek-v4-flash 路由名，权重/实验日期/被测版本未核实；包含机器验收失败。
[^21]: xiaosu19，2026-08-21，[dsh-codex-mode benchmark-max](https://github.com/xiaosu19/dsh-codex-mode/blob/main/docs/benchmark-max-2026-08-21.md)。用途：直接工具/PTC 的任务差异；每配置一次，不能推断普遍胜率。
[^22]: DeepSeek，[Vision Guide](https://api-docs.deepseek.com/guides/vision/)。用途：当前图像上限与 detail 行为。
[^23]: DeepSeek，[Files API Guide](https://api-docs.deepseek.com/guides/files_api/)。用途：file_id 复用与支持格式。
[^24]: HenryZ838978，2026-09-10，[V4.1 多模态原始探针规范](https://github.com/HenryZ838978/deepseek-harness/blob/main/spec/07_multimodal.md)。用途：图像计量/参数观察，非视觉质量基准。
[^25]: Anthropic，2025-06-13，[How We Built Our Multi-agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system)。用途：并行研究与总用量开销；聊天为相关倍数参照。
[^26]: RooCode 社区，2025，[Chain of Draft 原帖](https://www.reddit.com/r/RooCode/comments/1juo7uz/chain_of_draft_cod/)。用途：V3/R1 用户个例，非 V4.1 A/B。
[^27]: Leviathan、Kalman、Matias，2025-12-17，[Prompt Repetition Improves Non-Reasoning LLMs](https://arxiv.org/html/2512.14982v1)。用途：含 V3 的非推理/推理条件对照；输入重复增加输入 token。
[^28]: DeepSeek 社区，[V4 语言漂移原帖](https://www.reddit.com/r/DeepSeek/comments/1u76ypp/anyone_else_suddenly_forced_to_specify_language/)、[V4.1 负面/混合反馈](https://www.reddit.com/r/DeepSeek/comments/1wc5mvx/i_was_so_surprised_and_now_instant_expert_and/)、[相反的满意反馈](https://www.reddit.com/r/DeepSeek/comments/1wcqbyf/the_new_model_is_amazing/)。用途：体现相反体验，不证明语言智力差。
[^29]: Linux.do，2026-08-14 起，[“we need”原帖](https://linux.do/t/topic/2757009)、[含失败和筛样的负面实测](https://linux.do/t/topic/2756923/1)。V4 Pro 社区个例，不是隐藏路由证据。
[^30]: Minglink，[dsh-infinite-gen-4 README](https://github.com/Minglink/dsh-infinite-gen-4/blob/master/README.md)，v0.3.0。用途：提示/零工具机制与评测边界；不复用绕过提示，不推荐默认安装。
[^31]: DeepSeek Harness 社区，2026-08-27 起，[Discussion #4758 及作者纠正](https://github.com/deepseek-ai/deepseek-harness/discussions/4758)。用途：真实传入内容、累计用量与 spill 修订。
[^32]: DeepSeek Harness 社区，2026-08-22，[Discussion #3945](https://github.com/deepseek-ai/deepseek-harness/discussions/3945)。用途：大量逐轮图记忆注入的现场追踪，不作独立因果实验。
[^33]: Kutschka、Geiger，2026-05-28，[Notation Matters](https://arxiv.org/html/2605.29676)。用途：格式压缩的准确率和结构失败、模型范围与 input-only 混合因素。
[^34]: TensorSharp 作者，[V4.1 on 8 A40](https://www.reddit.com/r/DeepSeek/comments/1we8bui/deepseek_v41_flash_on_8_a40_40_toks_q2_k_and_32/)；tonyd2wild，2026-09-10，[DGX Spark boot10 原始报告](https://github.com/tonyd2wild/DeepSeek-V4.1-Flash-vLLM-DGX-Spark/blob/main/results/boot10/report.md)。用途：区分吞吐与质量等价。
[^35]: Diru14，[V4.1 vs V4 Flash Vision Exp 原帖](https://www.reddit.com/r/DeepSeek/comments/1watjcl/deepseek_v41_flash_vs_v4_flash_vision_exp_38/)。用途：不同完成条件下的 token 比较反例。
[^36]: Zhang 等，2026-03-29 v3，[Agentic Context Engineering](https://arxiv.org/html/2510.04618v3)，§3、§4.2。用途：增量经验和上下文适配；DeepSeek-V3.1 等骨干，非权重 RL。
[^37]: 2026-01-23，[SWE-Pruner](https://arxiv.org/html/2601.16746v1)。用途：任务条件源码筛选；不是 V4.1 专项证据。
[^38]: ColdX，[源码基线 2818efd](https://github.com/DCM-dc/ColdX/tree/2818efdedfe5b28c36f6e56628671ca82c7dc68f)、仓库锁文件和兼容补丁，以及本文配套离线探针。用途：当前实现与宿主合成行为；不证明真实模型效果。
[^39]: Agrawal 等，2025-07-25 v1，[GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning](https://arxiv.org/pdf/2507.19457v1)。用途：固定权重提示搜索、原始四任务范围和搜索成本；不混用后续论文版本数据。
[^40]: Luo 等，2025-08-05 v1，[Agent Lightning: Train ANY AI Agents with Reinforcement Learning](https://arxiv.org/html/2508.03680v1)。用途：执行/训练解耦与 LightningRL；原始实验骨干非 DeepSeek。
[^41]: Microsoft，[Agent Lightning 官方文档](https://microsoft.github.io/agent-lightning/latest/)，核查时为 2026-08-26 更新的 v1.0 开发文档。用途：当前训练栈与版本边界，不代表已接入 ColdX。
