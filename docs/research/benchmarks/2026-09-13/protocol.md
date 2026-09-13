# ColdX × DeepSeek-V4.1-Flash：公开试跑协议

协议日期：2026-09-13。本文件记录三题 pilot 的固定输入、执行方式、验收范围和比较限制；不预填成绩。**三题各一次的结果不能作为官方 DeepSWE 113 题 × 8 次的可比总分。** 同模型下其他 agent 的数字来自官方报告，本项目没有重新运行那些 agent。

## 1. 试跑范围与选择规则

从固定 DeepSWE 提交的全部 113 份任务配置中，分别选择 Go、Python、TypeScript 类别里按 `task_id` 字典序排第一的任务。选择在模型结果产生前确定，每题一次，串行执行。该规则便于复现和覆盖三种工具链，不保证样本具有统计代表性。

| 类别 | 固定任务 | 次数 |
| --- | --- | --- |
| Go | `abs-module-cache-flags` | 1 |
| Python | `adaptix-name-mapping-aliases` | 1 |
| TypeScript | `arktype-json-schema-refs-dependencies` | 1 |

原始轮次在第一题期间被用户主动取消，保留为独立的 `user-interrupted` 记录，无分数，其余两题未开始。新的轮次为三个全新的单题 job，不根据旧轮次或新轮次的 reward 选择、替换、丢弃样本。原始取消轮次不进入新三题的分母，也不会被补成 0；其实际消耗独立保留供本地审计。

新轮次逐题使用独立提供方凭据进行计量隔离，模型和参数保持相同。凭据之间的缓存共享及服务端调度条件无法由客户端证明完全一致，这也是比较成本或延迟时的限制。公开材料不包含凭据标识、账户余额、主机地址、原始聊天或私人账单。

## 2. 官方来源与不可变版本

| 对象 | 固定版本与来源 |
| --- | --- |
| 模型卡和同模型 agent 对照 | [DeepSeek-V4.1-Flash 模型卡，提交 `dba1be0a40aa45a94ad051997016db3960a90277`](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/dba1be0a40aa45a94ad051997016db3960a90277/README.md) |
| 官方复现说明 | [同一提交的 evaluation/README.md](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/dba1be0a40aa45a94ad051997016db3960a90277/evaluation/README.md) |
| 官方参考集成补丁 | [同一提交的 dsh-minimal.patch](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/dba1be0a40aa45a94ad051997016db3960a90277/evaluation/dsh-minimal.patch) |
| 评测设置、框架版本及差异 | [技术报告 Table 4 / Appendix B](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/dba1be0a40aa45a94ad051997016db3960a90277/DeepSeek_V41_Tech_Report.pdf) |
| DeepSWE v1.1 | [提交 `0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`](https://github.com/datacurve-ai/deep-swe/tree/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea) |
| Pier 0.3.1 | [提交 `0c802fc067a425345b24d1c69411aa98acf61a1d`](https://github.com/datacurve-ai/pier/tree/0c802fc067a425345b24d1c69411aa98acf61a1d) |
| ColdX 基础提交 | [`7d5b6b80a106f770f1127a7294c77cb196e6bace`](https://github.com/DCM-dc/ColdX/tree/7d5b6b80a106f770f1127a7294c77cb196e6bace)；另应用本次冻结的 policy 副本，详见下文 |

DeepSeek 技术报告的本地核对文件 SHA-256 为 `ba68e2e40408125ae6d2f63a9a241b61c73910691c74ec1a2a7023c851eac08d`。API 使用官方 `deepseek-flash` 路由，客户端记录运行日期与响应模型名；托管服务的内部权重和路由不是客户端能够冻结的本地文件。

## 3. 被测对象：完整原生 ColdX

执行链为 Pier adapter → session 入口 → ColdX 原生 Web profile → ColdX preset → DSH 原生 agent。保持 ColdX 的 policy、文件和 shell 工具、子智能体、浏览器、生成页面、交互和插件功能；没有用另一个简化的模型循环替换 ColdX，也没有套用官方 DSH Minimal 作为被测对象。

评测插件负责一次性提交任务、在原生 hook 中固定模型参数和步数上限、等待根/子/后台孙智能体完成、导出原生事件和状态。工具选择、执行和重试由原生 DSH 负责。完整工具存在不意味着离线任务能使用任意网络服务；浏览器和插件工具同样受测试容器的出口限制。

软件版本为 ColdX `0.1.2`、`@deepseek-ai/dsh 0.1.1-rc.2`（包含仓库原有兼容补丁）、Node `24.16.0`、pnpm `11.19.0`。宿主为 WSL2 上的 Ubuntu `24.04.4`，Docker `29.8.0` / Compose `5.5.1`；任务操作系统仍由下文固定的 Debian 12 镜像决定。依赖使用冻结 lockfile 安装，Linux 构建在正式试跑前完成。

本次源码快照含 142 个文件。与基础 Git 提交相比，唯一内容修改是 policy；另外 11 个客户端文件存在 Windows 换行差异。**仅检出基础提交并不等于被测快照。** [冻结基线说明](../../../../eval/benchmark/frozen-baseline/README.md) 提供独立 policy、无本机路径的文件清单和精确换行恢复方法。它属于评测输入，不把既有工作区修改伪装为本轮产品功能变更。

| 身份层 | SHA-256 |
| --- | --- |
| 原始 142 文件 source manifest | `a4813fc1b6e37bec2b2318f3e990a35ec0cada7cbd33778e5e7022e42acff700` |
| 实际 policy 文件 | `c0bbc521d0ed1ace478b9d2d0f64f46c009a48de4299981fbe345de6cf1170c3` |
| 完整 Linux 运行产物集合 | `6544a8ee873fb315f7bc2d84e37d34039164ee442babee392ec4961d7ea6d640` |

运行产物摘要覆盖 app、Node、browsers、harness 四个角色；文件清单包含相对路径、类型、权限、文件大小与内容哈希，符号链接记录目标。总摘要对各角色排序后的规范 JSON 计算，不包含捕获时间和机器根目录。新机器重建必须重新核对源码和产物，不应直接声称复用了本次二进制摘要。

## 4. 模型参数、预算与资源

| 项目 | 本次配置及含义 |
| --- | --- |
| 提供方 / wire 模型 | 官方 DeepSeek / `deepseek-flash` |
| 推理档位 | `max`，对应官方报告的 effort 100 |
| 请求参数 | `temperature=1.0`、`top_p=0.95`；外层代理核对实际发送字段 |
| 上下文 | 1,000,000 tokens；不把上下文大小当作输出 token 预算 |
| 原生步数 | 每个 agent 累计最多 500 个原生生成步骤，跨 turn 不重置；子智能体分别计数 |
| 额外 probe 限制 | 每题最多 5,000 个转发模型 HTTP 请求，涵盖主/子智能体、重试及辅助请求；这是本地保险限制，**不等于每 agent 500 步** |
| 文件接口保险限制 | 上传/操作次数和字节量另有上限，不混入模型请求计数；触顶同样单独报告 |
| Agent 资源 | 2 CPU、8192 MiB 内存、10800 秒 |
| Verifier 资源 | 独立容器，2 CPU、8192 MiB 内存、1800 秒 |
| 存储 | 任务声明 20480 MiB；所用 Pier/Docker 路径没有硬性磁盘配额，不能写成已强制限制 |
| 并发 | 单题串行；与官方示例中的并发运行不同 |

请求参数是可核对的客户端行为，不证明服务端按所有字段采样。当前 API 的 thinking 模式对参数有自己的处理规则，应以运行日的官方契约为准，不能仅凭发送 `temperature=1` 就宣称服务端温度被独立控制。[官方 thinking 说明](https://api-docs.deepseek.com/guides/thinking_mode/)

原生 step gate 不是账单计数器。一次原生步骤可能涉及重试或辅助调用，主/子智能体的合计步骤也可能超过 500。5,000 请求保险阈值若触发，结果标为 `protocol_limit` / partial，保留所有消耗，不把它当作正常的官方任务失败。

本地 HTTP 请求超时不额外缩短为几分钟，配置为与 10800 秒 agent 预算相同；外层 Pier deadline 仍是最终限制。native 的计时始于提交任务，外层还包含相应执行开销。Docker exec 的清理保险余量不增加解题时间。达到外层取消时，先核验并终止本次拥有的进程组，不能让后台 shell 在评分收集后继续写入工作区。

## 5. 容器、网络与浏览器

保留官方 task image 的原始 digest，不修改任务镜像或评分输入。三个镜像均实测为 Debian 12 bookworm：

| 任务 | 官方 image digest（仓库均为 `public.ecr.aws/d3j8x8q7/swe-bench-202605`） |
| --- | --- |
| `abs-module-cache-flags` | `sha256:3a4d47f5281269305343c83729836ac2f3172811aee72681e472a4196178eda1` |
| `adaptix-name-mapping-aliases` | `sha256:528654670f3c591e6491fc6fa01a0b8905bc8dee1b0557c5e76231bcc206f8fe` |
| `arktype-json-schema-refs-dependencies` | `sha256:e0b0410d828b816474cfb89a448c448f15cf7d617c3fbddfacd45a1c1b232ef9` |

安装依赖和拉取镜像只发生在准备阶段。任务容器保留离线环境，模型请求通过受限的 Pier/Squid 推理出口和外置 relay 转发；没有为 shell 或浏览器打开通用网络。真实提供方凭据留在任务容器之外，容器只收到随机 relay token。不得挂载用户 home、配置、聊天、完整 benchmark 测试/答案目录或开发者凭据。

Node、构建后的 app、必要 harness 和 Chromium cache 以只读方式挂载，同时保留 Pier 默认日志挂载。应用官方参考补丁中的 additive mounts、CPU 并发限制和 loopback 修复；完整 ColdX adapter 独立实现。CPU 配额之外，还按官方方式限制 Go/Cargo/Python/Node 测试工具报告的并行度，避免其按宿主核心数启动工作进程。

原任务镜像缺少 Chromium 图形库，因此使用 Debian 12 预构建的私有动态库和字体。只在浏览器启动包装器中设置其库/字体路径，原 Chromium 二进制内容不变，glibc、loader、libstdc++ 和 libgcc 不替换。普通 Node 与同级 shell 不继承浏览器私有库路径，任务镜像不安装这些包。

已在三个原始镜像中以关闭外网、2 CPU/8 GiB 的条件实际启动 Chromium `153.0.8010.12`，访问 loopback fixture 并生成相同的 1280×720 截图，图像已目视核对。该检查证明浏览器可运行和库作用范围，不是模型完成浏览器任务的质量测试。完整原生生命周期、子任务等待、重试恢复、Linux 进程清理、真实 Docker/Pier 出口和 NoOp verifier 也分别有基础设施验收；NoOp 的输出不作为 ColdX 成绩。

## 6. 任务身份、评分与用量

任务文本和 `task.toml` 对照固定 Git blob 核验。Windows 的换行展开单独记录，不能把任意内容改动当作换行差异。Pier 的实际任务名可能带命名空间；汇总器从固定 `task.toml` 的 `[task].name` 建立精确映射，并同时核对两处任务路径、canonical hash 和提交，不能简单剥掉任意前缀来匹配。

任务在原仓库中执行并按官方收集协议提交变更。官方 collect hook 从指定 base commit 到 HEAD 收集补丁，由独立 pristine verifier 应用补丁并执行官方测试；评测入口不根据模型自述判断成功。[任务配置](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/abs-module-cache-flags/task.toml)、[官方 grader](https://github.com/datacurve-ai/deep-swe/blob/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks/abs-module-cache-flags/tests/grader.py)

原始 trial JSON 按字节留存，记录来源及 SHA-256。三个新单题 job 合并时保留全部试验，不按 reward 筛选，不重写 trial 身份，不允许覆盖重复结果。只有对应任务身份正确、执行与 verifier 记录完整、官方二元 reward 有效时才计分；正常 step/time 预算耗尽后的有效官方 reward 可以保留。

缺失 reward、未完成、基础设施失败、用户中断和本地额外 probe 阈值触发均单独分类。未完成不填零，也不删除后再对剩余样本报“完整成绩”。中间 HTTP 错误若经原生重试恢复，不会自动抹掉最终有效 reward；错误次数和缺失用量仍保留。终态传输/执行失败不能伪装为恢复成功。

只有三个新任务都具备有效最终结果时，才可给出明确标注为“三题 pilot”的描述性汇总。官方完整 DeepSWE 比较需要 113 题每题 8 次，即 904 个规定样本；不能使用 best-of-8 替代各次 reward 的平均，也不能把三题百分比混入官方框架总分排行。[官方重复运行说明](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/dba1be0a40aa45a94ad051997016db3960a90277/evaluation/README.md)、[Pier Mean](https://github.com/datacurve-ai/pier/blob/0c802fc067a425345b24d1c69411aa98acf61a1d/src/pier/metrics/mean.py)

用量以最终转发层观察到的模型请求为准，包含主任务、子任务、辅助调用和失败重试；两层代理的总量不能相加。reasoning 若已包含在输出 token 中，不再重复计入总量。缺失 usage 保持未知，并报告覆盖率；输出重试、未完成请求和取消任务的消耗不因无 reward 被删除。费用估算与提供方最终账单有区别，私人逐账户数据不进入公开材料。

## 7. 复现步骤与公开比较限制

1. 检出上面的 ColdX、Pier、DeepSWE 固定提交。按[冻结基线说明](../../../../eval/benchmark/frozen-baseline/README.md)应用评测 policy 和换行元数据，核对 142 个源码哈希；不要使用用户日常 ColdX 配置。
2. 按锁定版本在 Linux 安装依赖并构建，将 Node/app/harness/browsers 单独制作为只读运行分发。准备 Debian 12 浏览器依赖后重新计算产物摘要，保存包版本、下载校验和镜像 digest。
3. 采用[公开评测入口说明](../../../../eval/benchmark/README.md)配置官方资源、受限推理出口、外置 relay 和独立任务工作区。凭据从本机受控输入传入，不写进任务配置、仓库或命令历史。
4. 先运行无付费模型的契约、进程清理、浏览器和出口检查，再用官方 verifier 验证基础设施。基础设施通过只允许进入试跑，不推导模型成绩。
5. 对预注册三题各执行一次，保存完整状态、补丁与官方 reward；按上述规则汇总并公开去除本机/账户信息的结果。正式全量比较需要另行完整运行全部规定次数。

公开官方材料没有给出每个表格框架的完整不可变运行包、全部内部定制版本、随机种子，以及其 Git 历史/临时缓存清理的完整任务级补丁。ColdX 使用自身完整产品配置、当前官方托管 API 和本次明确冻结的环境，不能宣称逐项等同于报告里的内部实验。也不会自行删 Git 历史或离线依赖来猜测未公开的准备步骤。

官方比较表中的 Claude Code、Codex、OpenCode、Pi、mini-SWE、DSH Minimal/Standard/PTC 均为引用值，未在本次机器上重跑。Terminal-Bench 2.1 也不在本次三题运行范围内；报告中的 89 题 × 3 次设置及未完整披露的离线改造不能被三题 DeepSWE 试跑替代。

因此，本次可回答的是“ColdX 原生运行时能否在明确记录的公开基准环境中完整执行与评分、哪里失败、有哪些可测工程边界”。模型或框架优劣、稳定成本优势及官方同环境排名，需要更多完整且可复现的试验。
