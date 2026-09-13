# Pier 接入

`coldx_pier_agent:ColdXMountedAgent` 使用 Pier 0.3.1、固定 commit `0c802fc067a425345b24d1c69411aa98acf61a1d` 的 BaseAgent API，执行链为 `run-session.mjs → run-native.mjs → ColdX Web host/preset`。适配器不实现模型循环、不调用自己的 verifier、不自行生成 reward。

已完成 Linux 原生运行、进程组、实际 Chromium 与 Docker/Pier/Squid mock 隔离验证。mock 检查只证明实现与环境通路；官方模型结果和样本覆盖另行报告。

## 环境准备

使用 [固定 Pier](https://github.com/datacurve-ai/pier/tree/0c802fc067a425345b24d1c69411aa98acf61a1d) 和 [固定 DeepSWE](https://github.com/datacurve-ai/deep-swe/tree/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea)。需要应用与本轮一致的官方环境子集：custom mounts 追加默认 `/logs`，独立 verifier 使用自己的 mounts override，CPU worker 数量限制，以及 IPv6 loopback。

随包的 [pier-official-environment.patch](pilot/pier-official-environment.patch) 逐字提取官方环境子集，SHA-256 为 `363189840b3c7b8cc94c6e5f55798def86ae10a206530c98a1ee48170dac9906`。原始来源为 [固定版本的 dsh-minimal.patch](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/raw/dba1be0a40aa45a94ad051997016db3960a90277/evaluation/dsh-minimal.patch)，原文件 SHA-256 为 `11f934726bdffb2111072c7dc121fe4734f5948311dad1ab9aa4b76e2ae2f24c`。

只应用本包这份环境子集，不要再叠加完整官方 DSH agent 补丁或 mounts-only 补丁。应用和安装由部署者完成，当前运行脚本不会静默 patch Pier：

```text
git -C <PINNED_PIER_CHECKOUT> apply --check <BENCHMARK_DIR>/coldx-eval/pilot/pier-official-environment.patch
git -C <PINNED_PIER_CHECKOUT> apply <BENCHMARK_DIR>/coldx-eval/pilot/pier-official-environment.patch
```

本轮实际产品源码如何还原，见 [冻结基线](../frozen-baseline/README.md)。使用不同产品策略或依赖时应重新记录版本、hash 和协议差异。

四份运行目录只读挂载如下，宿主路径由 [配置模板](../examples/pier-job.template.json) 指定：

| 容器路径 | 内容 |
| --- | --- |
| `/opt/coldx-app` | 构建完成的 ColdX、锁定依赖及产品 patches |
| `/opt/coldx-eval` | `run-session`、`run-native`、`native-driver`、`execution-environment`、`linux-process-group`、`stop-owned-process`、`evaluation-proxy`、`evaluation-dispatcher` 八个 `.mjs` |
| `/opt/coldx-node` | Linux Node 24 分发 |
| `/opt/coldx-browsers` | 匹配产品 Playwright 的 Chromium 缓存及经验证的浏览器专用库 |

保留任务原来的 `/app`、独立 verifier、CPU/内存/网络和时间限制。不要挂载整个数据集、上游 tests/solutions、宿主 home、私钥目录或 Docker socket。仅源码快照不能运行，浏览器文件存在也不能替代实际截图验收。

## 接口与网络

适配器 kwargs 支持 `source/harness/node/workspace/browsers_path/undici_module/max_steps/max_requests/timeout_ms/request_timeout_ms/version`。模型名为 `deepseek-flash`；version 必须由当前 ColdX 源码及实际运行记录确定。默认 max_requests=500 是 probe 保护；本轮单次 pilot 显式使用 5000、max_steps=500、两个 timeout 均为 10800000 ms，不能据此声称原始官方 HTTP 内部设置已完全复现。

真实 key 留在 [外置 relay](EXTERNAL-PROXY.md)，task 的 session launcher 只得到三项显式环境配置：

```text
COLDX_EVAL_UPSTREAM_BASE_URL=<HOST_RELAY_ORIGIN>
COLDX_EVAL_UPSTREAM_API_KEY=<RANDOM_RELAY_TOKEN>
COLDX_EVAL_UPSTREAM_CREDENTIAL_KIND=relay-token
```

适配器 allowlist 只包含固定 relay host；Pier 将它自己的 authenticated HTTP(S) proxy 注入 session。显式 Undici dispatcher 使用 `proxyTunnel:false`，避免向 port 80 发 CONNECT；HTTPS 仍通过 CONNECT 443。native 子进程只连接 loopback session proxy，并使用另外生成的随机 token。环境变量声明本身不证明容器隔离，部署后必须执行 [真实 Docker mock 验收](README-docker-egress-smoke.md)。

## 清理、计量与评分

每次运行建立专属进程组。超时、取消和正常退出均清理核验所属的 agent 及后台工具；无法证明完成清理时拒绝把结果当作正常完成。Pier 官方总限时仍优先，内部清理等待不延长解题时间。正常耗尽 native steps 或 agent 时间后，仍由官方 verifier 判断实际结果。

`/logs/agent/coldx-run` 保留本地证据，`AgentContext.metadata.coldx` 记录运行状态与代理统计。代理计量包含辅助模型请求；未知缓存 token 和价格保持未知。原生 retry 后正常完成会保留 `completed-after-errors`，不会抹掉历史错误或补齐缺失 usage。

```bash
python -m unittest -v test_pier_adapter
node --test linux-process-group.test.mjs
```

第一条需要已经安装的固定 Pier；第二条需要 Linux。两者均不是官方任务的实际解题或 reward。发布时只提取经过审查的数值与来源，原始 agent/session 日志留在本地。
