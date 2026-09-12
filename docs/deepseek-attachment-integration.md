# DeepSeek 研究与附件集成记录

2026-09-12。研究全文保存在 [deepseek-quality-foundations.md](deepseek-quality-foundations.md)。本记录区分实现、测试与网关能力，后续变更以最新验证为准。

## 已进入运行逻辑

- `plugin/policy.mjs`：建立结果、约束与验证证据的任务契约，仅在有帮助时向用户说明；按阶段选择相关工具；两种策略失败后再考虑更高推理投入；有浏览器工具时验证真实交互或渲染状态，否则完成可用检查并说明验证边界。没有增加强制输出页或完成纠正提示。
- 上下文策略保持紧凑稳定，临时状态留在会话后缀。长内容优先保留产物引用，要求读取 `@` 文件后才能引用其内容，图片使用原生内容块。
- `lib/profile.mjs`：增加官方 canonical `deepseek-flash` 的 V4.1 Flash / Vision 目录、Thinking High、模型上下文与输出上限配置。旧文本 Flash 不自动继承图片能力。模型上限是提供方能力声明，不能视为自定义网关已验收容量。
- `plugin/client/attachment-source.mjs`：提供上传本机文件、添加图片、工作区引用。图片经过 native composer 的 `onAddImages`；single slot 用负 priority，使自定义附件呈现真正挂载。
- `plugin/file-import-host.mjs`：通过现有 DSH Connection / Typert Gateway 接收文件。以 exact live root Agent 和 immutable session cwd 绑定工作区，不启动另一个 HTTP 服务或 agent loop。

## 普通文件行为

一次最多 8 个，单个最多 8 MiB；浏览器串行传输并显示状态，成功后立即添加对应 `@` 引用。切换会话和卸载会取消等待并丢弃迟到回执；部分成功会保留已上传文件的引用。

服务端严格校验字段、标准 Base64 往返结果、实际字节数和文件名，文件保存到会话工作区 `.coldx/uploads/`。同名同内容复用；不同内容追加 SHA-256 后缀；原子创建不覆盖旧文件。拒绝上传目录及目标符号链接，写入失败清理本次产生的残缺文件。上传操作本身不执行文件。

普通文件使用工作区引用，DSH 0.1.1-rc.2 的模型内容块仍只有 text/image。PDF、Office、压缩包等文件能上传保存，但解析需要相应文件工具；不把“上传成功”等同于“模型已解析”。

## 当前机器验证

- 完整 `pnpm test`：286 项通过，0 失败。涵盖 8 MiB 真数据、跨平台保留文件名、部分写入失败、重名、路径边界、取消、插件卸载，以及前端会话切换、迟到回执和拖出视口的遮罩清理。
- 浏览器真实执行文件选择器上传 `ColdX upload check.txt`，界面显示成功并写入 `@".coldx/uploads/ColdX upload check.txt"`。
- 源文件和上传副本 SHA-256 均为 `34a49e00c833afd72f4629f061e47c5ee418e0b93bb184b8f3db84035bfb0d86`。
- 另通过浏览器上传完整 8 MiB 二进制边界文件，收到成功回执和文件引用；磁盘副本为 8,388,608 字节，SHA-256 为 `2daeb1f36095b44b318410b3f4e8b5d989dcc7bb023d1426c492dab0a3053e74`。
- 图片选择、native 草稿附件、缩略图和历史图片消息已经实测。DOM 中附件 bridge 为 1，`data-can-add=true`。
- 重启后仍在 `http://127.0.0.1:3086/` 提供服务。

## 当前网关限制

本机配置的兼容网关公开目录只列 `deepseek-v4-flash`、Pro 及其变体和 `deepseek-v4-vision`，没有 canonical `deepseek-flash`。官方能力声明不能证明该网关已部署 V4.1。

模型浏览器探针出现 `EMPTY_RESPONSE`。独立最小请求进一步观察到已配置的两套凭据返回 `Authentication failed`，其中一个流式请求 HTTP 200 后才在 SSE body 中报告认证错误；另一次 Vision 请求超时。没有保存或输出凭据。需要在设置中更新有效凭据后重新验收文字与图片，当前不能宣称模型读取附件成功。

本机默认暂保留网关目录中的旧 Flash 路由；新安装面向官方 DeepSeek 的默认仍为 canonical `deepseek-flash`。没有升级 DSH 到存在会话格式迁移的 0.1.5 系列。

## 研究中尚待实现与评测

阶段工具集的受控 A/B、SQLite 长期记忆及中文检索、可验证经验晋级、自动 effort 路由和完整的页面诊断工具仍是后续工程。当前策略提示是行为指导，不能代替运行时控制器，也不构成模型权重训练或质量提升的统计证据。
