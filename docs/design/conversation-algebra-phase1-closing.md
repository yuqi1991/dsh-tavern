# 阶段 1 收尾清单

状态：**阶段 1 全部完成**。收尾矩阵经用户在白名单会话全流程执行并确认"都正常了"（2026-09-30）；含回退→撤销→再重生成的组合路径修复（`96a133e`，reroll 探测撤销恢复的原始行）。最终核查：136 笔已提交事务，lastCommit=regen-complete。

## 已完成（部署+验收）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 1 脚手架退役（dropTagged） | ✅ 部署+用户验收 | PHASE-1-RETIREMENT-WIRING.md |
| 2 正文编辑（editStep） | ✅ 部署+用户验收 | PHASE-1-BODY-EDIT.md |
| 3 回退/撤销 + 中止恢复 + complete 投影 | ✅ 部署+用户验收 | PHASE-1-ROLLBACK-WIRING / REGEN-RECOVERY |
| 4 辅助写入四接线点 | ✅ 部署+用户验收 | PHASE-1-AUXILIARY-WRITES（reply-projection 差异分支留自然覆盖） |
| 5 切片 A（reroll=checkout+generate） | ✅ 部署+用户验收 | PHASE-1-ITEM5-REROLL（含四缺陷修复记录） |
| 5 切片 B（撤销释放抑制+客户端回溯守卫） | ✅ 部署（2026-09-30 PID 1294262） | deployment/item5-sliceB-live.json |
| ADR-0008（变体=分支，取代 0005） | ✅ 落档 | docs/adr/0008 |
| B1–B7 不可表示论证 | ✅ 落档 | PHASE-1-FAULT-LEDGER.md |

## 阶段 1 收尾验收矩阵（白名单会话一轮全流程）

按实现方案 §4 验收要求，开关**开**状态下依次执行，每步确认对话/轨迹/状态面板一致：

1. 发一轮正常输入（触发 retire + reply-projection 空跑 + frame 注入）
2. 重新生成正文 ×2（第二次即重复重生成路径；确认旧正文在分支列表可见——若无 UI 则查 `branchRegistry`）
3. 带输入编辑的重生成 ×1
4. 中止一次重生成（出字后停止）
5. 回退一轮 → 撤销回退 → 再回退
6. 编辑上一轮正文保存，再发一轮
7. 刷新页面 ×2：楼层数与内容零变化

**开关关回归**：重启时不带白名单 env（或临时移除该会话），对非白名单会话重复 1/2/5，行为应与迁移前 legacy 完全一致（除 ADR-0008 的多版本归档——关侧无分支写入）。

## 已知残留（阶段 2 处理，不阻塞阶段 1）

- chat 内容镜像与 `replaceLastRound`/`swipes` 四字段同步：规格删除物，被 chat 镜像删除阻塞（阶段 2 首项）。
- 客户端「时间跳转到次日中午」泡泡：本地缓存+旧版 walk-back 越界（切片 B 已加守卫，历史脏缓存待自然淘汰或用户清缓存）。
- 分支列表/切换/清理产品 UI：规格 §9，阶段 2。
- MVU 变体级联动（D1）：阶段 2。
- 失败回合 replay 清理走旧路径（clearFailedTurnSurface）：低风险，阶段 2 随请求前过滤一起收编。
