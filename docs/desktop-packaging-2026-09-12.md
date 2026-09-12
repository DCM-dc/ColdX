# ColdX 桌面安装包构建

桌面壳只管理窗口和本地进程；会话、工具、权限、插件市场仍由同一套原生 DSH 运行。Windows 使用按用户安装的 NSIS 安装器，不要求先安装 Node 或 pnpm。

## Windows 构建与验收

在 Windows x64、Node 24 环境和本仓库根目录执行：

```powershell
pnpm desktop:stage
pnpm exec electron-builder --config desktop/electron-builder.cjs --win nsis --x64 --publish never
node scripts/desktop/smoke.mjs dist/desktop/win-unpacked/ColdX.exe
```

`desktop:stage` 先构建网页资源，再进行独立 npm 锁定安装、应用原生补丁、准备 Node 和 pnpm。`beforePack` 再验证平台/架构、必需资源、pnpm 版本和补丁清单。macOS/Linux 目标必须在对应系统及 CPU 上重新 stage，不能把 Windows 的 Node 和原生模块直接用于其他目标。

`smoke.mjs` 将完整应用复制到仓库之外、使用新的数据目录和工作区。它先移除开发机 Node/pnpm 路径，通过发行包中真正的 `dsh plugin --profile web --version` 调用 pnpm，再检查应用/ColdX 客户端就绪和退出后端进程停止。此流程不连接用户现有会话，不安装任何插件。

## 包含的运行时

- `runtime/node.exe`：构建时同版本的 Node 24；旁边附 `NODE-LICENSE`。
- `runtime/tools/node_modules/pnpm`：`scripts/desktop/tools/package-lock.json` 固定的 pnpm 11.19.0，npm ci 核验 registry 分发完整性，禁止安装脚本；附原始包许可和 `PNPM-LICENSE`。
- `runtime/pnpm.cmd`（Unix 为 `pnpm`）：使用旁边的 Node，不依赖系统 pnpm。固定 `pmOnFail=ignore`，不因 profile 的包管理器声明自动下载另一版 pnpm。
- `runtime/app`：只复制 `bin`、`lib`、`plugin`、桌面后端入口和显式许可的浏览器安装脚本，加上锁定的生产依赖。PDF 运行时、worker/字体/字符映射/许可等位于客户端资产目录，一并保留。
- `runtime/app/desktop/native-patches.json`：直接来自唯一 `pnpm-workspace.yaml` 补丁清单。包括插件市场的原生 CLI reconcile 和 boot 热重组补丁，不维护第二份手工补丁列表。

插件市场的包安装写入应用的可写数据/profile 目录，不写入安装目录。是否立即激活仍遵循原生 loader 检查：纯新增且成功加载可在当前任务使用；影响运行模块的变更要求重启，配置缺失会明确显示。

## 资料隔离与边界

每次 stage 都重建 `.desktop-stage/runtime`，先拒绝路径祖先的 junction/symlink，防止旧 staging 文件混入。源码复制排除隐藏配置、`node_modules`、工作/会话/上传目录、凭据文件、日志和私钥；源码外链直接报错。生产依赖不得链接到开发机 pnpm store；Unix 执行入口的链接仅能指向复制后的依赖树内部。electron-builder 的资源根目录也使用明确白名单。

不打包开发者的 `.runtime`、`.env`、API key、会话、工作文件、浏览器个人数据或 npm 用户配置。首次启动由应用建立自己的数据目录。浏览器自动化仍需按应用提供的安装入口下载匹配的浏览器；Git、Python、C 编译器等用户项目工具不会假装由本安装包提供。

本轮独立验证：10 项 desktop-stage 测试通过，覆盖中文/空格路径的实际原生 CLI 转发、外链拒绝、隐私文件过滤、陈旧资源清理、缺失工具、架构错误及原生补丁校验；另在独立临时目录用真实 npm ci 安装固定 pnpm 11.19.0，经隔离 PATH 的原生 CLI 返回正确版本。完整 NSIS 构建和打包应用烟测由集成步骤执行，这些定向检查本身不代表安装包已经生成。
