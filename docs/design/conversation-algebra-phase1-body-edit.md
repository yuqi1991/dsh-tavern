# 阶段 1 第二项：正文编辑

状态：开发与离线验证完成，待用户批准独立部署；未进行本项运行安装验收。

## 实现范围

对应规格 §4.1 editStep、§4.2 G4/G6、§5.1 事务和实现方案 §4 第 2 项。
body-editor 的新编辑在 conversationAlgebra 开启时带 algebra:1 意图，经 computeFold → editStep → runTransaction → 既有 Session adapter 写入。
消息 id、role、turn、step、provider/model 保留；不再为新路径伪造 body-edit 模型来源或硬编码 step=1。source 附带事务标记。

G4 和 detached 宿主预检都在 Chat 意图写入前执行。异步正文投影期间会话头移动则拒绝保存；实际事务另做 expectedHead 检查。
完成记录以 bodyEdit.id 对应 operationId 去重，因为消息 id 保持原值。flush 失败后的重试、重启后恢复即使关闭开关仍走原意图指定的新路径，不能降级为旧写入。

本项仍保留现有 Chat journal-first 编辑意图与内容镜像，属于分步迁移；没有提前完成内容去镜像或宣称 Chat 与 Session 文件构成跨存储原子事务。旧 bodyEdit 标记保留既有恢复兼容分支。新标记找不到原 step 时显式拒绝，不清除意图或猜测替代目标。
正文编辑仍限末轮、保留 HTML 与变量，不调用模型、不重新执行脚本/MVU。用户泡泡编辑、回退/重生成代数接线及分支 UI 不在本项。

## 证据

- 静态检查通过：两个部署 JS 文件 node --check、git diff --check。
- 离线测试通过：开发副本与 fork 集成副本各 98 pass / 0 fail / 0 skip。最终诊断字段变更后完整 apply 冒烟再次通过。
- 回归包含开关开/关、原 HTML/展示/变量行为、过时 token、宿主预检拒绝零写入、Chat 写入失败、flush 丢失恢复、G4 工具配对拒绝、连续编辑身份保持、异步投影期间头移动、关闭开关恢复和幂等。
- 运行安装实测：未进行。第一项退休及泡泡修复的验收不能代替本项。

## 部署和验收

只部署开发副本 lib/domain/body-editor.js 和 lib/index.js，SHA256 白名单见 deployment/body-edit.json。fork 独立改动已在开发目录下三方合并并测试，不能把 fork index.js 整个覆盖到在线安装。
获授权后按 §6 重新核对哈希、备份 lib、白名单复制、重启当前唯一实例。保留测试会话 session-ebefd02d-a2d2-4d20-a9a1-d43cb9db3b19 的进程级白名单，其他会话默认关闭。无客户端变更。

用户检查：
1. 等前台与后台任务结束，编辑最后一轮正文并保存；聊天正文和轨迹应一致，HTML/状态面板不丢失。
2. 连续再编辑一次，刷新后仍保留第二次修改，不出现重复正文。
3. 再发一轮，确认对话可继续；若该正文包含工具调用，应明确拒绝编辑而不是拆开工具步骤。
4. 非测试会话仍使用旧编辑路径。

实现方通过只读 getConversationAlgebraStatus 核对 bodyEditTransactions 增加、最近操作以 tavern-body-edit: 开头；仅页面无错不足以证明新路径使用。接口计数仅针对已加载会话。

回滚限制：新编辑意图出现后不能直接还原成不认识 algebra:1 的旧 body-editor（会重放错误身份）。需要先关闭新写入、保留本版本恢复兼容分支，确认已有事务恢复完成，再处理代码问题；不得手工修改 Chat 或 Session 文件。如果部署失败且尚无新编辑，可恢复两个白名单备份并重启。
