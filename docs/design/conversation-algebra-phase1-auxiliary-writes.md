# 阶段 1 第四项：辅助写入迁移

状态：模板历史写入已在开发副本和 fork 实现，静态检查与离线测试通过；2026-09-29 经用户授权部署并重启，运行安装的启动与只读会话检查通过，模板改写功能待用户验收。第四项另外三个接线点仍待处理。

## 模板历史写入（实现方案 §4 第四项，`template-history.js`）

- 开关启用时，`prepareTemplateHistory` 在 Chat 提交前用当前 fold 的 `editStep` 守卫检查目标，并在 detached Session 上运行同一事务预检。工具调用 step 由 G4 拒绝，拒绝时不产生实际 Session 写入。
- Chat 中的 `templateHistoryEdit.algebra` 是持久恢复标记；`synchronizeTemplateHistory` 使用标记中的 operationId 经 `runTransaction` 提交。重复同步按事务提交记录去重，开关关闭后仍能恢复已经记录的代数意图。
- 部署后复核发现，同一条模板输入在写入完成前被重复同步时可能重新生成 operationId；现已修正为复用原标记，补充幂等回归。修正版于本批授权下单文件部署并重启。
- 开关关闭或旧标记仍走既有替换路径。其他辅助写入点（`session-stable-prefix.js`、`background-surface.js`、`index.js` 的正文投影）尚未迁移，不能称第四项完成。

## 证据与部署边界

- 开发副本 `node --test tests/algebra/*.test.mjs`：143/143 通过。
- fork 合成测试树同命令：143/143 通过；模板历史、脚本 Host Adapter、人物卡更新相关测试：36 通过、1 个原有跳过。
- `node --check` 检查两个服务端文件，`git diff --check` 通过。
- 用户授权后按实现方案 §6 备份 `/tmp/dsh-tavern-template-history-backup-20260929-182717`，仅复制 `lib/domain/template-history.js` 和 `lib/index.js`，哈希与开发副本一致；重启后的唯一 DSH PID 为 1034105。
- 运行安装实测仅涵盖启动与只读检查：浏览器经认证打开 HTTP 200、无页面异常；测试会话 `getSession` 成功、历史门就绪，非白名单会话开关为关闭；启动窗口未见插件加载、语法或模块缺失错误。详见开发副本 `deployment/template-history-live.json`。
- 尚未在运行安装触发模板历史改写，不能称该功能已验收。
- 幂等修正另行备份 `/tmp/dsh-tavern-template-retry-backup-20260929-183942`，仅部署 `lib/domain/template-history.js`；新 PID 1038660，浏览器及只读会话冒烟再次通过。详见开发副本 `deployment/template-history-retry-live.json`。功能验收请以此版本为准。

## 用户验收发现：模板输入泡泡仍显示原文

用户发送 `模板验收标记：<%= 1 + 2 %>` 后报告泡泡未变。只读 RPC 证实模板引擎与 Chat Helper 消息已得到 `3`，但 `getSession.view.inputSources[65]` 仍为模板原文，代数事务计数不能证明该用户泡泡正确。原因是输入投影把 Chat 中第 7 条用户消息按楼层序号写到键 `8`，而当前 Session 对应原生 turn 为 `65`；`runtimeInputs[65]` 的原始文本因此未被覆盖。开发副本已改为按相邻 assistant 的 `turn` 建键，新增红转绿回归。fork 保留其增量投影实现，同样按原生 turn 修正；现有长历史成本测试通过。

按本批授权备份 `/tmp/dsh-tavern-template-input-view-backup-20260929-191856`，仅部署开发副本 `lib/index.js` 与新增 `lib/domain/input-fields-projection.js`，重启后 PID 1051105。开发副本代数测试 144/144 通过；fork 合成代数测试 143/143 通过，输入投影与关联测试 78/78 通过。运行安装只读 RPC 已将已保存的测试消息唯一投影到 `inputSources[65] = 模板验收标记：3。我观察周围，等待回应。`，原错误键 `8` 不再出现；浏览器 HTTP 200、无页面异常，启动日志无插件加载/语法/模块缺失错误。此证据证明读取投影已修正；用户尚未刷新界面复验，功能验收待确认。详细部署证据见开发副本 `deployment/template-input-view-live.json`。
