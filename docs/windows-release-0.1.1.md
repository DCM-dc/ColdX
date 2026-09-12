# ColdX 0.1.1 — Windows x64

本版本把当前 ColdX 网页工作台封装为独立 Windows 应用。顶部采用约 40px 一体式标题栏，提供侧栏切换、前进/后退及文件/编辑/视图/帮助菜单，颜色跟随 ColdX 当前深浅主题。保留原生最小化、最大化、关闭按钮、窗口拖动和 F11 全屏；为正文预留标题栏空间，全屏时收起顶栏。

安装包内置 Node 24.16.0、pnpm 11.19.0、DSH 0.1.1-rc.2、当前客户端及全部锁定的原生补丁。插件市场、Goal/Plan、文件预览等使用同一套 ColdX/DSH 实现。可在 Windows 按用户安装、选择安装目录，并创建桌面快捷方式。

应用数据保存在当前用户的 ColdX 数据目录，默认工作区为文档目录下的 ColdX。安装包不包含开发环境中的 API 密钥、会话、上传文件、工作区或浏览器个人数据；首次使用需在设置中配置模型。卸载默认保留应用数据。Git、Python、C 编译器等项目工具，以及电脑使用所需的匹配浏览器，按任务需要另行安装。

## 已执行验证

- 完整回归 **529/529** 通过，包含显式开启的标题栏浏览器交互测试。
- 真实 Electron 中通过设置切换浅色→深色→浅色，验证标题栏与窗口按钮同色，文字保持对比度；80%/100%/125% 缩放、820×620 最小窗口、150% 缩放的设置面板及全屏往返检查通过。
- 鼠标打开顶部菜单保留输入框焦点与选区，键盘 Tab/Enter 仍可操作菜单；启动页采用已保存的应用配色，不覆盖“跟随系统”偏好。
- 真实 Electron 桌面壳启动、退出通过；移除菜单后修复了窗口销毁时清理快捷键导致的退出异常。
- 把完整发行目录复制到开发仓库之外，再启动：ColdX 客户端和插件市场可见；退出后后端进程结束。
- 窗口真实状态：`applicationMenuPresent=false`、`menuBarVisible=false`、`menuBarAutoHide=false`；最小化/最大化/关闭均可用。
- renderer 仍启用 sandbox、contextIsolation 和 webSecurity，不暴露 Node 的 `require` 或 `process`。
- 发行包原生 DSH CLI 在隔离 PATH 下调用自带 pnpm，返回固定 11.19.0。
- 桌面后端只接受原生主服务的就绪日志，额外插件打印的本地服务地址不会变成应用首页。
- 长路径专项测试使用真实 NSIS 编译执行：复现旧卸载器的 MAX_PATH 残留，验证修复后完整移除安装目录、保留目录外的用户数据，原生升级回滚路径不变。

重定位验收的 `smoke.json` 保存在本机隔离测试目录，不包含在源码仓库中。构建与资料隔离细节见 [桌面打包说明](desktop-packaging-2026-09-12.md)。

## 安装器结果

安装器：`dist/desktop/ColdX-0.1.1-win-x64.exe`，约 **190 MiB**，由同版本源码构建。

精确大小和 SHA-256 以 GitHub Release 资产及附带的 `.exe.sha256` 校验文件为准。本地构建未进行代码签名，Authenticode 状态为 `NotSigned`。

安装器加入扩展长度路径处理，避免 NSIS 常规路径删除留下超过 259 个字符的依赖文件。删除范围仍为原安装目录，保留原生升级回滚和应用数据策略。

最终 `.exe` 在独立长路径目录完成实际静默安装、ColdX 启动、退出、卸载，验收进程退出码为 0：

- `installed=true`、`smoke=true`、`uninstalled=true`。
- `menuBarVisible=false`，`backendStopped=true`。
- `residualFileCount=0`；卸载注册项与安装的主程序均已移除。
- 应用错误日志为空。安装时释放约 30,000 个依赖文件，本机完整解包约 8 分钟；这不代表其他电脑的安装耗时。

本机隔离测试目录中的 `acceptance.json` 和 `smoke.json` 记录实际安装、桌面窗口与运行环境状态；这些机器记录不上传源码仓库。验收没有调用付费模型，也没有修改现有网页版的数据。发布前统一所有 ColdX 自身包版本为 0.1.1，并重新构建发行包及验证独立目录启动。

## 框架依据

窗口使用 Electron 的[原生窗口与菜单 API](https://www.electronjs.org/docs/latest/api/base-window)；Windows 安装器使用 electron-builder 的 [NSIS target](https://www.electron.build/v26/docs/nsis/)。本轮仅验证 Windows x64，不宣称 macOS、Linux 或 Windows ARM64 已完成实机验收。
