# 前台压缩：保留最近 N 轮原文与分卷摘要

- 日期：2026-10-30（分支 upgrade/dsh-0.2.1，DSH 0.2.1-rc.2）
- 关联：`docs/upstream-port/PLAN.md`（批 4）、`conversation-algebra.md`、`conversation-algebra-locate-audit.md`、ADR-0009、`CONTEXT.md`（Floor Projection / Tavern Compaction）
- 上游参照：87b94a5b、377f70cf、68dff3dd、78bc2c96（保留 N 轮）；0eb28243、0b8206e8、d54395d9、e8145dd0、57104435（分卷、八段提示词）；7b5c2d28（合并请求钩子）

## 1. 问题

上游把"保留最近 N 轮"做成**请求侧改写**：摘要请求只让总结模型看到更早的历史，被保留的 N 轮以**文本块并入检查点**（摘要之后）。保留的楼层不再是真实节点。

我们的 `select` 只能引用真实节点。被并进检查点的楼层不能回退、重新生成、切换变体（`locateRollbackSurface` 遇检查点返回 null）。默认保留 10 轮意味着：压缩之后最近 10 轮反而不能回退，而现状（只保留最后一个节点）压缩后下一轮发出去就能回退。这是对现状的可用性退化，不能作为默认行为。

## 2. 对宿主 0.2.1 的调研（结论：能只压前缀）

读了 `dsh-compaction`、`dsh-compaction-basic`、`dsh-session`（surface 折叠与替换校验）、`dsh-session-format-v3-to-v4`（压缩事件校验）、`dsh-token-meter` 的相关部分，以及我们现有的 `auto-compaction.js`、`index.js` 压缩钩子。

1. **压缩事件替换的是一个位置区间。** 一次压缩写五条记录：`compaction/start` → `compaction/summary`（`shadowedRange {start,end}`、`shadowedSeqs`）→ 带 `surfaceOp: {op:'replace', startSeq, endSeq}` 的检查点 `user/message`（来源 `{kind:'compact-checkpoint', compactionId}`）→ `compaction/end`。`shadowedSeqs` 必须恰好等于当时 surface 上 `[start..end]` 的切片（`dsh-session-format-v3-to-v4` 的 `span()` 校验），`start`/`end` 都得是当前 surface 节点，且两端都在工具配对平衡的边界上（`validateSurfaceRegion`）。
2. **区间终点可以任意定在平衡边界。** `selectCompactableRange(session, measurement, retainTokens)` 从尾部累计 token 直到 `>= retainTokens`，得到 `keepFromIdx`，区间是 `[首个非 system 节点, surface[keepFromIdx-1]]`。自动压力压缩用 `retainRatio`（默认 0.16 个消息预算）作为 `retainTokens`，所以宿主**本来就把近尾部留作真实节点**；手动（空闲）压缩 `compactNow` 把它写死为 0，只留最后一个节点（再向前补到平衡边界）。
3. **摘要之后紧跟的保留节点保持原样。** replace 只改区间内的节点，之后的节点原位不动；`deriveMessages` 对它们照常投影。（离线测试里用真实引擎核对。）
4. **事件和接口。** `compaction/summary`、`compaction/prune` 是 token meter 的折叠输入，区间终点不影响其折叠；`contextPressure` / `contextBreakdown` 的 select/replace 适配（`tavern-context-projections.js`）按节点价格精确扣减，区间终点前移不改变这一点。
5. **入口分两类，只有一类能改终点：**
   - 回合内（`agent/pre-step` 压力压缩、请求超窗口恢复）：`compactIfNeeded` → `this.compactRegion(start, end, agent, signal)`。`compactRegion` 是公开方法，我们已在实例上包过它（`installCompactionPolicy` 的 `beforeRegion`），可以在这里**改写 `end`**。
   - 空闲（手动按钮、轮数/比例策略在回合后触发）：`compactNow` 内部自己选区间并调用模块私有的 `compactSurfaceRegion`，**没有可注入的参数**；`compactRegion` 要求已有打开的回合（`inspectCompactionEntryState().openTurn`），空闲时不能用。

结论：**设计 A 可行**——压缩区间只覆盖更早的部分，最近 N 轮仍是真实节点。回合内路径只需改写 `end`；空闲路径宿主没有开口，我们自己执行同一笔事务（见 §4.2）。

## 3. 选择：A（保留节点为真实节点）

B（上游的"文本并入检查点"）会让最近 N 轮不可回退，除非另造一套"从检查点还原节点"的机制；A 不需要。取舍：

| | A（采用） | B（上游） |
| --- | --- | --- |
| 最近 N 轮回退/重新生成/切换变体 | 照常 | 不可用 |
| 新增宿主依赖 | 空闲路径复制 `compactSurfaceRegion` 的事务（约 120 行） | 无 |
| 缓存前缀 | 保留节点字节不变；摘要请求是前台请求的前缀 | 需要专门设计才能保持 |
| 保留轮数累计 | 天然：最近 N 轮永远是 surface 末尾 N 个楼层 | 要把文本块拆回轮次 |

## 4. 设计

### 4.1 保留规划（纯函数 `compaction-retention.js`）

输入：Session 日志、surface 节点、节点价格（token meter 的 `measure().nodes[].tokens`）、保留轮数 N、窗口预算、`balancedBefore(seq)`。

1. 楼层 = 楼层投影 `liveFloors`（玩家输入行起头，按 surface 顺序）。**保留起点 = 倒数第 k 个楼层的输入行**，k = min(N, 楼层数)。
2. 受窗口预算约束：保留部分（起点到末尾）的节点价格之和超过 `窗口 × 25%`（上游 377f70cf 同一比例）时，k 逐个减小；窗口未知则不额外保留（回退到宿主自己的尾部）。
3. 起点必须落在工具配对平衡处，否则继续向前挪到更早的楼层。
4. 区间 = `[首个非 system 节点, 起点前一个节点]`。区间里只剩检查点（没有任何更早的原文）时视为**无需压缩**。
5. 产出 `through`：区间内最后一个完整折叠的楼层号，供分卷标题使用。
6. 两种语气：**强制**（回合内压力/超窗口恢复）至少留一个楼层给总结，保证能腾出空间；**空闲**（手动/策略）全部楼层都在保留范围内时返回"无需压缩"，不白跑一次总结。

### 4.2 接入宿主

- **回合内**：`installCompactionPolicy` 新增选项 `retention`，包住 `compactRegion`：用规划结果改写 `end`（只往前挪，宿主自己的尾部更长则不动）。规划落空、供应商已确认超窗口（`context-overflow` 触发）、或同一次 `compactIfNeeded` 的第二轮尝试，一律回退到宿主原区间——**保证有进展**，不因保留拒绝腾空间。
- **空闲**：包住 `compactNow`。保留为 0、非前台故事会话、或规划落空时调用宿主原方法；否则走自己的 `compactIdleRegion`，在 `agent.runMaintenance` 里复刻宿主事务：校验区间与空闲状态 → `compaction/start` → 调 `engine.summarize`（宿主的唯一定制点，所以摘要请求仍经我们的 `llm/stream` 钩子）→ 摘要更小的校验 → `compaction/summary` + 检查点 replace + `compaction/end` → flush。失败路径同样补一条带 `error` 的 `compaction/end`。测试把事件形状与宿主 `compactNow` 的产出逐字段对照。
- 手动入口 `deps.compact` 先 `configureAgentCompaction(agent)`，使包装对没有跑过回合的引擎（重启后直接压缩）同样生效。
- **后台会话不变**：包装只作用于有故事对话的前台会话，`background-compaction.js` 与 d841f774 的后台沿用逻辑不动。

### 4.3 被压缩楼层的投影与界面

- 楼层投影给每个楼层加 `compacted`：输入行不在 surface 上，且 surface 上有压缩检查点。
- 视图字段：最新楼层已被压缩时，`canRollback`/`canRegenerate`/`canEditBody` 均为 false，`variantSwitch.available` 为 false，原因统一为"该楼层已被压缩，无法回退、重新生成或切换变体；发送新消息继续（历史正文仍保留）"。客户端沿用现有的禁用/原因展示（回退菜单项位置显示原因，重新生成/编辑正文/变体切换不渲染）。
- 回退只作用于最新楼层，所以"哪些楼层被压缩"只影响连续回退时何时停下：回退到保留起点后，再往前就是"已被压缩"。

### 4.4 压缩前保存的变体

变体（保存的分支）= 分支头之前日志的折叠。压缩之前存下的分支折叠出的是**压缩前的完整历史**，直接切过去会把已压缩的历史"复活"、撤销压缩。这在现状下就存在（只是窗口很小）；保留 N 轮后更容易遇到。

处理：`checkout` 切到保存的分支时，若当前 surface 上有分支头之后才写入的压缩检查点，则**以当前 surface 为底重定基**：取目标节点中最后一个仍在当前 surface 的节点 a（该楼层的输入行），结果 = `当前 surface[..a] + 目标节点[a 之后]`。找不到 a（楼层输入已被压缩）则拒绝，并在界面上视为不可切换。

### 4.5 摘要：分卷、八段提示词、钩子合并

- 默认提示词换成上游八段结构化摘要的最终版（d54395d9 → e8145dd0 → 57104435）。这是默认文件 `prompts/story-compaction.md`；用户在设置页覆盖过的提示词不动，"本次摘要的写法"（分卷指令）追加在用户提示词之后，对自定义提示同样生效。
- 分卷（0eb28243、0b8206e8）：新摘要只总结旧卷之后的新剧情，写成新的一卷；旧卷原样并入检查点，作为各自独立的文本块放在新卷之前（宿主引擎保留摘要的每个文本块）。旧卷合计超过窗口 15% 时，只把最老的几卷单独合并成"前情总览"（约一半长度），较新的卷原样保留。卷标题带轮次范围，由规划产出的 `through` 提供。
- 7b5c2d28：投影、剧情提示词、分卷前缀、文本回退合并成 `installCompactionRequestProjection(ctx, ownsSession, prepare)` 一个钩子，只有最终的总结调用重入 `llm/stream`。移除 `index.js` 里单独的 story-compaction 钩子。
- 上游的 `STORY_SUMMARY_NOTE` 提到 `tavern_recall_history` 工具，我们没有这个工具，措辞改为不依赖工具。

### 4.6 设置

`contextCompaction.retainRounds`：0–100 整数，默认 10，0 表示不保留（宿主原行为）。写进 `compactionPolicy`、设置页"上下文压缩"区。改它会改变 `policyKey`，自动压缩的基线按已有逻辑重置。

## 5. 不做 / 推迟

- **8d303f2b（预设前段改原生系统提示段落、压缩复用前缀缓存）**：不移植。A 下被保留的节点本来就不变，摘要请求仍是前台请求的前缀，唯一达不到的是"预设内容在投影后才加进请求，压缩请求里没有"。那是预设重构的收益，与保留轮次无关，体量大。报告里单列。
- 保留轮次的"文本拆回逐轮累计"（377f70cf 的一部分）：真实节点天然累计，不需要。
- `plugin-api` 的 `compactionSection`（ddbde249）：不取。
- 提供商确认超窗口时的恢复压缩不保留额外轮次（与上游一致）：此时最近一轮会被压进检查点，之后下一轮发出前不可回退，属于容量保护的代价。

## 6. 验证计划

- 单元：规划（0/1/10/超预算/强制/空闲/全保留）、空闲事务与宿主 `compactNow` 的事件形状对照、真实引擎回合内改写 `end`、多次压缩累计与分卷、变体重定基。
- 算法套件（`tests/algebra/`，不带预加载单独跑）：压缩 + select 的组合——压缩后回退最近一轮、重新生成、切换变体（含压缩前存下的变体）、撤销回退、连续回退到保留边界后的拒绝与投影标记。
- 占用读数：保留 N 轮压缩后 `contextPressure` / `contextBreakdown` 与直接估算一致，回退后仍一致。
- 真实 e2e：压缩后最近一轮回退、重新生成、切换变体；保留 N 轮的请求内容；既有 `--compaction=manual|overflow|rounds`。
