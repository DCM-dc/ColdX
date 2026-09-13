# ColdX 原生一次性运行

`run-native.mjs` 启动完整 ColdX Web host 和 `coldx` preset。模型循环、工具执行、子智能体和持久化仍由产品原生 DSH 实现；`native-driver.mjs` 只提交一次任务、设置评测参数、等待原生结束并导出证据。

Linux 上的原生生命周期、取消、子智能体、重试恢复及浏览器 Files API 链路已进行本地 mock 验收。另有真实 Docker/Pier/Squid 隔离检查。这些是实现与环境验证，不是官方题目得分；实时评测结果由独立报告披露。

## 参数

| 参数 | 含义 |
| --- | --- |
| `--source` | 已安装锁定依赖并构建的 ColdX checkout，包含产品 patches |
| `--workspace` | 任务工作目录 |
| `--output` | 必须不存在的新输出目录 |
| `--task-file` | 原始任务 instruction 的 UTF-8 文件 |
| `--base-url` | session 代理的 loopback origin，拒绝直接远程 provider |
| `--max-steps` | 默认 500，每个原生 agent 的累计 native steps 上限 |
| `--timeout-ms` | 默认 1800000；DeepSWE 部署显式传 10800000 |
| `--playwright-browsers-path` | 已准备的 Chromium 缓存绝对目录；Linux 必填 |

`COLDX_EVAL_API_KEY` 只接受本地代理 token。入口不读取用户现有 provider 设置、会话、`.env` 或 DSH home。每次使用新建的 `dsh-home` 和 `user-home`，由上层 `run-session.mjs` 设置 token。

```text
node run-native.mjs --source <COLDX_APP> --workspace <TASK_WORKSPACE> --output <NEW_OUTPUT> --task-file <INSTRUCTION_FILE> --base-url <SESSION_LOOPBACK_ORIGIN> --max-steps 500 --timeout-ms 10800000 --playwright-browsers-path <BROWSER_CACHE>
```

`agent/request` hook 使用 `deepseek-official / deepseek-flash / max / temperature=1`，导出时核对原生 request header/context，要求 context 为 1,000,000。当前 adapter 的 `top_p` 由 [评测代理](EVALUATION-PROXY.md) 在 wire 边界设为 0.95；不能把该 transport 处理说成产品已经实现原生 topP 支持。

子 agent 同样受每 agent 的累计步数 gate 约束。所有 agent 的总步数可以大于 500；模型重试、标题、压缩等 HTTP 请求须另外计量。等待器等待原生后台子任务及其完成通知，不追加人工 followup 来替代原生 agent 循环。

## 进程与输出

Linux `run-session.mjs` 必须由专属会话启动；Pier 适配器负责 `setsid`。清理只作用于核验过 entry、PID、启动时间和进程组的所属进程。原生进程保留官方 CPU worker 限制及精确的 CPU clamp preload，任意宿主 preload 不会继承。Docker 的实际 quota 仍需独立检查。

输出包括 `request.json`、评测 profile patch、原生 `report.json`、`trajectories/*.jsonl` 及持久会话。**这些包含 agent 内容和本机路径，默认仅本地保留。** 原生 usage 只覆盖任务 agent 的持久消息，完整 HTTP 用量还要检查代理覆盖率。

退出码 0 表示原生完成，2 表示步数到限，1 表示超时/异常。是否解决题目始终由官方 verifier 判断。曾出现可恢复 HTTP 错误不会抹掉后来正常完成的状态；历史错误和缺失 usage 仍保留。

Pinned DSH 的取消路径曾出现 `turn/end` 非 JSON 可序列化的 native error；入口保留真实 `end: null` 和错误，不伪造 completed。该限制与超时事件在报告中区分记录。

## 本地 mock 测试

设置 `COLDX_EVAL_TEST_SOURCE=<COLDX_APP>`，浏览器检查还要设置 `COLDX_EVAL_TEST_BROWSERS_PATH=<BROWSER_CACHE>`：

```bash
node --test native-driver.test.mjs run-session.test.mjs
```

测试创建隔离 home/workspace 和 loopback 假模型，覆盖真实文件工具副作用、累计步数、前后台多层子智能体、取消、原生 retry、图像上传及下一回合 file_id。测试不调用付费模型。部署依赖与四个只读挂载见 [上级 README](../README.md) 和 [Pier 接入](README-pier.md)。
