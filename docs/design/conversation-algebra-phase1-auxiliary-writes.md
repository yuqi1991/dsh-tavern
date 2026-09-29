# 阶段 1 第四项：辅助写入迁移

状态：模板历史写入已在开发副本和 fork 实现，静态检查与离线测试通过；尚未部署到运行安装，未做运行安装实测。第四项另外三个接线点仍待处理。

## 模板历史写入（实现方案 §4 第四项，`template-history.js`）

- 开关启用时，`prepareTemplateHistory` 在 Chat 提交前用当前 fold 的 `editStep` 守卫检查目标，并在 detached Session 上运行同一事务预检。工具调用 step 由 G4 拒绝，拒绝时不产生实际 Session 写入。
- Chat 中的 `templateHistoryEdit.algebra` 是持久恢复标记；`synchronizeTemplateHistory` 使用标记中的 operationId 经 `runTransaction` 提交。重复同步按事务提交记录去重，开关关闭后仍能恢复已经记录的代数意图。
- 开关关闭或旧标记仍走既有替换路径。其他辅助写入点（`session-stable-prefix.js`、`background-surface.js`、`index.js` 的正文投影）尚未迁移，不能称第四项完成。

## 证据与部署边界

- 开发副本 `node --test tests/algebra/*.test.mjs`：142/142 通过。
- fork 合成测试树同命令：142/142 通过；模板历史、脚本 Host Adapter、人物卡更新相关测试：36 通过、1 个原有跳过。
- `node --check` 检查两个服务端文件，`git diff --check` 通过。
- 运行安装本批未部署，未重启，未进行功能验收。下次按实现方案 §6 备份后仅复制 `lib/domain/template-history.js` 和 `lib/index.js`，需用户明确同意部署与重启。
