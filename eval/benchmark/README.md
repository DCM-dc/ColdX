# ColdX 原生 agent 评测工具

这套工具把 ColdX 的原生 DSH agent 接入固定版本的 Pier，保留 ColdX 的模型循环、工具、子智能体、系统策略和上下文管理。代理只处理传输、凭据隔离、参数约束和计量；题目得分由官方 verifier 给出。

本目录的 `data.json` 是带来源链接的官方八种 scaffold 参考数据，不是 ColdX 的测量结果。`pilot` 小样本与完整评测分开绘图。程序、测试夹具和环境验收本身不产生模型能力分数。

## 文件与依赖

| 内容 | 入口 |
| --- | --- |
| 原生一次性运行 | [README-native.md](coldx-eval/README-native.md) |
| Pier 容器接入 | [README-pier.md](coldx-eval/README-pier.md) |
| 宿主凭据与两层代理 | [EXTERNAL-PROXY.md](coldx-eval/EXTERNAL-PROXY.md) |
| 参数、Files API、流和 token 计量 | [EVALUATION-PROXY.md](coldx-eval/EVALUATION-PROXY.md) |
| 实际 Docker/Squid mock 验收 | [README-docker-egress-smoke.md](coldx-eval/README-docker-egress-smoke.md) |
| 结果验证与绘图 | [README-results.md](coldx-eval/README-results.md) |
| 本地费用核算与条件外推 | [COST-ESTIMATES.md](coldx-eval/COST-ESTIMATES.md) |

运行环境为 Linux Docker Engine + Compose、Git、Python 3.12+ 和 Node 24。离线发布检查使用 Windows Node 24.16.0；纯 Python 聚合测试也支持 Python 3.11+。绘图需要当前 Python 环境安装 `matplotlib`，Pier 使用其锁定的 Python 依赖。旧脚本支持上级 `.deps` 路径，但本包不携带该目录；不要放入与 Python 版本或平台不匹配的 wheel。

ColdX 使用自己的 `pnpm-lock.yaml`、patches 和产品构建；当前产品声明 pnpm 11.19.0、DSH 0.1.1-rc.2。不要换成另一个 DSH agent 或复制安装版的用户配置。显式 dispatcher 使用产品锁定的 Undici **7.29.1**，通过绝对模块路径加载，不安装浮动版本。

## 部署步骤

以下命令中的 `<...>` 都是需要替换的绝对路径或运行标识。准备阶段可以下载依赖；任务执行阶段不安装依赖。真实模型运行会消耗操作者的 API 额度，本文命令不含任何真实密钥。

1. 在 Linux 上准备 ColdX 的独立源码快照，使用锁文件安装并构建。`prepare-source.mjs --source <COLDX_CHECKOUT> --output <NEW_SNAPSHOT>` 只复制已跟踪的运行源码并保存 hash；它不安装依赖，也不代替 Linux 构建。对最终 app、Node、浏览器和本目录八个运行模块记录 SHA-256，在一批评测过程中保持不变。
2. 取得固定的 [Pier](https://github.com/datacurve-ai/pier/tree/0c802fc067a425345b24d1c69411aa98acf61a1d) 与 [DeepSWE](https://github.com/datacurve-ai/deep-swe/tree/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea)。上游源码和任务不随本目录分发。为了聚合器的 canonical Git blob 校验，DeepSWE checkout 放在 `eval/benchmark/upstream/deep-swe`（已忽略）；不要把该宿主目录整体挂给 agent。
3. 给 Pier 应用包内 [官方环境子集补丁](coldx-eval/pilot/pier-official-environment.patch)：保留默认日志挂载、独立 verifier 挂载、CPU worker 限制与 IPv6 loopback。不要再叠加完整官方 DSH agent 补丁。安装该 Pier checkout 的 Python 依赖及包元数据。环境补丁必须纳入本次运行的来源记录，详见 [Pier 接入](coldx-eval/README-pier.md)。
4. 准备匹配 ColdX Playwright 版本的 Linux Chromium。必须在原任务镜像内实际验证启动、导航和截图；浏览器缓存里有文件不等于能运行。若补充系统库，只给浏览器子进程设置库路径，不污染 Node、shell 或编译器，也不改变官方任务镜像及评分文件。
5. 按 [Docker mock 验收](coldx-eval/README-docker-egress-smoke.md) 验证只读挂载、资源限制、网络隔离、两层上传/推理转发和取消。该检查只使用假模型端点。
6. 在任务容器外启动 [external proxy](coldx-eval/EXTERNAL-PROXY.md)。宿主仅监听实际 Docker bridge IP；真实 API key 只留在宿主进程，容器得到随机 relay token。使用新输出目录并记录请求预算、超时和最终 wire 参数。
7. 使用 [Pier 配置模板](examples/pier-job.template.json)，替换所有占位符，并预先固定任务、重复次数、版本与预算。`PYTHONPATH` 指向 `coldx-eval`，使用固定 Pier 的 `pier run --config <JOB_CONFIG> -y`。操作环境只注入必要变量与 relay 的下游配置；不要继承任意宿主密钥、代理或 preload。任务结束后运行官方 verifier，保留原始证据，再用聚合器提取可公开结果。

模板只是单任务、单次的部署示例，不是正式全量任务清单，也不是已经执行的结果。500 native steps 是每个 agent 的原生步数规则；示例中 5000 HTTP 请求是额外的可见保护上限，不能混为一谈。达到后者会保持 `partial`，不能把它当普通任务失败补零。DeepSWE 的 10800 秒总任务限时与每请求超时相同；连接建立单独限制 30 秒，dispatcher 的 headers/body 超时不再附加 300 秒上限。

## 离线检查

从 `coldx-eval` 执行。代理测试只访问 loopback 假服务，不读取真实 API key。

```bash
export COLDX_EVAL_UNDICI_MODULE="<COLDX_APP>/node_modules/.pnpm/undici@7.29.1/node_modules/undici/index.js"
node --test --test-timeout=10000 evaluation-proxy.test.mjs start-external-proxy.test.mjs evaluation-dispatcher.test.mjs
python -m unittest -v test_results
python -B -m unittest -v test_cost_estimate
```

`test_results` 的七项 canonical identity 检查需要前述固定 DeepSWE checkout 和随包提供的资源/hash 清单；其它检查只使用临时 synthetic fixtures。这里要求真实 checkout 路径，不能用跨目录 junction/symlink 绕过 canonical 文件位置校验。绘图检查需要 `matplotlib`。没有外部 checkout 时不要把全套测试失败改写为通过；可以明确选择纯测试并报告未运行项。

原生测试另外需要已构建的 ColdX app：设置 `COLDX_EVAL_TEST_SOURCE`、Linux 上的 `COLDX_EVAL_TEST_BROWSERS_PATH`，再执行 `node --test native-driver.test.mjs run-session.test.mjs`。`test_pier_adapter.py` 使用已安装的固定 Pier；`linux-process-group.test.mjs` 必须在 Linux 上运行。浏览器与 Docker 验收不能用 Windows 单元测试代替。

费用测试是五项纯数值检查，不读取真实账目或调用模型。费用工具只接受停止后的外置 relay 报告，缺失用量保持未知；每请求推理 token 不在 completion 之外重复收费，两层代理的同一用量不相加。费率是明确日期的参考常量；实际账单、逐密钥分配和本地报告路径不随此代码包公开。

## 发布边界

`copy-provenance.json` 记录公开脚本与评测源码的 SHA-256 比对，以及官方参考数据/任务元数据的来源。脚本按原字节复制；README 是整理后的部署说明。公开任务清单只含标识、配置和 hash，不含题目正文、仓库源码、解答或测试数据。

默认忽略任务 checkout、jobs、私有 relay 配置、账单、原生会话和二进制。不要把整个原始 `result.json`、`report.json`、日志目录或 `downstream.private.json` 当作公开结果上传。单独提取经过审查的 reward、状态、耗时、token 统计及覆盖率，并保留来源 hash；provider 返回的 model ID 只是报告标签，不是模型身份的独立证明。
