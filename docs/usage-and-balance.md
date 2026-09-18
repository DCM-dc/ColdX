# 用量与活动、上游余额

用量页从原生 DSH 会话记录读取真实模型用量，显示累计 Token、单日峰值、最长活跃会话、连续使用天数、活动热力图、工具及技能调用。日、周和累计视图共享同一组统计；按当前浏览器时区确定自然日，周从星期一开始。界面跟随 ColdX 深浅主题，日期方块可以用方向键浏览。

## 统计口径

- 累计 Token 为 DSH 的未缓存输入、缓存读取、缓存写入和输出之和。推理 Token 已包含在输出中，不再次相加。
- `assistant/chunk` 的 usage 与最终 `assistant/message` 按会话、turn、step 覆盖合并。同一个调用不会因为流式消息和最终消息各计一次。
- fork 和子智能体跳过 `SessionHeader.seedLength` 所表示的继承历史，各自新增调用计入总量。
- 缺少 usage 的步骤明确计入覆盖缺口，不用字数换算 Token。缺少缓存字段时仍保留已报告总 Token，但缓存命中率显示未知。
- 活跃时长累计顶层会话已结束回合的执行区间，排除会话放置未使用的间隔。尚未结束以及崩溃恢复补齐的回合不估算时长。
- 当前连续天数允许从昨天开始；今天尚未使用不会立即把昨天的连续记录归零。
- 工具次数按原生调用所在 turn、step 和调用身份统计，包括失败尝试；不同回合或步骤复用同一 callId 仍分别计数。嵌套 code dispatch 从根工具调用取得 turn/step，其开始/结束只计一次。技能仅从实际 `skill` 调用参数识别，目录里列出的技能不算使用。没有可靠插件归属的工具以原工具名显示，不伪造插件排行。

这是**本地会话中已记录的模型用量**，不等于上游账单。辅助标题、压缩或失败请求若未写入相应 usage 就无法从历史中补齐。重试的完整上游计费也需要上游账单核对。

原生日志不被修改。派生缓存位于 profile 的 `.coldx-usage/metrics-v1.json`，仅包含数值统计、日期、会话身份、调用名称和原生日志版本；没有提示词、回复、文件路径、工具参数或密钥。通过原生 `sessionQuery` 读取历史，最多并行读取两个会话，每次索引最多 10000 个会话，超过时明确显示范围不全。缓存损坏或统计模型版本变化时重新构建，删除会话后对应缓存也会从结果中移除。

## 余额查询与提醒

余额对应模型设置中的 `deepseek-official` 路由配置，第三方 DeepSeek 兼容上游也只访问它自己的同源接口。客户端不持有 API key；Host 通过 DSH `settings` 和 `credentials` 获取当前连接，以 GET 查询 `/user/balance`。默认官方 `/v1`、`/beta` 规范化到官方根路径；其他上游保留其配置路径。

- 禁止 HTTP 重定向；只有 HTTPS 和本机 HTTP 可查询，超时 8 秒，响应上限 64 KiB。
- 余额按 CNY、USD 分别显示原始十进制金额，不相加、不自行兑换。阈值比较使用精确十进制整数运算。
- 普通查询缓存 5 分钟，手动刷新至少间隔 15 秒，并发查询合并；缓存只驻留 Host 内存，凭据更换后使用独立缓存。
- 404/405/501 显示接口不支持；认证失败、网络失败与格式异常显示查询失败。上次成功余额可显示为过期参考，绝不把未知余额显示成零。
- `is_available=false` 或上游 402 提醒余额不足；低余额默认阈值为 CNY 10、USD 2，用户可以修改或关闭查询与提醒。提醒不会擅自结束模型任务。同一低余额状态可暂时收起，余额恢复后允许再次提醒。

官方参考：[余额 API](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)、[Chat Completions usage](https://api-docs.deepseek.com/api/create-chat-completion/)、[上下文缓存](https://api-docs.deepseek.com/guides/kv_cache/)。余额和用量数据各有来源，不从余额差推断单次调用成本。

## 原生接线

Host 模块 `plugin/usage-host.mjs`，配置 `{ profileDir }`；自行注册 `coldx-usage` 设置空间。

| Typert 方法 | 请求 | 返回 |
| --- | --- | --- |
| `coldxUsage/read` | `{ timeZone?: string }` | totals、coverage、summary、days、tools、skills、efforts、读取范围 |
| `coldxUsage/balance` | `{ refresh?: boolean }` | status、checkedAt、stale、available、各币种 balances、alert |
| `coldxUsage/settings` | `{}` 或 `{ balanceEnabled?, thresholds?: { CNY, USD } }` | 当前设置；金额阈值为十进制字符串 |

客户端 `createUsageComponents(React, rpc)` 返回 `UsageEntry`、`UsageSettingsRow`、`BalanceNotice`。`rpc(method, request, signal)` 使用原生 `/api` 调用 `coldxUsage/${method}`、参数 `{ args: { request } }`。余额监听在最后一个组件卸载时取消订阅和定时器。

## 验证

```
node --test test/usage-model.test.mjs test/usage-balance.test.mjs test/usage-host.test.mjs test/usage-client.test.mjs
node --test test/usage-ui.browser.mjs
```

前者验证计量、去重、缺失、时区、崩溃恢复、缓存、删除、原生 Typert、精确金额比较、凭据轮换、错误和超时。后者使用原生 DSH React 和真实 Chromium，以明确的合成统计验证日/周/累计、键盘焦点、设置保存、失败保留数据、深浅主题和 390px 窄屏。HTTP 验证只连接本机测试服务；这些测试不会读取用户资料或调用实际付费接口。
