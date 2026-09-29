# 会话操作代数（Conversation Algebra）需求规格

- 版本：v0.2（阶段 0 验收稿）
- 日期：2026-09-29
- 状态：**阶段 0 已完成；D2 已由运行安装实验判定回落 (a)，尚未进入阶段 1**
- 评审人：仓库所有者
- 关联：`docs/adr/0003`、`0004`、`0005`、`0006`（见 §10）；`DEVELOPMENT-CONTEXT.md`；`CONTEXT.md` 术语

---

## 0. 一页摘要

现状：会话历史管理摊在 32 个领域模块、约 5,793 行上（domain/ 共 247 文件 33,853 行）；surface 手术散布 10 个文件的 16 个调用点；同一组不变量（工具配对、事件形状、不动正文）在 ≥6 处各自手写。本 fork 近期全部高危 bug 均可归因为违反下文某条规则。

本设计把"游玩过程中对会话历史的所有操作"收敛为：

1. **单一事实源**：append-only 事件日志；消息内容不再存第二份（chat 存档去内容镜像）。
2. **状态是算出来的**：唯一的 fold（重放函数）从事件得到"当前会话"；对话页/轨迹页/完整上下文/MVU 都是它之上的过滤与装饰，结构上不可能失步。
3. **四个原语 + 一个适配器**：`appendStep` / `editStep` / `branch+checkout` / `dropTagged`，以及循环层 `generate()`。每个原语带局部守卫，单独执行天然安全；不安全只可能来自组合或顺序，由事务层负责。**游玩动作不含任何销毁性操作**（D5）：回退=fork，旧线留为分支；手动清理是唯一销毁路径。
4. **派生状态响应式**：MVU 结算、压缩摘要是对 fold 的纯函数 + 前缀哈希键缓存；缓存损坏自愈，回放零模型费用。

reroll = `checkout(锚点)+generate()`；回退 = `checkout`；变体切换（swipes）= 兄弟分支枚举 + `checkout`；编辑 = `editStep`。四个产品功能共用一组原语，预计历史管理簇可净删 2.5k–3.5k 行（估算，以阶段验收实测为准）。

---

## 1. 背景与动机

### 1.1 现状体量（2026-09-29 实测）

| 指标 | 数值 |
| --- | --- |
| `tavern-plugin/lib/domain/` 模块数 / 总行数 | 247 / 33,853 |
| 会话历史管理簇（32 个模块）行数 | 5,793 |
| `replaceSessionSurface` 调用点 | 16 处，分布于 10 个文件 |
| 不变量副本数（工具配对/形状/不动正文） | ≥6：frame-retirement、rollback 区间校验、regen 预检、宿主 seed 校验、客户端 repairToolCallOwnership 补丁、请求前 visibleMessages 过滤 |

上游 09-17 已有提交 "centralize session surface replacement validation"，但调用方仍各自手搓语义——**只在写入函数集中校验不够，必须把操作本身收进代数**。

### 1.2 故障账本（本 fork 真实案例 → 违反的规则）

| # | 案例 | 现象 | 归因（违反规则） |
| --- | --- | --- | --- |
| B1 | 工具调用行渲染到轨迹页顶部 | regen 提交按节点替换，turn:step 撞键 | 替换单位不是 step |
| B2 | 回退后输入 109 与帧 110/111 孤儿化 | rollback-surface 区间数学 | 掏了中间，非后缀 |
| B3 | 墓碑 source 非法卡死重新生成 | "seed assistant/message at index 43 message must have model source"（session-8b1d4152 seq43、da216f7f seq174） | 删除被实现为伪造空消息，未过写入守卫 |
| B4 | 开关行每轮重发（seq 57→60） | 退役墓碑丢 `disabledWritingSkills`，去重失效 | 退役即丢状态 |
| B5 | 技能目录每轮重发布 | 宿主 digest 判定 existing 缺失 | 同上（退役不是 fold 层语义） |
| B6 | 空行需请求前过滤 | 墓碑滞留 surface | 同上 |
| B7 | 用户泡泡不更新 | `text`/`sourceText`/`swipes`/`templateInputSource` 四字段失步 | 双写（chat 镜像 vs 会话日志） |
| B8 | 会话文件损坏致 DSH 无法启动 | 整文件单帧 zstd 重压缩 | 运维硬约束，见附录 A |

### 1.3 目标与非目标

**目标**
- G1 用户任意操作（reroll/回退/分叉/编辑/切变体，任意次数、任意交错）不可破坏会话。
- G2 消息内容单事实源；所有视图构造性一致（所见即所成为定理而非纪律）。
- G3 每个原语局部安全；组合安全由事务层显式保证。
- G4 历史管理代码高内聚低耦合：写入只有一扇门，读只依赖 fold。
- G5 大历史（500+ 层）下回退/切变体/回到旧线为 O(1)+缓存命中，零模型费用（重放已记录结果）。

**非目标**
- 不修改宿主（`runtime/lib/node_modules/@deepseek-ai/*` 只读）。
- 不改事件文件格式、宿主 seed 校验、宿主轮次记账。
- 不解决宿主历史分页性能问题（ADR-0003 已记录为上游问题）。

---

## 2. 术语

对齐 `CONTEXT.md` 既有词汇：**Story Timeline**（剧情权威状态）、**Foreground Turn**、**Background Operation**、**checkpoint**（闭合回合边界）、**MVU Delivery**、**Host Adapter**。新增：

| 术语 | 定义 |
| --- | --- |
| **事件日志** | `session.v3.jsonl.zstd`，append-only，每行一 zstd 帧。唯一事实源。 |
| **fold（重放）** | 从事件序列计算"当前会话"的纯函数：append 加行、replace 换行、空内容行不属于任何视图。 |
| **step（步）** | 操作原子单位。用户输入一行 = 一步；assistant 的一个 turn:step 连同其全部 tool_result = 一步。 |
| **锚点（anchor）** | seq 边界地址（不可变）。UI 楼层号经 fold 换算为锚点；楼层内容被编辑不改变后续锚点。 |
| **分支（branch）** | 从某锚点出发的一条后缀线。分支注册表 = 元数据（git refs 之于对象库），不是第二事实源。 |
| **变体（variant）** | 同一锚点下的兄弟分支。产品语义即 SillyTavern swipe。 |
| **原语（primitive）** | §4 定义的最小安全操作。 |
| **视图（view）** | fold 之上的过滤+装饰层。只能"选择不展示"，不能"算出不同答案"。 |

---

## 3. 核心模型

### 3.1 状态 = fold(events)

```
事件日志（唯一事实）
   │ fold（唯一重放函数；增量缓存 + 版本号）
规范消息列表（当前真相：哪些 step 存活、顺序、内容）
   ├── 对话页视图   = 过滤[正文行] → 气泡渲染
   ├── 轨迹页视图   = 全行 + 溯源标注
   ├── 请求装配     = 全行 + 系统框装 + tools 元数据
   └── MVU 结算回放 = 过滤[assistant step] → 变量
```

- fold 结果带单调版本号；每次事务提交 bump 一次，派生层订阅版本号。
- 增量实现：缓存上次折叠结果 + 已处理 seq，仅重放新事件（宿主 surface 同思路）。
- **空内容行（墓碑）不属于任何视图**——这一条进 fold 定义，B6 类过滤从请求装配移入核心。

### 3.2 step 模型

- step 是配对完整的原子：assistant step 含其全部工具调用与结果；任何原语以 step 为单位，配对不可能被拆散（杀 B1）。
- 楼层（UI 概念）= 玩家输入 step + 其 assistant step 序列。

### 3.3 对话树 = Story Timeline 的分支扩展

- 任意时刻的"当前线"= 从根到 active 指针的路径。
- 回退/变体切换/分叉统一为指针移动；**任何操作都不物理销毁事件**（append-only 保证）。
- **D5 已定（2026-09-29）：不存在销毁性回退**。产品只有一种「回到过去」：`branch(自动命名+时间戳) + checkout(锚点)`（即 fork）——被离开的线成为命名分支，与 D3 变体共用同一套手动清理策略；`dropSuffix` 原语移除。手动清理（隐藏/purge，需确认）是**唯一**销毁路径，永不由游玩动作触达。宿主只追加模型从物理上禁止删除事件（无删除 API，文件级手术属附录 A 禁止项）。
- 分支注册表（插件侧持久化元数据）：`{branchId, label, anchorSeq, headSeq, createdAt, active?}`；同锚点兄弟按创建序即变体序。
- 与 Story Timeline checkpoint 的关系：锚点即 checkpoint 的 seq 边界表达；注册表不复制 checkpoint 内容。

---

## 4. 原语集

### 4.1 清单与签名

```ts
appendStep(step: Step): Ref            // 尾部追加完整 step
editStep(ref: Ref, content: Content): void   // 改写单个 step 内容；身份/位置/轮次不变
// （无 dropSuffix：D5 已定，回退统一为 branch+checkout；销毁仅存在于手动分支清理）
dropTagged(tag: Tag, opts): uint       // 掉指定标签行（脚手架专用，见 4.2-G7）
branch(label?): BranchId               // 当前线命名
checkout(ref: AnchorRef | BranchId): void    // 移动 active 指针（可再生成/回旧线）
// 循环层（非日志原语）
generate(opts): Step                   // 读当前 fold → 宿主生成循环 → append 结果
```

产品功能全部为组合（§8）。

### 4.2 守卫谓词（写入时执行，拒绝即抛错，不落任何事件）

| # | 守卫 | 杀死的故障 |
| --- | --- | --- |
| G1 | 事件形状：assistant/message 的 source 必须 `{kind:'model', provider, model}` 非空；turn/step 整数；stream 数组。user/system/tool 形状同宿主 `assertMessageEventShape`（dsh-session/lib/index.js:900/947） | B3 |
| G2 | step 原子性：append/drop 的单位是 step；assistant step 必须携带其全部 tool_result | B1 |
| G3 | `dropTagged` 不得触及含正文文本的行、不得触及被配对引用的行；变体切换仅限活跃头部末楼（D4） | B2 |
| G4 | `editStep` 拒绝：改 role/身份/轮次；编辑含工具调用的 assistant step（需走 reroll） | 手改破坏配对 |
| G5 | 墓碑（drop 的宿主编码）必须沿用被替换行的合法 source（assistant 墓碑从原行复制 model source；来源不完整则拒绝退役） | B3（本次事故修复经验） |
| G6 | 期望头校验（并发，见 §5） | 交错写入 |
| G7 | `dropTagged` 仅允许注册过的脚手架标签（worldbook-snapshot、writing-skill-state、writing-skill-reminder、foreground-frame、skill 装载 step） | 误删正文 |

守卫清单与宿主 seed 校验同源：**写入时拒绝取代加载时验尸**，宿主校验退化为重言式。

### 4.3 编译到宿主事件（适配层，宿主只读）

| 原语 | 宿主编码 |
| --- | --- |
| appendStep | `session.append`（现状） |
| editStep | `replaceSessionSurface` 同范围同身份换内容 |
| dropTagged（及手动清理 purge） | replace 为空内容墓碑（满足 G5）+ fold 空行规则 |
| checkout 回旧线 | 回指式 replace（rollback 现有机制，从日志取旧内容重写） |
| generate | 宿主 agent 循环；轮次记账差异由合成轮映射吸收（见 §12 残留） |

---

## 5. 事务协议

所有写入走同一流水线（唯一写入门）：

```
① stage    组合原语序列 + expectedHead（期望头 seq）
② guard    逐原语跑 §4.2 守卫
③ commit   事件批量追加；同一 operationId；source 元数据带 begin/commit 标记
④ bump     fold 版本 +1，广播
⑤ converge 派生层（MVU/摘要/面板）检测版本变化，异步收敛
```

- **乐观并发**：②时实际头 ≠ expectedHead → 拒绝并重试，绝不静默合并。
- **在途租约**：`generate()` 与后台结算持头租约；冲突时显式取消生成；结算结果事件带 `{branch, revision}` 戳（沿用 ADR-0006 既有规则：不匹配即 stale 丢弃，不覆盖当前派生状态）。
- **崩溃恢复**：fold 遇"有 begin 无 commit"的尾部视为未提交事务，忽略（WAL 语义）。物理日志允许存在未提交尾部；插件提交可见性不等于宿主文件的多事件原子提交。
- **多端/多标签页**：事务级 last-writer-wins + 冲突拒绝，无静默合并。

### 5.1 宿主逐事件写入下的恢复协议（2026-09-29 用户批准）

1. 以会话为单位串行提交，提交前重新核验 `expectedHead`。所有计划写入必须先通过 detached 宿主 Session 的完整预检；守卫或宿主拒绝不得产生实际写入。
2. 第一次写入持久化完整、可重放的事务意图和目标引用；全部写入与分支元数据属于同一 `operationId` 和提交标识。编码须先证明可以合法保存在现有事件 source 中，不能增加宿主不认识的必需事件类型。
3. 运行期间失败或启动恢复期间，目标会话不开放生成、不发布新视图；通过宿主 Session API 幂等补完或追加恢复事件，核对宿主 surface 与提交 fold 一致后才开放。恢复失败显式报告并继续隔离该会话。
4. 持久化 flush 失败、各写入截断点、进程重启、重复恢复以及并发冲突必须分别验证。禁止直接写会话文件，禁止把内存假日志的原子性当作宿主能力。

---

## 6. 派生层

### 6.1 MVU 结算

- 结算结果是逐层记录在案的事实（现行 chat 存档 `messages[i].mvu/variables` 与后台结算事件）。
- `状态@锚点 = fold(≤锚点的已记录增量)`——**重放记录，不重新调模型**；回退/切变体零费用。
- 检查点 = fold 的物化缓存，键 = 前缀内容哈希 + 结算 schema 版本；校验失败即重算（自愈，代价是时间不是模型费）。
- **D1 已定（2026-09-29）：变体级**——不同正文产生不同状态变化，切换变体时状态栏随之联动（读已记录结算，零模型费）。

### 6.2 上下文压缩摘要

**适用法则：摘要可用 ⇔ 其覆盖范围恰为当前分支的一个前缀（内容哈希匹配）。**

- 摘要事件记 `{覆盖到第 k 锚点, 该前缀哈希}`；装配期取"可用的最长摘要 + 其后 raw"。
- 回退到摘要覆盖范围之内（如 58 < 60）→ 摘要不可用，1–57 全 raw（含已抹去未来剧情的摘要绝不能回流——结构性防污染）。
- 回退到覆盖范围之外（如 90' > 85'）→ 摘要仍可用。
- 滚动复用：新压缩可消费任何可用旧摘要 + raw 增量。
- 与宿主/后台压缩的关系遵循 ADR-0003（前后台摘要契约分离；后台压缩后回退走权威状态重建）。

### 6.3 展示投影

状态面板、iframe 采集、正则显示等一律为 fold 之上的投影；显示态不落事实源。

---

## 7. 视图层规则

- 视图 = 过滤 + 装饰，共享同一 fold；**两视图若展示同一事实，答案必须相同**。
- 合法差异示例：对话页隐藏脚手架行、完整上下文显示。
- 非法差异（=bug）：泡泡 vs 轨迹文本不一致；工具行顺序与请求不一致。
- 现行客户端 `repairToolCallOwnership` 补丁在 G2 生效后删除。

---

## 8. 功能映射表（现有功能 → 原语组合 → 删除物）

| 功能 | 组合 | 删除/收缩 |
| --- | --- | --- |
| 播放一轮 | `appendStep(user) + appendStep(帧) + generate()` | 帧行特判 |
| reroll | `checkout(锚点) + generate()`（旧正文成兄弟变体） | 合成轮编排的回退/提交双写、`regeneration-recovery` 大半 |
| 改输入重掷 | `editStep(user) + checkout(锚点) + generate()` | `editedInput` 标志、`normalizeEditedInput`、`planUserInputSurface`、四字段同步 |
| 泡泡编辑 | `editStep(user)` | （新增能力，消灭 reroll 编辑特判） |
| 回退（回到某层重玩） | `branch(自动命名) + checkout(锚点)`；回旧线 = `checkout(分支)` | rollback-surface + story-timeline 约一半 |
| 分叉 | `branch + checkout` | 收缩为元数据 |
| 正文编辑 | `editStep(assistant)` + G4 守卫 | 基本持平 |
| 脚手架注入/退役 | `appendStep(帧)` + `dropTagged(上轮帧)` | 墓碑伪造、source 合法性特判、去重字段保留、LATEST_ONLY/CONTEXT_SYSTEM_FORMS 簿记（角色重写移入视图层） |
| 技能装载按轮退役 | step 粒度天然携带 | `RETIRABLE/isPureToolCallRow/callNamesOf` |
| 变体切换（swipes） | 兄弟枚举 + `checkout` | **`swipes[]`、`swipeId`、四字段同步、`replaceLastRound`**（B7 类不可表示） |
| 开场种子 | `appendStep ×3` | 形状守卫并入 G1 |
| 历史召回 | `appendStep(tool step)`；冷却=tag 策略 | — |
| 压缩 | 请求装配层（§6.2） | 陈旧摘要污染类 |
| 候选采纳 | 候选落后台会话，采纳= `checkout` | splice+字段同步 |
| 导入/救援 | 单一来源落地后缩为一次性回填 | chat-history-rescue/import 大半 |

---

## 9. UI 需求

1. **泡泡编辑**：任意用户消息泡泡进入编辑态，保存即 `editStep`（走事务）。
2. **变体切换**：**仅最后一条 assistant 消息**（D4）显示 `‹ n/m ›`（复用现有翻页控件样式）；翻到末位再右 = 生成新变体（与"重新生成"合并为同一操作）。当前选中项持久化于分支注册表。中间楼层不提供箭头；需先回退（fork）到该楼再切换/重生成。
3. **分支清理**：分支列表统一管理变体与被回退线（自动命名+时间戳）；手动清理（隐藏/purge，需确认）是**唯一**销毁路径，与 D3 同一策略。
4. **分支列表**：按锚点分组展示；支持 checkout、命名、清理（策略 D3）。
5. **回退选择器**：楼层 → 锚点换算；回退后 raw 跨度过大时提示可压缩（是否自动 = D5）。

---

## 10. 与既有 ADR 的关系

| ADR | 关系 |
| --- | --- |
| 0003 后台单 Session + surface 回退 | 兼容；后台压缩/回退行为不变，前台摘要适用法则（§6.2）为其前台对偶 |
| 0004 原子轮 | 语义保留于事务边界；0006 已放宽的"前台先行"继续有效 |
| 0005 取消 Swipe | **被本设计取代，需新 ADR**。0005 拒绝 swipes 的理由（Chat 选择/Surface/后台结算三分叉）在单事实源+分支模型下不复存在：变体=分支，无平行数组；结算绑定 branch/revision（0006 规则）stale 即弃。产品能力回归且不引入当年风险 |
| 0006 前台先于结算提交 | 完全兼容；事务层 `{branch, revision}` 戳即其推广 |
| 0007 运行时固定 | 不涉及 |

---

## 11. 安全保证栈（每层只防一类病）

| 层 | 保证 | 杀死 |
| --- | --- | --- |
| 守卫 | 非法原语写入前被拒 | B1/B3 |
| 日志 | 只增不改 | 数据丢失/无法回到过去 |
| 单一 fold | 读者构造性一致 | B7、视图漂移 |
| 派生收敛 | 缓存前缀键校验，坏则自愈 | 结算漂移、陈旧摘要 |
| 事务 | 顺序/并发冲突显式拒绝 | 交错写入、半提交 |

---

## 12. 模块分层与依赖规则

```
log/       事件追加、读取、分支指针（不懂消息语义）
algebra/   原语+守卫（唯一写入门；不懂 UI/MVU/压缩）
fold/      唯一重放 + step 视图（含旧编码兼容读）
derive/    MVU 回放、摘要缓存、展示投影（只依赖 fold）
assembly/  请求装配（fold + 框装 + tools）
loop/      generate() 宿主适配（轮次记账、合成轮映射）
ui/        页面（只依赖 fold + 过滤器）
```

依赖单向向下；禁同层横向、禁向上。MVU 模块不知道"回退"功能存在，只看版本号。

**宿主只读下的落地现实**：algebra 编译为宿主事件（§4.3），机制即现行 rollback 所用，区别是从六处手搓收编为一处带守卫实现；分支注册表为插件元数据；`generate()` 内合成轮映射保留（循环层残留，收在一个模块）。

---

## 13. 迁移计划

- **阶段 0（本文档）**：评审定稿；性质测试骨架（algebra 纯函数 + 内存假日志）；脚手架注入实验：
  - **B-1 通路**：枚举宿主请求对象（`assembleSystemPrompt` 收到的 `assembly`）的可变面——sections/contexts/tools 之外是否支持尾部瞬态注入；用一次性测试对话验证注入型脚手架（世界书快照/技能目录/提醒）不写会话行即可进请求，且位置可控。
  - **B-2 审计等价**：`fold(steps) + 注入记录 == model-request-log 中的实际请求`（含编辑/reroll 轮次，逐字节）。
  - **B-3 缓存代价**：头部注入对 provider 前缀缓存命中率的实测影响（对照现行行式追加）；若仅尾部瞬态可用则此项自然通过。
  - 判定：B-1+B-2 通过且 B-3 可接受 → 注入型走 (b)；否则回落 (a)。全程使用一次性测试会话，特性开关隔离，不触真实用户会话。
  - **2026-09-29 实验结论**：B-1 不通过，D2 回落 (a)。宿主公开的 `PromptAssembly` 可变面只有 `sections / contexts / tools / variables`，没有消息尾部瞬态注入口。`contexts` 在原生路径会被宿主投影为 `user/message` 并写入 Session，违反“不写会话行”；在 SillyTavern compatibility 路径则被 `prepareStep` 的消息替换丢弃，无法进入模型请求。一次性测试会话 `session-01cd86eb-f6ee-4c5d-9750-1693b5befa21` 两轮均未出现探针，与代码级回归测试一致。判定条件已在 B-1 短路，B-2/B-3 不再执行，也不据此声称缓存结论。阶段 1 的文本型脚手架使用消息行 + `dropTagged`；工具调用型脚手架继续整 step 退役。
- **阶段 1**：algebra 上线为唯一写入门，现有功能改编译为组合；chat 存档停止存消息内容（读 fold）；泡泡编辑上线。特性开关可回退。
- **阶段 2**：删除 `swipes[]/swipeId/replaceLastRound`；变体=分支；MVU 回放+检查点收编。
- **旧会话**：fold 兼容读 replace-op/墓碑编码；懒迁移（首开换算，不重写文件）。

---

## 14. 测试策略

1. **性质测试**：随机原语序列（守卫通过）⇒ fold 恒满足：形状合法（G1）、配对完整（G2）、顺序合法、三视图一致。
2. **黄金回放**：以现存真实会话（含 B1–B7 案例数据）验证 fold 等价于宿主 surface。
3. **故障注入**：commit 中途截断 → 未提交尾被忽略；并发冲突 → 拒绝；缓存投毒 → 前缀哈希不匹配重算。
4. **费用断言**：回退/切变体/回旧线的模型调用数 = 0。
5. 现有 9 套离线测试并入对应层。

---

## 15. 时序图（两用例）

**用例 A：500 层，第 60 层压缩过，rewind 到 58，玩到 100' 再压缩**

```
原线 1──57─58─59─[摘要S1:覆盖1~59]─61───500
                ↓ checkout(锚点57末) + branch('主线')
新线 1──57─58'──100'
   · S1 键=hash(1~59) ≠ hash(新线1~59) → 不可用（含被抹去的58/59剧情）
   · 新线 1~57 全 raw 进上下文
   · 玩到 100' 压缩 → S2{覆盖1~85', hash} 落新线分支（一次压缩模型调用，全程唯一付费点）
   · checkout('主线') 回 500 层：S1 及其后续缓存原地命中，O(1)，零模型费
```

（D5 已定：回退=fork（非销毁），本例的「后悔了 checkout 回主线」天然成立；手动清理分支是唯一销毁路径。）

**用例 B：某楼 reroll 多次后左右切换**

```
            ┌─ 变体A
第57层末─锚点┼─ 变体B
            └─ 变体C ←active（‹ 3/3 ›）
   · 右箭头到末位再右 = checkout(锚点)+generate() 生成变体D
   · 左右切换 = checkout(兄弟) ；正文/MVU/后续请求/三视图随 fold 版本联动
   · 结算读已记录结果（或按 D1 楼层级策略），切换零模型费
   · 切换撞上生成中 → 期望头冲突，显式取消
```

---

## 16. 开放决策点（需拍板）

| # | 决策 | 结论 / 建议 |
| --- | --- | --- |
| D1 | MVU 结算归属：变体级 / 楼层级 | ✅ **已定：变体级** |
| D2 | 脚手架如何从上下文消失：(a) 消息行+dropTagged 退役；(b) 不进消息流，仅装配时注入 | ✅ **已定：回落 (a)，消息行 + `dropTagged` 退役**。阶段 0 的 B-1 运行安装实验不通过：原生路径的 `contexts` 会落 Session 行，compatibility 路径会丢弃该 context；宿主没有满足要求的尾部瞬态注入口。B-2/B-3 因 B-1 短路不执行。工具调用型脚手架按完整 step 保留消息行并整步退役。 |
| D3 | 变体保留策略（上限/收藏/手动清理） | ✅ **已定：默认全留 + 手动清理，永不自动删 active** |
| D4 | 左右箭头位置 | ✅ **已定：仅最后一条 assistant 消息**（与 ST 一致）；中间楼层需先回退（fork） |
| D5 | rewind 语义 | ✅ **已定：无销毁性回退**。回退=branch(自动命名)+checkout(锚点)，旧线留为分支；`dropSuffix` 原语移除；手动分支清理（隐藏/purge，需确认）是唯一销毁路径 |
| D5b | rewind 后 raw 跨度过大 | 按建议执行：提示制（提示可手动压缩，不自动） |
| D6 | 取代 ADR-0005 的新 ADR | ✅ **已定：随阶段 1 提交**，正式取代 0005，理由见 §10 |

---

## 17. 验收标准

1. 性质测试（§14.1）在 10⁵ 随机序列下零违规。
2. 泡泡编辑、变体切换、回退、回旧线的模型调用数 = 0。
3. 变体切换与 checkout 为 O(1) + 缓存命中（含 MVU 检查点）。
4. 旧会话（含墓碑/replace 编码）fold 结果 ≡ 宿主 surface 投影。
5. §1.2 故障账本逐条给出"新架构下不可表示"的论证并经测试佐证。
6. 阶段 2 完成后历史管理簇行数下降 ≥40%（基线 5,793 行；估算可删 2.5k–3.5k，以实测为准）。

---

## 附录 A：运维硬约束（事故教训，永久生效）

1. 会话日志 zstd 必须**逐行成帧**（首帧=单独 header 行，每事件一行一帧，帧开 checksum）。禁止整文件单帧重压缩——2026-09-28 事故曾致 DSH 无法启动。
2. 任何对宿主管辖二进制文件的修复，先读宿主写出路径，再动手。
3. 插件 lib 改动需重启 DSH；`lib/client.js` 为构建产物，客户端改动走 `src/client/`。
4. 宿主包（`runtime/lib/node_modules/@deepseek-ai/*`）只读。
