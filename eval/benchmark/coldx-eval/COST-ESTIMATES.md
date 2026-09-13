# 本地费用核算与条件外推

本工具仅读取已停止的 **外置 host relay** 安全 `transport-report.json`。不得再把 session proxy 的同一批用量相加，也不得用 Pier 的输入计数代替外置账目。它不调用模型、不读取密钥、不执行或修改 trial；公开的是通用核算逻辑和测试；实际账目与脚本输出默认留在本地，不随此代码包分发。

2026-09-13 核对 [DeepSeek 官方价目](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)：Flash 每百万 token 的 CNY 价格分别为缓存输入 0.02 / 未缓存输入 1 / 输出 4（空闲），高峰为 0.04 / 2 / 8。官方高峰是北京时间周一至周五 9–12、14–18。工具分别给出“全部空闲”“全部高峰”价目情景，不能由聚合账目推断每个请求的结算时段，第三方网关价格和账户实扣也未由此验证。

对账目报告的缓存输入 `H`、未缓存输入 `M`、输出 `O`：

`费用 = (H × 缓存价 + M × 未缓存价 + O × 输出价) / 1,000,000`

`reasoningTokens` 已包含在 `completionTokens` 中，只显示覆盖情况，不再计一次输出费用。`totalTokens` 也不参与加项。失败请求、辅助请求和失败任务的用量不按 reward 删除。缺字段保持 null；已知分项可以求和，但只有所有收费字段覆盖每个请求且 transport 的 complete 为 true 时，`complete_estimate_cny` 才有值。否则只给 `reported_component_sum_cny`，不是完整账单或严格上下界。

三个样本的算术均值仅用**已收到的样本数**作分母，未完成题不补零。全 DeepSWE 是 113×8=904 次；条件情景为“904 次都重复这些样本已报告的平均用量”。这不是随机样本估计或置信区间。尚无 Terminal-Bench 实测，其 89×3=267 次费用默认保持未知。只有显式提供 `--tb-cost-ratio R` 时才计算假设的 `267×R×DeepSWE样本均值`，并列总 1171 次情景；R=0.5/1/2 都是人为情景，不是实证比例。

时长使用外置代理的 `updatedAt-startedAt`，可能含 setup、等待和 verifier；不能称为纯推理耗时。DeepSWE 串行小时数仅按同一均值×904/3600 外推。没有 TB 耗时样本时不生成 TB 或总 1171 次耗时估计。

三题完成后使用（路径替换为真实安全副本；输出必须是新文件）：

```bash
python -B cost_estimate.py \
  --task-report abs-module-cache-flags=<ABS_TRANSPORT_REPORT> \
  --task-report adaptix-name-mapping-aliases=<ADAPTIX_TRANSPORT_REPORT> \
  --task-report arktype-json-schema-refs-dependencies=<ARKTYPE_TRANSPORT_REPORT> \
  --tb-cost-ratio 0.5 --tb-cost-ratio 1 --tb-cost-ratio 2 \
  --output <NEW_LOCAL_COST_OUTPUT_JSON>
```

先前中断或放弃的轮次也可能产生费用。取得已停止的安全外置账目副本后，可另加 `--additional-report prior-attempt=<PRIOR_TRANSPORT_REPORT>`。它进入 `all_supplied_attempt_expenses`，不会当作三题中的成功样本。未提供的旧账目、文件存储或其它非 token 收费都不推断为零。按原文件 hash 去重，防止同一账目副本重复相加。

离线数值测试：`python -B test_cost_estimate.py`。测试覆盖缓存收费、思考不重复收费、失败请求不清除、缺失用量为 null、拒绝运行中的账目/第二跳 session 账目，以及单样本不冒充三样本或 TB 实测。


占位符须替换为对应报告的完整路径；输入文件名须为 `transport-report.json` 或以 `.transport-report.json` 结尾。每份报告只计一次。当前 CLI 的任务标签限定为示例中的三个预先选定 pilot 任务；函数不执行试题，改变任务集合或费率时应另行记录协议和脚本版本。费率常量是标明日期的官方参考，不会自动更新。

脚本输出包含显式提供的本机报告路径、来源 hash 和分项计量，属于本地核算文件。需要公开时另行提取审查过的汇总，删除路径、逐密钥分配和账单明细。本页不包含当前运行的单题金额或全套结果。环境与评分说明见 [部署 README](../README.md) 和 [结果聚合](README-results.md)。
