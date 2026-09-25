# 小绒蜂巢实施计划

Spec: `docs/superpowers/specs/2026-09-20-in-app-hive.md`。保留现有 dirty feature 分支；不修改用户数据、不安装、不发布。当前任务与上轮桌面复测分开记录。

## Task 1 — 原生协作阶段和经验

Owner: independent host implementer. Files: plugin/companion-host.mjs, lib/companion/state.mjs, lib/companion/store.mjs, new lib/companion/growth.mjs as needed; test/companion-host*.test.mjs. No UI/desktop edits.

1. 写原生 round 用例：三个成员完成后汇总调用落到 review 成员，snapshot round.phase 从 exploring 变 synthesizing，最终 settled。假模型只有汇总返回合法 coldx-gene fence。
2. 新增规范中的 genes/round 可选字段和 updateGene RPC。规范中签名为共享接口，不使用其他别名。
3. 原有 memberTurn 执行/权限保持；仅公开结果用于经验，候选不可自动激活。失败和取消不能产生候选。
4. 测试实际下一轮 prompt 包含已启用经验、停用后不注入，最多两条/1200 字符；候选默认不注入；来源不可伪造。
5. 保存恢复 round/genes，运行中重启恢复为 interrupted 且 phase=settled；旧文件正常读取。坚持现有容量上限。
6. 运行 `node --test test/companion-host.test.mjs test/companion-host-native.test.mjs`，报告真实结果并自查。根节点拥有最终整合提交。

## Task 2 — 应用内群组 UI；根节点整合

Files: plugin/client/companion-source.mjs, companion.css, client-source.mjs, settings-host.mjs and related tests. Consume Task 1 exact optional contract; old/missing round/genes must render safely.

1. 移除 desktop bridge 和旧 settings 开关，Controller 仅刷新原生 host；旧偏好仍可加载。
2. 使用现有图片+CSS眼睛绘制三位不同色伙伴；使用 team.round.phase 和 tasks mood 指示实际状态，能打开对应任务。
3. 按用户最新修订删除 TeamDialog/舞台/tabs，新增 GroupSidebar 与主区域 GroupPage。使用原生会话槽临时注册群聊，离开后恢复普通会话；两类选择互斥。经验放进可展开资料，updateGene 调用失败保留当前状态并显示错误。
4. 保留草稿失败恢复和空任务禁用；新的三成员默认需要更新浏览器 fixture 的预期。
5. CSS 动效只用 transform/opacity，减少动态效果与隐藏状态下暂停；深浅色和窄屏依赖现有语义变量。
6. `node --test test/companion.test.mjs test/companion.browser.mjs test/coldx-settings-host.test.mjs test/client.test.mjs`；浏览器图像核验群聊密度与固定眼睛尺寸，实际原生页面核验群组/普通会话切换、草稿和来源跳转。

## Task 3 — 删除桌面宠物并整合；根节点执行

1. 逐个审阅 desktop/main.mjs、titlebar-preload.cjs、electron-builder.cjs、build-companion-asset.mjs 和 titlebar tests 中上轮新增桌面相关 diff，仅移除这些已识别变更。
2. 删除新增 desktop/companion-*、desktop/assets/companion.png、desktop companion tests，不删除 app 内图片或正式数据。
3. `node plugin/client/build.mjs` 更新生成产物。`pnpm test` 和独立浏览器测试；检查桌面 bootstrap 不再创建 companion window。
4. task reviewer 检查新 host 契约及状态边界；最终独立 reviewer 检查整体。修复实际问题后运行相关回归。
5. 记录研究来源、实装内容与未测边界。应用保持卸载，不自动启动后台宠物。

## Review focus

1. 取消/部分失败/持久化失败不能被标成成长或成功。
2. 经验是低优先级参考，不能扩大工具权限或替代本轮用户要求。
3. 多团队/切换原任务时不显示错误队伍；缺失子任务用来源提示而不跳错。
4. 某个 task 等待确认时动效和摸摸不掩盖实际状态；减少动态效果可测。
5. 删除 desktop 功能不伤到本来存在的标题栏、后端 lifecycle 和用户配置。
