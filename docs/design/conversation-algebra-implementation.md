# 会话操作代数 · 实现方案（交接文档）

- 版本：v0.1
- 日期：2026-09-29
- 状态：**阶段 0 已由用户验收；D2 回落 (a)。阶段 1 第一次迁移（脚手架退役）已部署并通过用户独立验收；第二项正文编辑已部署，启动检查通过，待用户功能验收；其余迁移未完成；见 `conversation-algebra-phase1-retirement.md`。**
- **读者：负责实现的后端 agent。本文是"怎么改"，需求与设计以《conversation-algebra.md》（同目录）为唯一来源，两者冲突时先改规格再改代码。**
- 背景约束（必须先内化）：用户曾因会话文件损坏经历 DSH 整体无法启动。**运行安装目录不是开发环境**——`apps/dsh-tavern/tavern-plugin/lib/` 下任何一个被加载的文件有语法/导入错误，都可能导致插件树加载失败、DSH 起不来。本文全部流程围绕"离线开发 → 验证 → 定点部署 → 可回滚"设计。

---

## 0. 环境地图

| 路径 | 身份 | 用途 |
| --- | --- | --- |
| `/home/claw/workspace/dsh-tarvern/` | 运行家目录（**无 .git**） | 只读参照 + 部署目标；`profile-data/` 下用户数据禁碰 |
| `apps/dsh-tavern/tavern-plugin/lib/` | 运行实现（重启 DSH 后生效） | 部署目标；`lib/client.js` 是**构建产物，禁止直接编辑**，客户端源码在 `src/client/` |
| `/home/claw/dsh-tavern-fork/` | GitHub fork（yuqi1991/dsh-tavern），main 与远端同步 | 最终版本化载体；其 `tavern-plugin/` 是部分快照，**不是**当前行为的权威 |
| `source-cache/dsh-tavern.git` | 上游 v2.3 bare cache | 读上游 `docs/`（ADR、architecture）、`tests/` 用 `git --git-dir=... show HEAD:<path>` |
| `/tmp/*-test.mjs`（9 套） | 既有离线测试 | harness 模式参考（trajectory-surface、regen-input 等） |

## 1. 红线（违反任何一条即停）

1. **禁止在运行安装目录直接开发**。改动一律先落在开发副本（§2），验证后按 §6 协议部署。
2. **禁止修改 `runtime/lib/node_modules/@deepseek-ai/*`**（宿主，只读）。
3. **禁止任何会话/聊天文件手术**。zstd 会话日志必须逐行成帧（首帧=单独 header 行，每事件一行一帧带 checksum），整文件重压缩曾导致 DSH 无法启动。本实现根本不需要写会话文件——一切经宿主 session API。
4. **禁止直接编辑 `lib/client.js`**（构建产物）。客户端改 `src/client/` 并按 package.json 构建流程产出。
5. **禁止动 `profile-data/tavern/data/` 下的用户数据**。实验一律用 UI 新建的一次性测试对话。
6. **有另一个 agent 也在改本库**（`skill-reminder.js` 曾被外部重写）。编辑共享文件（`round-history.js`、`foreground-frame-session-adapter.js` 等）前必须重读当前磁盘内容；开发副本内高频 git commit 以便对账。
7. 插件 lib 改动需**重启 DSH** 才生效；重启前先完成 §6 的检查清单。

## 2. 开发工作流（第 0 步，必做）

```bash
# 建立开发副本（一次性）
cp -a /home/claw/workspace/dsh-tarvern/apps/dsh-tavern/tavern-plugin /home/claw/dsh-tavern-dev/tavern-plugin
cd /home/claw/dsh-tavern-dev/tavern-plugin && git init && git add -A && git commit -m "baseline: live tree 2026-09-29"
```

- 所有开发、测试在 `/home/claw/dsh-tavern-dev/` 进行。
- 新增模块**只准 import 本地 `./` 域模块**（不得 import 宿主包），保证可独立冒烟导入（§6 步骤 2）。
- 每完成一个小节 commit 一次；部署到运行目录的内容 = 与 baseline 的受控 diff。

## 3. 阶段 0：纯新增，零接线（对运行零风险，可独立部署）

### 3.1 新模块 `lib/domain/conversation-algebra/`

```
guards.js        写入期守卫（G1–G7，见规格 §4.2）
primitives.js    appendStep / editStep / branch / checkout / dropTagged
transaction.js   五段事务（stage→guard→commit→bump→converge）
fold.js          规范折叠（含旧编码兼容读 + step 分组 + 版本号）
index.js         对外门面（唯一 import 入口）
```

接口草案（实现时可细化，语义不得偏离规格 §4）：

```js
// guards.js —— 守卫失败抛 GuardError（含规则编号），绝不部分写入
guardShape(data)              // G1：形状（规则移植自宿主 assertMessageEventShape，
                              //     dsh-session/lib/index.js:900/947，只读参照）
guardStepComplete(step)       // G2：assistant step 必须携带其全部 tool_result
guardDropTagged(rows, tag)    // G3/G7：仅注册标签；不得含正文文本；不得被配对引用
guardEdit(step)               // G4：拒改 role/身份/轮次；拒改含工具调用的 assistant step
guardTombstoneSource(orig)    // G5：墓碑沿用原行合法 source；缺失 provider/model 则拒绝退役

// primitives.js —— 每个原语返回待写事件列表，本身不落盘；落盘只经 transaction
appendStep(state, step) -> Op[]
editStep(state, stepRef, content) -> Op[]
branch(state, label) -> Op[]          // 写分支注册表（元数据）
checkout(state, ref) -> Op[]          // 编译为回指式 replace（复用 rollback 现有机制）
dropTagged(state, tag) -> Op[]        // 编译为空内容墓碑（满足 G5）

// transaction.js
runTransaction(session, {
  expectedHead,      // 乐观并发：实际头不符即抛 TransactionConflict，不重试不合并
  ops,               // 原语序列
  operationId        // source 元数据带 begin/commit 标记；fold 忽略未闭合尾部
}) -> { committedSeq, foldVersion }

// fold.js
computeFold(events, { fromCache }) -> {
  steps,             // 规范 step 列表（空内容行排除；replace 生效；按 turn:step 配对分组）
  headSeq, version
}
```

关键实现注意：
- 底层复用 `session-surface-mutations.js` / `session-events.js`，**不要新造写通路**。
- fold 必须能读旧编码（replace 区间、墓碑、`dsh-tavern-regen` 合成行）——用真实历史会话做黄金回放验证。
- step 分组键 `(turn, step, role)`；工具对归入其 assistant step（参照 `foreground-frame-retirement.js` 现有 `callNamesOf` 逻辑，该文件将是首个被收编对象）。

### 3.2 性质测试（`tests/algebra/`，node --test 即可跑，不需要 DSH）

1. **随机序列性质**：随机生成守卫通过的原语序列 ⇒ 断言 fold 恒满足：形状合法（G1）、配对完整（G2）、顺序合法（user/assistant 交替约束）、三视图（对话/轨迹/请求投影）一致。目标 10⁵ 序列零违规。
2. **守卫拒绝性质**：对每个守卫构造非法输入 ⇒ 断言抛 GuardError 且事件零写入。
3. **黄金回放**：复制若干真实 `session.v3.jsonl.zstd`（zstdcat 解出 JSONL，**只读**）⇒ 断言 `computeFold == 宿主 surface 投影`。

### 3.3 脚手架注入实验（B-1/B-2/B-3，判定 D2）

- B-1：在开发副本中给 `foreground-orchestration-strategies.js` 增加实验策略变体（不改现有路径），枚举 `assembleSystemPrompt(assembly)` 收到的 `assembly` 完整可变面（sections/contexts/tools 之外还有什么，尤其消息列表尾部可否瞬态注入）。部署按 §6 协议，开关 `tavern-settings.json` 的 `scaffoldingInjectionExperiment: true`（默认 false），只在一次性测试对话上跑。
- B-2：断言 `fold(steps) + 注入记录 == model-request-log 记录的实际请求`（逐字节，含 reroll 轮）。
- B-3：头部注入 vs 现行行式追加的前缀缓存命中对照（用 provider 返回的 usage/cached 字段）。
- 判定标准见规格 §13 阶段 0；结论回写规格 D2。

实验结论（2026-09-29）：B-1 不通过，因此按规格短路并回落 (a)。原生路径把 `contexts` 投影为持久 Session message；compatibility 路径在 `prepareStep` 丢弃宿主 runtime-context message。B-2/B-3 未执行，不作缓存命中结论。实验开关已关闭，运行安装恢复默认行为。

**阶段 0 验收**：性质测试全绿；黄金回放通过；B 实验结论落档。此时运行安装行为零变化。

## 4. 阶段 1：接线（特性开关 `conversationAlgebra`，默认关）

迁移顺序按风险从低到高，**每次迁移独立部署独立验收**：

| 序 | 目标 | 现有手术点（file:line，以磁盘为准重核） | 改法 |
| --- | --- | --- | --- |
| 1 | 脚手架退役 | `foreground-frame-retirement.js:68,79,100,149` | 收编为 `dropTagged`；墓簿 source 逻辑进 G5 |
| 2 | 正文编辑 | `body-editor.js:43` | 改 `editStep`（守卫 G4） |
| 3 | 回退/恢复 | `rollback-surface.js:447,475`；`regeneration-recovery.js:71,72` | 改 `branch+checkout`；regeneration-recovery 大半删除 |
| 4 | 辅助写入 | `template-history.js:71`；`session-stable-prefix.js:149`；`background-surface.js:38`；`index.js:3888` | 逐个过 `runTransaction` |
| 5 | reroll/改输入重掷 | `round-history.js:170,179,561`（最后做，最大） | reroll=`checkout(锚点)+generate()`；`editedInput` 标志、`planUserInputSurface`、`last-round-replacement.js` 四字段同步删除 |

配套工作：
- **分支注册表**：建议落在 chat 存档顶层字段 `branchRegistry`（与聊天持久化同事务；内容去镜像后 chat 存档本来就只剩非内容状态）。懒回填：旧对话首开时从 fold 推导初始注册表。
- **chat 存档去内容镜像**：`messages[i]` 停写 `text/sourceText/swipes/templateInputSource`（保留 role/ts/id/mvu 等游戏状态）；读取方（`readRegenerationInput`、正文编辑器等）改读 fold。旧对话读穿透适配。
- **泡泡编辑 UI**：`src/client/` 新增编辑态，复用现有客户端→服务端通道（重生成面板同路）新增 `editUserMessage` 入口，服务端跑 `editStep` 事务。
- **D6**：在 fork repo 写新 ADR（`docs/adr/0008-*`，取代 0005，理由引用规格 §10），与阶段 1 一并提交。

**阶段 1 验收**：开关开/关各跑一轮完整游玩（发一轮、reroll×2、改输入重掷、回退、编辑泡泡、切变体）；关闭开关后行为与迁移前一致；故障账本 B1–B7 场景复现不了。

## 5. 阶段 2：删除旧机制

- 删除 `swipes[]/swipeId` 镜像与 `replaceLastRound`；变体 UI（`‹ n/m ›`，仅末楼，规格 §9.2）。
- MVU 改响应式回放：`状态@head = fold(可见 assistant step 的已记录增量)`；检查点=前缀哈希键缓存；结算事件落分支戳（沿用 ADR-0006 stale 规则）。
- 死代码清理：`regeneration-recovery.js`、`rollback-surface.js`/`story-timeline.js` 约半、客户端 `repairToolCallOwnership` 补丁、请求前空行过滤（进 fold 核心）。
- 预期净删 2.5k–3.5k 行（估算；以实测为准，验收线 ≥40% 历史管理簇行数下降）。

## 6. 部署与回滚协议（每次交付到运行安装，逐步执行）

```bash
DEV=/home/claw/dsh-tavern-dev/tavern-plugin
LIVE=/home/claw/workspace/dsh-tarvern/apps/dsh-tavern/tavern-plugin

# 1. 语法检查：对每个待部署文件
node --check $DEV/lib/domain/<file>.js

# 2. 冒烟导入（在 DEV 内，模块不得 import 宿主包）
cd $DEV && node --input-type=module -e "await import('./lib/domain/conversation-algebra/index.js')"

# 3. 跑离线测试
node --test $DEV/tests/algebra/

# 4. 备份运行目录（每次部署必做）
cp -a $LIVE/lib /tmp/live-lib-backup-$(date +%Y%m%d-%H%M%S)

# 5. 白名单复制：只复制本次改动的文件（禁 rsync 整目录覆盖）

# 6. 重启 DSH（由用户执行或按其惯例），然后验证：
#    - 进程存在；最新日志无 plugin load error / syntax error
#    - 开关默认关 ⇒ 打开一个既有对话确认行为不变

# 7. 回滚（任何一步失败）：
rm -rf $LIVE/lib && cp -a /tmp/live-lib-backup-<时间戳> $LIVE/lib && 重启 DSH
```

注意：回滚只涉及代码文件；本设计的所有操作经宿主 API 写事件，**不存在需要回滚的数据迁移**（分支注册表/去镜像均懒回填、可重算）。

## 7. 明确不做

- 不改宿主；不改事件文件格式；不做会话文件手术。
- 不实现中段变体切换（D4 已关）；不做销毁性回退（D5 已定 fork 制）。
- 阶段 2 之前不动 MVU 结算通路。

## 8. 进度回写

每完成一个阶段：在 fork repo 提交（身份 `OpenClaw <openclaw@local>`，沿用现有惯例），并更新本文件与规格的"状态"行。给用户的汇报必须区分：静态验证通过 / 离线测试通过 / 运行安装实测通过——不许混用。
