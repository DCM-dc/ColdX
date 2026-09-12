# ColdX 插件市场：发现、发行版验证与安装边界

检索与验证日期：2026-09-12。本文针对 ColdX 当前锁定的 DeepSeek Harness 0.1.1-rc.2；没有执行第三方插件代码，也没有更改用户凭据。

## 官方契约

GitHub 的 [`dsh-plugin` topic](https://github.com/topics/dsh-plugin) 是发现入口，不是兼容性或安全认证。当前页面包含普通应用、资料列表、skills 和其他框架；ColdX 搜索保留仓库来源，点击详情后才核验发行包。

DSH 的[打包与安装教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)区分普通插件模块、组合包与 profile：可自动启用的 npm 组合包通过 `package.json.dsh.bundle.patch` 声明配置层，profile 记录组合包顺序。没有该声明的包即使安装，也不会因此激活。GitHub 源码安装可能需要运行 `prepare`，官方特别说明这会执行安装期代码；本轮 ColdX 仅接受已发布的固定 npm 版本，不开放 README 命令或 Git 源码构建授权。

插件模块通过原生 Cordis 的 `apply`、服务注入与清理生命周期提供能力；不能仅凭目录含有 `index.js`、`SKILL.md` 或 `main` 字段判断为可安装组合包。见[第一个插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md)。

## 已实现接口

`plugin/marketplace-catalog.mjs` 导出 `createMarketplaceCatalog({fetchImpl, cacheDir})`：

| 方法 | 结果与用途 |
| --- | --- |
| `search({query, page, refresh}, signal)` | `items / page / hasMore / total / stale / notice`；每页 20 条，仅发现公开仓库，不逐条拉取 manifest。查询被限定在 topic 内。 |
| `detail({id}, signal)` | 仓库来源、固定 commit、可读 README，以及 `packages`。每个包包含名称、精确版本、kind、可安装与否、原因及 manifest 路径。 |
| `resolvePackage({id, packageId}, signal)` | 安装前重新联网核验，返回精确 `packageId / version / installSpec`、repository URL、commit、manifest、tarball 与 SHA-512 integrity；离线或验证失败时不返回安装目标。 |

详情支持根 `package.json` 和其中声明的 npm `workspaces`（字符串数组或 `packages` 数组），限定普通路径/单个目录通配段，最多验证 12 个包。不会把 private monorepo 根当插件安装。不读取所有仓库、不 clone 社区仓库、不执行发现的源码。

只有下列条件通过才启用安装按钮：同名、同版本的 npm 发行记录存在；发行记录的 GitHub 仓库归属匹配；两端 bundle patch 路径一致且仓库中存在该文件；tarball 属于 HTTPS npm 官方注册表且带有效 SHA-512；包未私有/弃用；仓库未归档；已知原生依赖与当前本机版本满足声明。版本检测支持未导出 `package.json` 的原生包，只读取解析入口附近的 manifest，不执行包入口。

ColdX 自身与 `@deepseek-ai/*` 受管理包不能通过市场替换。这证明的是发行元数据和声明兼容性，不是源码安全认证或运行验收。安装器仍需核验实际安装文件和原生激活状态，不得用目录中的 `installable` 代替成功状态。

## 缓存与 GitHub 配额

GitHub [搜索 API](https://docs.github.com/en/rest/search/search#search-repositories)限制单个查询最多返回 1,000 个结果，可能返回 `incomplete_results`。ColdX 最大 50 页，并明确提示缩小检索词，不把这些页宣称为整个市场。

搜索缓存 5 分钟，详情资源缓存 1 小时；相同并发请求复用结果，网络读取串行排队，支持 ETag/304。可配置磁盘缓存，最多 120 条记录。失联或限流时可以查看标记为缓存的搜索结果，但安装验证必须联网。未认证核心 API 通常只有每小时 60 次请求，不能为首页每一条仓库预加载详情。见 GitHub [限流文档](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)。

403/429 后按 `Retry-After`/reset 时间进入冷却，无立即重试；请求有取消、15 秒超时及 3 MiB 响应上限。遵循 GitHub [API 最佳实践](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)中的条件请求与串行访问建议。当前未接入 GitHub 账户或令牌，不读取现有凭据。

## 真实候选验证

| 仓库 / 固定版本 | 2026-09-12 的实网结果 | 验收建议 |
| --- | --- | --- |
| [01Virex/dsh-status-rotator](https://github.com/01Virex/dsh-status-rotator) / [npm 0.17.2](https://registry.npmjs.org/dsh-status-rotator/0.17.2) | `detail` 与 `resolvePackage` 成功；commit `dd9a17e6ac9bb934abc5239917a95654511d0e40`；bundle 插入 `status-rotator` 行；Cordis peer `*`；无 install/prepare 脚本。 | 可作为无密钥的独立 profile 安装验收候选。插件会改动状态提示/弹幕，不建议自动加入用户现有 ColdX UI。 |
| [awesome-dsh-plugin/dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin) / [npm 0.3.7](https://registry.npmjs.org/dsh-find-plugin/0.3.7) | 发行版、来源和 bundle 均存在；但 `@deepseek-ai/dsh-tools ^0.1.0-rc.6` 不接受当前 `0.1.1-rc.2` prerelease，正确禁用安装并显示不兼容原因。 | 验证旧原生版本不会被默默装入当前运行时。 |
| [1010n111/dsh-about](https://github.com/1010n111/dsh-about) / 仓库 0.0.4 | 源码含 bundle/client manifest，但 npm 同版返回 404。 | 详情可读；显示“此精确版本未发布到 npm”，没有假的一键成功。 |

补充读取：[7D git skill](https://github.com/7dgroup-ai/dsh-skill-7d-git-commit)和 [pin-session](https://github.com/NattoCB/dsh-plugin-pin-session)也有 DSH bundle 声明，但本次其包名在 npm 返回 404。技能内容可以被组合包分发，单独 `SKILL.md` 不等于上述安装协议。

对 status-rotator 固定 commit 的 host/client 做了有限只读审查：host 约 19.8 KiB，主要是文件配置持久化和 Web 配置路由；client 约 137 KiB，注册设置/overlay 并修改状态显示。此次检索没有发现 `child_process`、`spawn` 或 `execSync`；客户端存在配置读取和可配置 fetch。此检查没有覆盖所有数据流，不能表述为完整安全审计。第三方插件在启用后具有其原生宿主权限。

## 测试和已知限制

`node --test test/marketplace-catalog.test.mjs`：24 项通过。先记录模块缺失的 RED，再实现；并发去重与隐藏 manifest 回归也分别先观察到失败后修复。覆盖分页、scope、查询长度、ETag、限流、离线缓存、精确包身份、归属/版本/SRI/patch 错误、原生依赖、保留包名、workspace、取消和安装前失联拒绝。真实网络仅做发现和 resolve，没有在这一步安装第三方代码；原生安装/UI/AI 工具验收由集成任务单独记录。

本轮暂不支持 Git-only 安装、任意 tarball、`pnpm-workspace.yaml` 单独声明的 workspace、复杂 glob、自动发现所有历史 npm 版本、完整源代码审计或未经用户选择的批量安装。普通 peer 或用户额外服务的运行适配仍需安装后检查；目录不伪造已启用状态。热门排序反映 GitHub stars，不能直接当作推荐或兼容排名。

安装器交叉复审另独立运行 `test/marketplace-installer.test.mjs` 的 18 项测试，与目录合计 42/42 通过。复现并推动修正了失败升级留在启动列表、新组合层重建既有服务、失败写入的迟到 watcher 卸载旧实例三处边界。现有回归检查服务实例和清理次数，而不只比较 Fiber 对象；失败版本保留禁用状态，新的包管理器操作不能自动复活它。这仍不替代完整客户端、真实 npm CLI 与用户任务中的端到端验收。
