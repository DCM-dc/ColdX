# 桌面分发中的原生补丁

桌面 stage 使用 npm 的锁定安装，避免把开发机 pnpm junction 打入发布包。npm 不认识 `pnpm-workspace.yaml` 的 `patchedDependencies`；此前桌面分发会遗漏网页环境已安装的原生兼容修复。

`scripts/desktop/native-patches.mjs` 现在读取该唯一补丁清单，将补丁及精确版本、SHA-256 清单复制到隔离的 desktop stage。在 npm 安装及链接检查后，统一验证所有目标包（包括嵌套的 npm 副本）的版本、补丁哈希、文件路径和每个文本 hunk；全部预检通过后才修改 stage。运行时 manifest 同时记录应用过的补丁及哈希。没有外部 Git/patch 命令依赖。

当前支持已有文本文件的统一 diff；文件改名、二进制补丁、增删文件等未支持操作会明确失败，不能静默跳过。版本或源码变化也会终止 stage，要求重新核验补丁。

2026-09-12 验证：

- 桌面 stage、backend、shell 定向测试 19/19 通过；包含源码及凭据隔离、版本不匹配、源码漂移、哈希篡改、包缺失、嵌套副本、越界补丁路径及非精确版本。
- 从已有 npm stage 仅读 6 个未打补丁的原生包相关文件，复制到临时隔离目录后运行真实通用 applier：DeepSeek adapter、subagent、host-apiproxy、client-ui-conversation、subprocess-local、client-connection 全部成功。
- 上述补丁机制验证未运行 npm/pnpm install、完整 stage/build、打包或后端重启；没有生成新的 macOS/Windows/Linux 安装包。

同日后续电脑使用接入：

- 现有机制继续读取同一清单，新增第 7 个 `dsh-mcp-client` 补丁（按原生 scope 保留 namespace，并支持可选工具 allowlist）。开发环境已通过 pnpm 安装验证。
- `desktop/runtime/package.json` 与 npm lock 新增固定 `@playwright/mcp@0.0.80`；其固定 Playwright 为 `1.63.0-alpha-2026-08-31`。所需 `dsh-scope@0.1.1-rc.2` 已在桌面清单。
- stage 只额外复制 `scripts/install-browser.mjs`，使包内 `computer:install` 脚本可用；浏览器由官方安装器安装，未把开发机浏览器 profile 或缓存打包。
- `computer-native`、`desktop-stage`、`profile` 合计 18/18 通过；没有在本次浏览器接入中生成发行安装包。详见 [浏览器接入研究](research/deepseek-computer-use-2026-09-12.md)。
