# 阶段 1 第五项：reroll / 改输入重掷重构

状态：切片 A（前置 checkout 组合）已部署（PID 1171540）并通过启动与只读冒烟，用户功能验收待进行。切片 B/C（删除 editedInput 特判与 planUserInputSurface、complete 双写投影删除）未开始。

## 切片 A 内容（spec §8 reroll = checkout(锚点)+generate()）

- `regenBody` 在代数开启时：定位原输入节点为锚点 → `algebraHistory.prepare` 预检 branch+checkout → Chat 回退事务内持久化意图与 `preCheckoutBranchId` → 生成前 `recover` 提交 checkout（旧正文成兄弟变体，模型不再看到）。
- 生成后不再 `planRegenerationSurface` 折叠：合成回合即 surface。改输入以单节点替换改写原输入行；合成回合的 plugin 输入行由 `complete()` 快路径以墓碑退役（form=regen-attempt），轮内恰一条玩家输入。
- 失败/中止：`abortWork` 检测 `preCheckoutBranchId`，改用 prepare(branchId) 恢复旧线（旧正文回面），替代后缀清理。
- `createConversationHistory` 新增 `commit` 门面；legacy（开关关）路径逐字节不变。

## 语义变化（钉死于测试）

- reroll 后回退：目标为当前原生轮（合成 turn），surface 整轮清除（含输入行）；chat 镜像仍保留配对（timeline 合成 checkpoint 怪癖，Phase 2 收编）。
- 失败重生成归档分支数 1 → 2（旧正文变体 + 中止尝试）。

## 证据

- 钉死 harness：`item5-reroll-algebra.test.mjs` 4 例、`edited-input-reroll.test.mjs` 4 例；产品回归 `round-history-branches.test.mjs` 7 例（分支数断言按新语义更新）。
- 开发副本全套 165/165；fork 164/164。开发 `abc124e`，fork `2839eb56`（已推送）。
- 部署：备份 `/tmp/live-lib-backup-item5-sliceA-20260930-015830`，三文件哈希一致，启动窗口干净。证据 `开发副本 deployment/item5-sliceA-live.json`。

## 验收（用户）

白名单会话：重新生成正文一次（建议带输入编辑）；可选做一次「开始重生成后立刻停止」验证原正文恢复；重生成后再回退一轮确认 surface 干净。确认对话/轨迹一致、刷新无错乱后，实现方核查 `checkout:` 事务增量与 fold 一致性。

## 切片 A 验收记录（2026-09-30）

用户在白名单会话完成三项验收操作，过程暴露并修复四个叠加缺陷：

1. **重复重生成目标丢失**（`4131a94`）：切片 A 保留正文原生 turn，目标选择未查 `regeneratedDshTurns` 映射。修复：选择时映射可见轮→原生轮。
2. **中止回合漏抑制**（`3903d08`）：`regenerationAttemptEnd` 把 checkout 元数据控制行误判为尝试开始，真 turn/start 成了边界，中止回合不进 `suppressedDshTurns`，半截正文残留。修复：边界扫描跳过事务控制行。
3. **回退映射清理错键**（`de2bc6f`）：回退删 `regeneratedDshTurns[hiddenTurn]`，切片 A 下键=可见轮、值=原生轮，只删值命不中键。修复：键或值任一匹配即删。
4. **回退抑制缺可见轮**（`31fa076`）：`regeneratedVisibleTurn = mapping[hiddenTurn]` 按值查键为 NaN，可见轮不进抑制名单，客户端重显已回退轮。修复：值查不到时反向按键找值。

数据修复（均走 Chat journal 事务）：turn 71 补抑制、68→73 映射删除、68 补抑制、55/64 移除（撤销未清理抑制所致的过度隐藏）。

### 用户验收结论

重新生成（含输入编辑）✅；中止恢复 ✅（修复后半截正文消失、原正文保留）；回退 ✅（服务端两层核验：surface 清除、chat 状态一致、fold==host）。用户确认服务端行为正确，判定验证通过。

### 已知残留（客户端，不阻塞）

- 「时间跳转到次日中午」用户泡泡在本会话不显示：服务器 chat.messages/inputSources/surface 三处均含该数据；系客户端本地隐藏缓存 + `hideUserForTurnTail` 向前查找越过轮次边界（stale tail 的 walk-back 无轮号守卫）。用户清除三个本地键后仍未恢复，暂不追。其他会话正常。
- 撤销回退不清理该轮抑制名单条目（legacy 缺口，今日被放大）：切片 B/C 一并处理。
- 回退后 chat 镜像保留配对（timeline 合成中间态恢复点怪癖）：Phase 2 chat 去镜像时消灭。
