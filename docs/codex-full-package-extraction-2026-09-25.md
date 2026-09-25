# Codex 安装包完整展开与 ColdX 界面更新

本机 Windows Codex 包版本为 `26.915.4065.0`。只读提取到了 Git 忽略目录 `.runtime/codex-full-26.915.4065.0/`，入口索引是 `START-HERE.md`。没有改动安装目录，也没有把 Codex 构建产物加入 ColdX 的客户端包。

| 部分 | 文件数 | 字节数 | 校验记录 |
| --- | ---: | ---: | --- |
| `app.asar` 展开与 native sidecar | 15,324 | 370,686,694 | `manifest.json` |
| 相邻资源 | 3,167 | 1,171,869,848 | `manifest.json` |
| Electron/MSIX 安装外壳 | 339 | 482,287,116 | `installation-shell-manifest.json` |

所有 **18,830** 个展开文件均按原文件大小和 SHA-256 校验。原 ASAR 档案的 SHA-256 也在 manifest 中。提取文件是生产构建版本；`webview` 和 `.vite/build` 没有源映射，不能还原成原始开发仓库。内部 `app/package.json` 版本为 `26.915.31945`，与 Windows 包版本不同。

可从 `app/webview/index.html`、`app/webview/assets/thread-app-shell-chrome-*`、`composer-*`、`local-conversation-page-*`、`sidebar-*`、`file-preview-*`、`terminal-panel-*` 和 `browser-*` 定位界面构建块。文件名是查找线索，不代表这些能力都已在 ColdX 实现。

本轮基于观察另写了 ColdX 新会话首页、搜索/定时任务/Pull Request 页面，以及宽屏固定、窄屏抽屉的任务摘要。源码在 `plugin/client/workspace-shell-source.mjs`、`navigation-source.mjs`、`workbench-shell-source.mjs`，样式分别在 `hero-redesign.css`、`navigation-redesign.css`、`summary-redesign.css`；`build.mjs` 把它们纳入客户端包。真实 3087 本地预览核对了首页、会话摘要与三个二级页面，包括搜索最近会话、定时任务空态和 PR CLI 不可用状态。无付费模型请求。

验证：`node plugin/client/build.mjs` 成功；`pnpm test` 共 **743** 项，**741 通过、2 跳过、0 失败**；`git diff --check` 无错误。功能仍以原生 DSH 的会话、工具与权限实现为准，不能仅凭界面构建块声称 Codex 功能完全对齐。
