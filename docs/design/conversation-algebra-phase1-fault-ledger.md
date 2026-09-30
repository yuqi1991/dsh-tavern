# 阶段 1 验收：故障账本 B1–B7 不可表示论证

对应规格 §1.2 与验收标准 §17.5。每条给出：旧故障成因 → 新架构的结构性消灭机制 → 测试佐证。

## B1 工具调用行渲染到轨迹页顶部（turn:step 撞键）

**旧因**：regen 提交按节点替换，`turn:step` 坐标在新旧行间冲突。
**新架构**：重生成不再折叠替换节点（切片 A 前置 checkout），生成回合以原生 step 追加；唯一的替换写入（墓碑/编辑）全部经事务层 G2 step 原子性守卫——assistant step 必须携带全部 tool_result，配对不可拆。
**佐证**：`guards-transaction.test.mjs`（G2 拒绝拆散配对）；`item5-reroll-algebra.test.mjs` 用例 1 断言 body 行恰好 1 条且配对完整。

## B2 回退后输入 109 与帧 110/111 孤儿化（掏了中间非后缀）

**旧因**：rollback-surface 区间数学按 seq 区间硬删，中段掏空留下两端孤儿。
**新架构**：回退 = `branch+checkout`，由 `checkout` 原语编译为回指式 replace，目标集永远是从锚点到头部的**连续后缀**（`planCheckout` 显式拒绝非后缀）；守卫 G3 禁止 dropTagged 触及配对引用行。
**佐证**：`checkout-anchor.test.mjs`、`checkout-restoration.test.mjs`（含锚点拆开工具步骤的拒绝）；运行时 12+ 笔 checkout 事务回放 fold==host。

## B3 墓碑 source 非法卡死重新生成（伪造空消息未过写入守卫）

**旧因**：删除被实现为手工伪造的空 assistant 消息，source 不完整，宿主 seed 校验拒绝加载。
**新架构**：墓碑只经事务层生成，G5 强制 assistant 墓碑从原行复制完整 model source；来源不完整则事务在写入前拒绝（零写入）。
**佐证**：`guards-transaction.test.mjs` G5 拒绝用例；`retirement-host.test.mjs` 真实宿主墓碑可恢复。

## B4/B5 开关行/技能目录每轮重发（退役即丢状态）

**旧因**：退役墓碑不携带去重状态，宿主 digest 判定 existing 缺失即重发。
**新架构**：退役进 fold 定义——空内容行不属于任何视图，去重状态（disabledWritingSkills 等）保存在 Chat（唯一权威），目录由宿主 agent hook 每轮按需发布。
**佐证**：`retirement-policy.test.mjs`、`retirement-host.test.mjs` 幂等用例；运行时 retire 事务 97 笔零重发。

## B6 空行需请求前过滤（墓碑滞留 surface）

**旧因**：墓碑留在宿主 surface 上，请求装配前手工过滤。
**新架构**：fold 的 `visibleContent` 把空内容行排除在所有视图之外（结构性）；请求前过滤保留仅作 legacy 兼容，代数路径不依赖。
**佐证**：`computeFold` 单元与全部 golden replay（旧编码含墓碑会话 fold ≡ 宿主 surface）。

## B7 用户泡泡不更新（text/sourceText/swipes/templateInputSource 四字段失步）

**旧因**：chat 镜像与会话日志双写，四个字段各写各的。
**新架构**：内容单事实源在事件日志；镜像字段仍存在（阶段 2 删除）但写入收进同一事务/同一变更块（切片 A 的 userProjection 与 chat 镜像同步在一次 update 内；模板/输入投影已按原生 turn 建键）。四字段失步在代数路径上不可构造——要么整块成功要么整块不落。
**佐证**：`edited-input-reroll.test.mjs`（镜像一致性钉死）、`template-input-turn.test.mjs`；运行时验收「显示3」。
