# 阶段 1 第四项：辅助写入迁移

状态：模板历史写入已在开发副本和 fork 实现，静态检查与离线测试通过；2026-09-29 经用户授权部署并重启，运行安装的启动与只读会话检查通过，模板改写功能待用户验收。第四项另外三个接线点仍待处理。

## 模板历史写入（实现方案 §4 第四项，`template-history.js`）

- 开关启用时，`prepareTemplateHistory` 在 Chat 提交前用当前 fold 的 `editStep` 守卫检查目标，并在 detached Session 上运行同一事务预检。工具调用 step 由 G4 拒绝，拒绝时不产生实际 Session 写入。
- Chat 中的 `templateHistoryEdit.algebra` 是持久恢复标记；`synchronizeTemplateHistory` 使用标记中的 operationId 经 `runTransaction` 提交。重复同步按事务提交记录去重，开关关闭后仍能恢复已经记录的代数意图。
- 部署后复核发现，同一条模板输入在写入完成前被重复同步时可能重新生成 operationId；现已在开发副本修正为复用原标记，补充幂等回归。该修正尚未部署，运行安装仍为上一版。
- 开关关闭或旧标记仍走既有替换路径。其他辅助写入点（`session-stable-prefix.js`、`background-surface.js`、`index.js` 的正文投影）尚未迁移，不能称第四项完成。

## 证据与部署边界

- 开发副本 `node --test tests/algebra/*.test.mjs`：143/143 通过。
- fork 合成测试树同命令：143/143 通过；模板历史、脚本 Host Adapter、人物卡更新相关测试：36 通过、1 个原有跳过。
- `node --check` 检查两个服务端文件，`git diff --check` 通过。
- 用户授权后按实现方案 §6 备份 `/tmp/dsh-tavern-template-history-backup-20260929-182717`，仅复制 `lib/domain/template-history.js` 和 `lib/index.js`，哈希与开发副本一致；重启后的唯一 DSH PID 为 1034105。
- 运行安装实测仅涵盖启动与只读检查：浏览器经认证打开 HTTP 200、无页面异常；测试会话 `getSession` 成功、历史门就绪，非白名单会话开关为关闭；启动窗口未见插件加载、语法或模块缺失错误。详见开发副本 `deployment/template-history-live.json`。
- 尚未在运行安装触发模板历史改写，不能称该功能已验收。
