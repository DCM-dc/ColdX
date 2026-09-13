# 聚合与绘图

这里只读取已结束的 Pier trial；不执行模型、任务或 verifier。没有数据时不使用 0 占位，未完整覆盖时不输出全量分。`aggregate.py` 使用 Python 3.11+ 标准库；`plot.py` 需要当前 Python 环境安装 `matplotlib`。本发布包不携带原始 trial、任务仓库或机器专用 Python wheel。实际结果由独立发布报告披露。

## 已核对的上游契约

- Pier 固定提交 `0c802fc067a425345b24d1c69411aa98acf61a1d`：`src/pier/models/trial/result.py`、`models/verifier/result.py`、`models/trial/paths.py`、`models/trial/config.py`、`trial/trial.py`、`metrics/mean.py`。
- 每个 trial 的文件名是 `result.json`，位置为 `<job>/<trial>/result.json`；job 根部同名文件是汇总，不能再计一次。扫描只到该层，不递归抓取任意日志。拒绝 trial 文件/目录的符号链接和越界路径。
- 评分来自 `verifier_result.rewards["reward"]`。不从 agent 自述、patch、测试输出、job 汇总或辅助 `partial/f2p/p2p` 字段推断通过。
- DeepSWE 固定提交 `0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`：任务的 `tests/test.sh` 在评分未产出时写 `-1`；`tests/grader.py` 会把合法的补丁应用失败评为 **0**。二者必须分开。
- 单步 trial 才受支持。结果中已有非空 `step_results` 时明确拒绝计分，不猜多步归并规则。
- 本发布脚本未附带真实 TB trial，且尚未以该套任务 verifier 文件验证输出形态；聚合器只接受实际 Pier 结果中出现的二进制 `reward`，遇到不同键名/分数不猜测转换。

## 计分

| 情形 | 处理 |
| --- | --- |
| Trial 和 verifier 均已结束，合法二进制 reward 为 1 / 0 | 通过 / 真实任务失败，两者都计入分母 |
| `AgentTimeoutError`，但 verifier 正常结束并产出 0/1 | 正常计分，同时记录 agent timeout |
| 正常达到步数上限，verifier 完成并产出 0/1 | 正常计分；脚本不猜测额外的自定义超时字段 |
| 曾遇到 429/5xx/断流，原生重试后正常完成且 verifier 产出 0/1 | 正常计分，保留 `completed-after-errors`、错误次数和 token coverage；不清零历史错误或补齐缺失 usage |
| ColdX 明确以 `transport-error` / `driver-error` / `native-error` / `interrupted` 等失败终态结束 | 即使导出遗漏 `exception_info` 且存在 reward，也保留观测 reward 但不计分 |
| `agent_result.metadata.coldx.status=request-budget-exhausted` | 保留实际 reward，但标 `protocol_limit` / partial；probe 的额外总 API 上限不是官方每 agent 500 步上限 |
| 环境启动、agent setup、verifier 超时，其他异常，或 reward=-1 | 不补零；保留观测 reward 和异常类型，整个作业保持 partial |
| `NonZeroAgentExitCodeError` | 保守视为待分类异常，不计正式分；仅凭该异常不能辨认任务失败还是 adapter 启动问题 |
| 未结束、缺 reward、非有限值、字符串、布尔或非 0/1 分数 | 单列未结束/缺失/无效，不计分 |
| 重复身份、额外尝试、未知任务、模型/agent 版本不符、同任务 checksum 变化 | 标 partial，不选最好的重跑结果 |

正式完整覆盖要求 DeepSWE **113 × 8 = 904**、Terminal-Bench **89 × 3 = 267**。先对每任务全部固定次数求平均，再对所有任务求平均；等次数时等价于所有 trial 的算术平均，**不是 best-of-N**。任一任务次数不足、过多或有未评分尝试，`score_percent` 为 `null`；没有 trial 时状态是 `no_data`，其它不完整作业是 `partial`。`missing_trials` 表示缺少文件的槽位，`unscored_trials` 表示文件存在但没有有效评分，不能互相代替。

Pier 自带通用 mean 会把某些缺失 reward 补为 0。这里刻意不沿用该缺失值处理，防止基础设施失败冒充实测任务失败。重试存在时保留所有尝试，不自动删除/覆盖旧结果；需要先在运行协议中解决作业/尝试的身份，不能事后选通过的尝试。

一次 trial 内的原生 HTTP 重试仍属于这次 trial，不是额外挑选的尝试。`trial_details` 保留 `transport_outcome`、`transport_error_counts`、`token_usage_complete`；汇总分别记录恢复后完成数量和完整 token coverage 数量。任务正确性和账单完整性是不同指标：有效 verifier reward 不因一个已恢复请求缺少 usage 而被丢弃，费用仍不能把该缺失调用当作零。

## 输入 manifest

这是本地聚合的独立覆盖/来源声明，**不是 Pier 的字段**。运行前确定任务清单，运行后填入实际 `agent_info` 的原值。路径相对 manifest；`results_dir` 是一个专用 Pier job 目录。`inventory` 格式为 `{"commit":"完整提交", "task_count":113, "tasks":[{"task_id":"任务名"}, ...]}`；随包提供的 `deepswe-inventory.json` 是去除本地迁移记录后的公开资源/hash 清单；它不包含题目正文或解答。TB 也必须先由固定 checkout 清点真实清单。

DeepSWE v2 清单的目录 ID 与 Pier 的原始任务名不同，例如 `abs-module-cache-flags` 对应 `datacurve/abs-module-cache-flags`。汇总器从上一级目录下的 `upstream/deep-swe`（即 `eval/benchmark/upstream/deep-swe`） 的固定 Git blob 读取 `[task].name`，核对清单 canonical SHA-256 / Git 对象 ID，并检查本地文件仅为原始 blob 或完整 CRLF 展开。原名保留在 `trial_details.task_name`，固定目录 ID 放在 `canonical_task_id`，后者用于覆盖率、重复次数和 checksum 分组。任意未知前缀都不会被剥离或猜测。

实际 `config.task.path` 与 `task_id.path` 必须同时精确匹配该任务的固定绝对目录。Windows 分析 Linux 原始结果时，manifest 必须显式设置 `"task_directory_root": "/opt/coldx-benchmark/upstream/deep-swe/tasks"`；按 POSIX 字符串核对，不在 Windows 上重新解释 `/opt`。`..`、重复斜线、反斜杠或其它复制目录不能作为相同任务路径。旧版清单只支持原名与任务 ID 完全相等，不推断别名；未知 schema 会拒绝。

分别运行的单题 job 可以合入一个专用结果目录，结构仍须为 `<combined>/<原trial目录>/result.json`。等待 trial 终态后按原始字节复制，保存来源 job/path 与复制前后 SHA-256；拒绝同名覆盖，保留原始 JSON 中的 `id`、`trial_name` 和 `trial_uri`。汇总器不要求 `trial_uri` 改指 combined 路径，重复身份、额外尝试和未评分记录仍会使整体保持 partial。复制来源与字节 hash 由合并步骤另行留证；不能按 reward 筛选，也不能将其他中断作业塞入本轮结果目录。

下面仅是配置示例，不是结果或已执行作业：

```json
{
  "schema_version": 1,
  "benchmark": "deepswe",
  "scope": "full",
  "inventory": "deepswe-inventory.json",
  "results_dir": "jobs/REPLACE_WITH_REAL_JOB",
  "repetitions": 8,
  "agent_label": "ColdX",
  "model": "DeepSeek-V4.1-Flash",
  "agent": {
    "name": "REPLACE_WITH_AGENT_INFO_NAME",
    "version": "REPLACE_WITH_AGENT_INFO_VERSION",
    "model_name": "deepseek-flash"
  },
  "pier_commit": "0c802fc067a425345b24d1c69411aa98acf61a1d",
  "benchmark_revision": "0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea",
  "protocol": {
    "reasoning_effort": 100,
    "temperature": 1.0,
    "top_p": 0.95,
    "context_limit": "1M",
    "max_steps": 500,
    "platform": "Linux containers",
    "terminal_network": false
  },
  "protocol_notes": ["填写实际源码快照、运行条件及相对官方的已知差异"]
}
```

`scope=full` 省略 `task_names` 时使用整个 inventory；即使显式给出，也必须完全相同。Pilot 设置 `scope=pilot`、显式的 `task_names` 子集及预定 `repetitions`。Pilot 完整仅表示所选小样本已完成，不会被提升为正式分。`benchmark=terminal-bench` 使用真实的 TB inventory/revision 和 3 次重复。公开官方原表没有披露原始 TB revision 与全部环境改造，因此本地结果不能标成精确复现。

## 命令

在本目录执行；脚本不会覆盖已有输出文件：

```bash
python aggregate.py --manifest <DEEPSWE_MANIFEST> --output <NEW_AGGREGATE_JSON>
python plot.py --mode official --output <NEW_OFFICIAL_REFERENCE_PNG>
python plot.py --mode full --manifest <DEEPSWE_MANIFEST> --manifest <TB_MANIFEST> --output <NEW_FULL_COMPARISON_PNG>
python plot.py --mode pilot --manifest <PILOT_MANIFEST> --output <NEW_PILOT_PNG>
python -m unittest -v test_results
```

绘图直接从 manifest 重读原 trial，避免只信任手改汇总分。`official` 仅读取上级 `data.json` 的八个官方参考值，不显示 ColdX。`full` 只有两项全量完整、本地/官方模型身份相同、ColdX agent 版本相同时才追加橙色斜线的 **local measured** 行；官方为蓝色 **official**。`pilot` 是独立的小样本任务图，不包含官方全量榜单。Partial pilot 同样没有总体分图，应先检查缺失/异常明细。

## 验证和真实性边界

`test_results.py` 中的 trial 是醒目标记的 **SYNTHETIC TEST ONLY** 夹具，只在自动清理的临时目录生成；不是 ColdX 证据。库级测试可验证其数学结果，CLI 拒绝把带 `_synthetic_test_fixture` 的记录导出为评测报告，绘图也拒绝 synthetic evidence。没有夹具写进真实结果目录。

脚本检查结果形状、计数和元数据一致性，无法独立证明 JSON 未被伪造、manifest 声明的采样参数确实到达 API、task checksum 对应未修改的官方文件。必须保留真实运行日志、源码快照和独立环境/wire 验证；aggregate 会记录 inventory SHA-256、源码 revision、实际异常分类、声明参数及与参考的差异，不输出 env、密钥、agent 内容或异常全文。


完整 `test_results` 需要固定 DeepSWE Git checkout 用于七项 canonical identity 检查，其它测试只使用临时 synthetic fixtures。按 [部署说明](../README.md) 准备 checkout；不要把上游源码或测试产生的假结果提交进此目录。公开清单的 SHA 变化不改变 task 的 canonical Git blob SHA，实际运行 manifest 必须使用它所对应的清单文件。
