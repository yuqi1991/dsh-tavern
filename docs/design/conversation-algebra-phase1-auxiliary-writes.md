# 阶段 1 第四项：辅助写入迁移

状态：模板历史写入与用户泡泡投影已部署且通过用户验收。固定背景接线已部署并通过用户功能验收。后台 Surface 多区间回退与正文投影直写已部署（PID 1137452）并通过启动与只读冒烟，写入路径待用户功能验收。

## 模板历史写入（实现方案 §4 第四项，`template-history.js`）

- 开关启用时，`prepareTemplateHistory` 在 Chat 提交前用当前 fold 的 `editStep` 守卫检查目标，并在 detached Session 上运行同一事务预检。工具调用 step 由 G4 拒绝，拒绝时不产生实际 Session 写入。
- Chat 中的 `templateHistoryEdit.algebra` 是持久恢复标记；`synchronizeTemplateHistory` 使用标记中的 operationId 经 `runTransaction` 提交。重复同步按事务提交记录去重，开关关闭后仍能恢复已经记录的代数意图。
- 部署后复核发现，同一条模板输入在写入完成前被重复同步时可能重新生成 operationId；现已修正为复用原标记，补充幂等回归。修正版于本批授权下单文件部署并重启。
- 开关关闭或旧标记仍走既有替换路径。`background-surface.js` 与 `index.js` 正文投影尚未迁移，不能称第四项完成。

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

按本批授权备份 `/tmp/dsh-tavern-template-input-view-backup-20260929-191856`，仅部署开发副本 `lib/index.js` 与新增 `lib/domain/input-fields-projection.js`，重启后 PID 1051105。开发副本代数测试 144/144 通过；fork 合成代数测试 143/143 通过，输入投影与关联测试 78/78 通过。运行安装只读 RPC 已将已保存的测试消息唯一投影到 `inputSources[65] = 模板验收标记：3。我观察周围，等待回应。`，原错误键 `8` 不再出现；浏览器 HTTP 200、无页面异常，启动日志无插件加载/语法/模块缺失错误。用户刷新界面后确认“是的，显示3”，本次用户泡泡投影修复通过界面验收。详细部署证据见开发副本 `deployment/template-input-view-live.json`。

## 固定背景接线（实现方案 §4 第四项，`session-stable-prefix.js`）

开关启用时，固定背景的新快照追加、确认后的新版本追加、旧非空快照的原位迁移均通过 `runTransaction`。开关关闭保留原路径。宿主 Session 测试覆盖首次写入、旧版迁移、重复调用以及关闭路径。开发副本代数测试 147/147 通过；fork 合成测试树含固定背景测试 154/154 通过；语法与 diff 检查通过。

2026-09-29 部署：按实现方案 §6 备份 `/tmp/live-lib-backup-fixedprefix-20260929-232354`，仅复制开发副本 `lib/domain/session-stable-prefix.js` 与 `lib/index.js`（哈希与开发副本一致），带白名单环境变量重启后 PID 1114797。启动窗口无插件加载/语法/模块缺失错误；白名单会话 `getConversationAlgebraStatus` 返回 enabled=true、historyReady=true；`getSession` 只读调用正常。部署证据见开发副本 `deployment/fixed-prefix-live.json`。用户随后在白名单测试会话触发固定背景写入并确认"正常的"，本小节通过用户功能验收。

## 后台 Surface 回退与正文投影（实现方案 §4 第四项收尾）

### `background-surface.js:38` 多区间回退

`rewindBackgroundSurface` 改为 async 并接受 `algebra` 参数。开关启用时全部墓碑收进单个 `runTransaction`（operationId 前缀 `background-rewind:`，墓碑沿用最后 assistant 的 model source，G5）；开关关闭保持原逐组替换路径。分组推导（固定行、边界、连续组）不变。两个调用方接线：`round-history.js` 回退路径按前台 `chat.sessionId` 判定 `algebraHistory.enabled()`；`background-agent-task.js` 任务启动路径经新增 `resolveConversationAlgebra` option（index.js 注入，前台 id 白名单 + 隔离就绪检查）。失败语义不变：任务中止包装、回退警告、needs-rewind 下次重试。

### `lib/index.js` 正文投影直写

`replaceAssistantReply`（`agent/turn-stopping` → `saved.reply.sessionText`）在开关启用时经 `runTransaction` 提交单节点替换（operationId 前缀 `reply-projection:`，replacement 补齐 `stream` 数组满足 G1）；开关关闭保持原路径。该函数在 `agent/turn-stopping` 事件内被 await。

### 证据

- 开发副本 `node --test tests/algebra/*.test.mjs`：153/153（新增 `background-rewind.test.mjs` 4 例、`reply-projection.test.mjs` 2 例）。
- fork 同命令：152/152；fork `tests/background-surface-projection.test.mjs` 适配 async 后 4/4。
- `node --check` 全部改动文件通过；`lib/index.js` 经 runtime-loader 冒烟导入通过；`git diff --check` 通过。
- 开发副本提交 `e5fcb8a`（后台回退）、`3bc5346`（正文投影）；fork `c06341a8`、`08cdb7df`。
- 尚未部署到运行安装，未做运行安装实测或用户验收；第四项至此四个接线点全部实现（模板历史、固定背景、后台回退、正文投影），部署验收通过前不标记完成。

## 2026-09-30 部署：后台回退 + 正文投影

按实现方案 §6 备份 `/tmp/live-lib-backup-aux-final-20260930-002708`，白名单复制 4 个文件（哈希与开发副本一致），带白名单环境变量重启后 PID 1137452。启动窗口无插件加载/语法/模块缺失错误；白名单会话只读 RPC 正常。部署证据见开发副本 `deployment/auxiliary-writes-final-live.json`。写入路径尚未在运行安装触发，用户验收前不标记第四项完成。
