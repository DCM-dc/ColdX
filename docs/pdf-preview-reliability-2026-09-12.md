# PDF 预览等待状态与首帧修复

用户报告右侧 `DeepSeek_V41_Tech_Report.pdf` 预览黑屏并长期显示“正在渲染”。验证文件为 `.coldx/uploads/DeepSeek_V41_Tech_Report.pdf`，1,809,802 字节、51 页。常规独立浏览器打开和主任务在运行页面重新打开均能正常显示，因此没有把“重开成功”当成原始问题已复现或已解决。

调查确定了两个可独立重现的缺陷，生产修复仅在 `plugin/client/pdf-view-source.mjs`。

| 边界 | 修复前证据 | 修复 |
| --- | --- | --- |
| PDF.js 首批图形消息未到达 | 使用真实 React、真实 PDF.js Worker 和上述完整报告，只延迟 `StartRenderPage` / operator-list 消息。在独立预览与完整 FileWorkspace + pane + 生产 CSS 两种场景，画布尺寸已设置、`alpha:false`、`aria-busy=true`，像素仍是全 0；这个未初始化的不透明画布可能呈黑色 | 每次设置画布尺寸后同步填白纸底，再交给 PDF.js。使用 save/restore 保留绘图状态；没有伪造渲染完成，等待状态仍真实显示 |
| 当前任务被取消 | 受控调用当前 render task 的 cancel 后，原 catch 忽略 `RenderingCancelledException`，finally 又清除了超时，所以 `rendering=true` 可无限保留 | 当前 owner 仍有效时，取消和 AbortException 均退出 pending，并显示“这一页渲染已中断，请重试”。旧页/已关闭 owner 的 cleanup 仍静默，不报假错误 |

已确认运行时、文件和基本绘制可用。未证明用户原始现场究竟由后台浏览器调度、任务取消或其他条件触发；修复针对上表中真实可复现的失败边界，不宣称识别了原始现场全部因果链。没有改 PDF.js 参数、Worker 包、资源封装或全局样式，也没有移除现有 30 秒页渲染期限。

## 验证

```text
node --test test/pdf-view.test.mjs test/pdf-view-lifecycle.test.mjs test/pdf-preview.browser.mjs test/file-workbench.test.mjs test/workbench-pane.test.mjs
```

18 项通过，0 失败。新增真实浏览器回归为 `test/pdf-preview.browser.mjs`；可用 `COLDX_PDF_REPORT` 指定同一公开报告的其他本地路径。回归不连接用户浏览器或运行中的 ColdX，不请求模型。

- 延迟真实 Worker 图形消息时，首帧画布像素从全 0 变为 `[255,255,255,255]`，同时仍处于真实等待状态；恢复消息后正常完成。
- 首屏实际像素检查：完整文件面板 381×538，白色约 83.3%，深色文字约 1.94%，无浏览器错误。
- 真实 51 页报告的第 1、2、51 页；200% 与适合宽度；缩至 360px；隐藏恢复；接近滚动条阈值时的尺寸变化均稳定，未出现 ResizeObserver 循环取消。
- 当前 render 取消 → 退出等待 → 可重试 → 新文档/任务成功；30 秒期限触发会取消 render 并退出等待。
- 原有 PDF/HTML 文件标签保留、单个关闭取消、原生 PDF.js 文本流取消协议和 Worker 回收回归仍通过。

截图是上述受控本地组件环境，不代表新的用户任务完成结果：

- [完整文件面板第 1 页](../outputs/ui-review/pdf-report-page1-pane.png)
- [完整文件面板第 51 页](../outputs/ui-review/pdf-report-preview-pane.png)

主任务已通过 `pnpm test` 完成生产客户端构建与 434 项单元测试；模型滑块、PDF、工作面板和输入框联合浏览器回归 14 项通过。日志为 `.runtime/slider-pdf-final-unit-20260912.log` 与 `.runtime/slider-pdf-final-browser-20260912.log`。

构建热更新后的 `http://127.0.0.1:3086/` 已用 Computer Use 实际检查：同一报告第 1、2 页可显示；300% 放大正常；恢复适合宽度、切回第 1 页、关闭工作面板后重新打开仍正常。浏览器警告/错误日志为空。没有触发模型请求，没有安装依赖或重启服务。

## 后续白闪修复：完整帧替换

用户确认黑帧消失，但发现白闪。前面的白底初始化没有解决根本的显示顺序：翻页、缩放和 resize 都直接重置正在显示的 canvas，清空文字层，再等待 PDF.js。旧版实际运行包的对照测试明确复现：暂停真实 PDF.js 的 `RenderTask.onContinue` 时，画布像素变成同尺寸全白 RGBA，翻页的文字层也会提前变成下一页。

当前实现用离屏 canvas 和 div 准备完整图像与 TextLayer，两者都完成且 owner 仍有效后，在同一同步操作中更新尺寸并替换整个帧。React 只拥有空的 host，帧子节点由 renderer 独占。翻页、缩放、取消和失败期间保留上一完整帧；首次打开只有中性准备占位；切换文件会立即隐藏旧文件的帧。旧缓冲在替换/关闭后释放，文字流达到上限时发出取消，但不等待可能丢失的 worker 确认。

本轮验证：

- `pnpm test`：437 项通过，包含新旧 owner、快速连续翻页/缩放、失败保留旧帧、换文件隐藏旧帧、关闭释放像素及文字取消确认不返回的测试。
- `node --test --test-concurrency=1 test/pdf-preview.browser.mjs test/activity-panel.browser.mjs`：13 项通过。真实 51 页报告分别在独立预览和完整文件面板运行；首帧、翻页、200% 缩放、恢复适合宽度和侧栏宽度变化覆盖 10 项断言。暂停绘制期间每个 rAF 的完整像素、文字、布局签名不变，完成后只出现一次旧帧到新帧的替换。旧版对照的 10 项要求全部失败。
- 运行页面 Computer Use 实际检查首次加载、封面、第二页、300% 缩放和恢复适合宽度；浏览器警告/错误为空。没有调用模型。

日志：`.runtime/pdf-frame-swap-unit-20260912.log`、`.runtime/pdf-frame-swap-browser-20260912.log`。截图：`outputs/ui-review/pdf-report-pending-pane.png`（首帧准备）、`outputs/ui-review/pdf-report-held-pane.png`（下一帧暂停期间保留的旧帧）。

## 持续缩放反馈循环修复

后续用户报告静置时仍反复缩放。前面的完整帧测试验证了单次替换，却遗漏了系统滚动条参与布局时的长期稳定性：Playwright 默认启动参数 `--hide-scrollbars` 隐藏了这个条件。仅禁用 OverlayScrollbar 或设置 scrollbar CSS 宽度并不足以证明测试存在实际 gutter。

这次保留真实 17px 滚动条，DPR 1.25、分数侧栏宽度 415.1875px，并将视口高度放在有/无滚动条两种页面高度之间。旧代码静置 10 秒提交了 36 帧：完整文件面板 clientWidth 在 396/413px、canvasWidth 在 455/476px 之间持续交替；独立预览同样循环。工具栏高度保持 44px，排除了此场景下忙态文字换行作为触发。

生产修复仅在 `pdf-view.css` 固定 PDF 滚动容器的 gutter；不支持该 CSS 时始终预留纵向滚动条。图像和文本仍离屏完整渲染，ResizeObserver 仍响应真实外部尺寸变化。相同测试下两个场景均为 10 秒 **0 次**额外帧提交，可用宽度/画布宽度不变，最终 busy=false，末 2 秒无提交。

最新验证：`pnpm test` 437 项通过；PDF 与工作面板浏览器测试 17 项通过，默认包含普通绘制和真实系统滚动条 + 125% 缩放两组。日志为 `.runtime/pdf-resize-loop-unit-20260912.log`、`.runtime/pdf-resize-loop-browser-20260912.log` 和聚焦诊断 `.runtime/pdf-resize-loop-classic-20260912.log`。运行页面也已确认 computed scrollbar-gutter=stable；真实预览可用宽度 406px、画布 467×661，busy=false。
