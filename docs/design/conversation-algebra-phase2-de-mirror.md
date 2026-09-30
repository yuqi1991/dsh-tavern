# 阶段 2：chat 去内容镜像

状态：P2-A 已部署（2026-09-30 PID 1338293，备份 `/tmp/live-lib-backup-p2a-20260930-131147`），dev 170/170、fork 169/169。用户功能验收待进行（重生成一轮即可）。

## 切片规划

### P2-A（已完成，`a562291`）：重生成停写 swipes 镜像
`replaceLastRound` 不再构建 assistant 的 `swipes:[source]/swipeId:0`，也不再把用户消息 swipes 重写为编辑后文本；存储的旧数组原样保留（旧会话读兼容）。helper 投影对无 swipes 字段的消息回退单变体（`projectTavernHelperMessage` 既有行为）。
测试：新增「legacy compat」钉死（旧数组不被重写）+ 既有镜像断言改为 P2-A 语义。

### P2-B（下一步）：变体枚举投影
视图层（index.js，同时持有 chat 与 session）物化 `variantBodies[turn]`：turn→锚点 seq→同锚兄弟分支→各分支 head 的正文文本（从 session 事件读取）。`projectTavernHelperMessage` 消费该投影：有变体时 swipes=变体文本列表、swipe_id=活跃位；无则维持单变体回退。该投影同时供后续 `‹ n/m ›` UI 复用。

### P2-C：MVU 基线改分支键
finalize 仍写 `swipes+variables` 数组（MVU 按 swipeId 索引，index.js 15 处引用耦合 `mvuBaseline.swipeId`）。改为 branch/revision 键（ADR-0006 已有 stale 规则），删除 per-swipe 数组。前置：P2-B 提供变体枚举后才有语义等价物。

### P2-D：模板态去 swipe
`full-prompt-template-state`（8 处）与 `tavern-script-host-adapter`（12 处）的 swipe 索引改走 P2-B 投影。

### P2-E：净删审计
删 `planUserInputSurface` 代数分支残留、请求前空行过滤（fold 已排除）、旧 chat 迁移读穿透；对照规格 §17.6 净删 ≥40% 基线（5,793 行）核算。

## 验收边界
- 旧会话（带存储 swipes）：helper 面板显示不变（读穿透）。
- 新会话：重生成后 `messages[i].swipes` 不再出现；MVU/模板不受影响（P2-C/D 完成前 finalize 的 MVU 数组照写——那是 P2-C 的对象，不是回退）。

## P2-B 部署记录（2026-09-30）

- 提交：dev `7dc7bbf`，fork `4bfc9dd9`（已推送 `feat/conversation-algebra-retirement`）
- 测试：`tests/algebra/variant-bodies.test.mjs` 2/2；全套 `node --test tests/algebra/*.test.mjs` 172/172
- 部署文件（备份于 `/tmp/dsh-tavern-p2b-backup-0930/`）：`lib/domain/variant-bodies.js`（新增）、`conversation-algebra-branches.js`、`conversation-algebra-history.js`、`conversation-algebra/primitives.js`、`round-history.js`、`tavern-helper-context.js`、`lib/index.js`
- 重启：直接拉起 `runtime/bin/dsh --profile tavern`（DSH_HOME=工作区根），白名单 env 确认 `session-ebefd02d-…`
- 只读冒烟：`getHostCompatibility` 200 verified；`getConversationAlgebraStatus`（白名单会话）`enabled:true, historyReady:true`
- 待验收：白名单会话内重掷一轮 → helper 面板该楼层出现 `‹ 1/2 ›` 变体（新正文为 active，旧正文为分支变体）
