# 上游「核心对话机制」与我们新设计的对照（core-conversation）

状态：完整版。只读分析，未改任何仓库文件。
基点 MB=e990cbc9；上游=upstream/main（DSH 0.2.1）；我们=HEAD（DSH 0.1.5-rc.2 + surface-select 补丁）。

## 1. 一段话结论

上游这一族机制（原生锚点、对账器、存档优先修复）解决的是一个真问题：「剧情存档（Chat）」和「模型上下文（原生会话）」是两份记录，任何一次对不上，回退/重新生成/编辑正文就被拒绝，存档报废。上游的办法是**把 Chat 定为唯一权威，原生会话是可随时重写的影子**，靠 `suppressedDshTurns`、`regeneratedDshTurns`、`nativeCommits` 这些逐回合表和 `replace` 写入来补。我们的新设计走的是相反的路：**会话日志是唯一事实源，回退/切变体/重新生成都是一个 `select` 事件，楼层由 floor-projection 推出**，那批逐回合表已全部删除。因此：
- 上游的**对账器（story-alignment）和修复原语（native-surface-repair）的实现**建立在已被我们删掉的表之上，**不能原样取**；它们的**不变式**（“定位不到不能拒绝，要修复”）对我们仍有价值，因为我们的代码里仍保留着同类拒绝（round-history.js:85、:543，body-editor.js:79，rollback-surface 的“已不在可回退的消息流中”）。可以**改写**成「保留最长一致前缀 → 追加缺失尾部 → 一个 select」，工作量中等，且比上游更简单（不再需要 replace 与影子占位）。
- 上游**原生锚点（round-anchor）**的思路（用不可变 seq 记楼层，顺着替换关系找当前位置）与我们 floor-projection 的 originInput/originBody 是同一思路，**两者能共存**；但不要双份维护。我们取其中「锚点记在 Chat 楼层上」这一点即可，不需要整个模块。
- 上游**分页存档（native-conversation-storage / conversation-page-store）是 Chat 侧存储格式**，与会话日志/select 不在同一层，**基本无冲突**，但它写死了消息字段白名单与 swipes 语义，必须适配我们的 `variantStates`，且体量大（约 1300 行 + 配套整理）。**用户已说旧会话不迁移**，所以迁移那一提交（cce1e238）可整块不要。
- **压缩分卷/保留最近 N 轮、正文走工具调用、历史正文以工具参数回放**是请求层/提示层功能，只读 surface，不写 surface，与 select 不冲突，**最值得取**，需要适配的是 DSH 0.1.5 与 0.2.1 的消息来源字段差异。
- 一旦取了上游的 rollback-surface / round-history / body-editor / story-timeline 的上游版本（而不是挑功能改写），就会把 replaceSessionSurface、逐回合表、影子占位全部带回来。**这些文件不能按上游整文件合并，只能按功能手工移植。**
- 谁该让步：「存档优先、Chat 为唯一权威」这条原则上游应让步（我们的 ADR-0008/0009 已定日志为权威）；但「操作不得因定位失败而拒绝」这一产品承诺我们应向上游看齐。

## 2. 逐项能力表

格式：能力｜用户感到什么｜上游实现｜关系｜建议｜工作量｜依赖

| # | 能力 | 用户感到 | 上游实现（关键） | 与新设计关系 | 建议 / 量 / 依赖 |
|---|---|---|---|---|---|
| A1 | 分页存档（当前状态 + 不可变历史页） | 万轮长档打开、继续一轮不再等一两分钟 | conversation-page-store.js(997534a5)、native-conversation-storage.js(c9c4292d)、conversation-state.js | 【需适配】Chat 层存储，不碰会话日志；但字段白名单(268行)只认 swipes/swipeId，不认我们的 `variantStates`；与 chat-persistence、MVU 结算读写深度耦合；index.js 接线两边都改过 | 改写后取。大。依赖 A2；先要决定是否做长档性能 |
| A2 | 旧档迁移到分页存档 | 无 | cce1e238 | 【无关】用户决定旧会话不迁移 | 不取 |
| A3 | 存档块包（格式 2） | 磁盘文件数 7000→1250，目录不卡 | b609a1c6，改 conversation-page-store.js | 【无冲突】随 A1 | 随 A1 取。小 |
| A4 | 空闲自动整理（删旧版本、请求日志只留 3 轮等） | 存档体积 1.1GB→739MB | 023ce505、14abd223：save-maintenance.js、conversation-retention.js、model-request-log.js | 【需适配】保留策略写死“回退检查点链/撤销回退/重新生成恢复点”，对应我们已不同的 rollbackUndo/分支；不能把我们的分支所需版本删了 | 改写后取，且晚于 A1。中 |
| A5 | 分叉历史只留最近 50 轮 | 更早楼层没有“分叉”按钮 | 1b320639：conversation-retention、conversation-fork-targets | 【需适配/有产品代价】属 Chat 修订版本保留；我们的分叉是 branch+checkout，无需历史修订，但“会话分叉”(开新会话)仍读 Chat 修订 | 待用户拍板（见 3） |
| B1 | 每轮原生锚点 round-anchor | 回退/模板同步不再按顺序或文字猜错 | round-anchor.js(a568213e)；Chat 楼层存 nativeAnchor{turn,input,reply} | 【可共存】floor-projection 用 originInput/originBody 沿 replace 的 sourceEventSeqs 溯源，同一思路；select 后节点就是原事件，溯源更简单。上游代码依赖 session-upgrade-references(0.2.1 升级映射，formatVersion 4) | 不整模块取；若要“楼层→seq”快速定位，改写成最小版放进 floor-projection。小 |
| B2 | 「哪条是本轮输入」只在一处定义 | 模板改写不再被当成新输入(#196) | session-turn-input.js(f6d899f3) | 【需适配】依赖 source 形状(plugin 的 dsh-tavern-regen/replay producer)，0.1.5 与 0.2.1 的 source 不同 | 改写后取；可抽查我们是否已有同类缺陷。小 |
| B3 | 存档与模型上下文对账器 | 打开对话/回退前自动补记漏写轮、重新隐藏没落地的回退 | story-alignment.js、uncommitted-rounds.js(17db75c4、003d8570)；index.js reconcileStory | 【冲突(实现)】直接读 header.suppressedDshTurns / regeneratedDshTurns——正是我们删的表（nativeCommits 我们仍保留）。我们回退走事务+恢复协议(§5.1)，“回退没落地”这一类已由事务恢复覆盖；“模型有完成轮而 Chat 没记(#196)”这一类我们是否存在，**需验证** | 改写后取（只保留“补记漏写轮”一项，改用 floor-projection 判断）。中。依赖 B1 |
| C1 | 修复原语 repairNativeSurface | 上下文对不上时自动只重写坏掉的尾部，缓存前缀不丢 | native-surface-repair.js(531a8ed5)：用一次 replace 换掉尾部再 append；写入 `tavern-native-repair` 来源的节点 | 【冲突(写法)/问题同源】replace+影子占位在我们这里是被取代的写法。**同一问题我们没有完全解决**：round-history/body-editor 仍有“找不到就抛错”。可用 select 改写：select(最长一致前缀) + append(缺失轮) + select | 改写后取。中。依赖 B1、事务层 |
| C2 | 回退/重新生成/编辑正文/撤销回退“存档优先，对不上就修复” | 回退按钮不再无故灰掉，不再提示“不在可回退的消息流中” | 51b77093、e903576c：round-history/body-editor 注入 repairNative；设计见 docs/design/native-session-repair.md | 【冲突(文件)】这些文件两边改动巨大(round-history 上游+20/我们+20 提交，行数 1116 vs 889)，不能合并；【产品目标无冲突】 | 改写后取其“失败时修复而非拒绝”。中—大。依赖 C1 |
| C3 | 失败/中止轮「撤回这条输入」 | 接口失败或手动停止后可清掉这一轮，原输入放回输入框 | f42c1b0e：仅 play-controls 加按钮，复用 rollbackTurn | 【无冲突】我们 main.js 已有 canClearIncompleteReply 通路(见第 4 节待验证)；客户端文件结构不同(上游 features/，我们 modules/ 旧 main.js) | 改写后取(UI 半小时级)。小 |
| C4 | 回退/重新生成性能：只读最近楼层 | 长档回退快 | 4ed8b7ad、7f487577、f6c1c6b6 | 【需适配】依赖局部读 Chat；我们的回退读 Chat 修订 | 随 A1。中 |
| C5 | 重新生成：只隐藏旧正文、保留玩家输入 / 按意见改写 / 合成一个按钮 | 重新生成体验更顺，可“按意见改写” | 71129de3(#256)、9ef26981、21a2087d | 【冲突(实现)】前者用逐回合隐藏表，已被 select 方案取代；【按意见改写】是请求层功能，可单取 | #256/#260 不取(我们结构上不会发生)；9ef26981+21a2087d 改写后取，小 |
| D1 | 压缩：剧情摘要分卷、旧卷不重压、超预算合并前情总览 | 长局压缩不越压越失真，摘要可按轮次回查原文 | 0eb28243、0b8206e8、e8145dd0、57104435(story-compaction.js、compaction-request.js、prompts/story-compaction.md) | 【无冲突】只读 surface 与请求，不写 surface；我们 fork 未改压缩文件(0 提交)，上游文件可近乎直取。适配点：检查点 source 的 `compactionId`/`dsh-compaction-basic` 在 0.1.5 的形状 | 取。小—中。需验证 0.1.5 检查点形状；依赖 tavern_recall_history |
| D2 | 压缩后保留最近 N 轮原文(可设 0–100)；压缩钩子合并 | 压缩后最近几轮原文不丢，缓存前缀保持 | 87b94a5b、377f70cf、68dff3dd、7b5c2d28、8d303f2b | 【无冲突】同 D1。唯一交互：我们设计 §6.2「摘要只在覆盖范围是当前分支前缀时可用」——上游无此语义，select 回退到摘要覆盖范围内时，选出的节点列表本身就不含摘要节点，结构性成立 | 取。小。随 D1 |
| D3 | 压缩后回退、后台会话原地清空 | 后台压缩过后回退不再换新后台会话 | d841f774、ba9e48a4、2a5676f2 | 【需适配】与我们 ADR-0003/background-surface 的事务化重写重叠 | 改写后取。小—中 |
| E1 | 正文走工具调用 submit_story | 抗拒答；正文放在工具参数里 | story-tool-submission.js(89911f3b)：回合结束后用 replace 把“调用+回执+副本”折成一条普通文本 | 【需适配】折叠这一步是 replace 写入，须改走 writeSurfaceEvent 事务(我们已有“回复投影走事务”先例 08cdb7df)；折叠后楼层/变体/编辑看到的是普通文本，所以 floor-projection 与 G4 不受影响。中止路径要把回执与调用转成中止标记，需配合我们的 failed-turn 清理 | 改写后取。中。依赖事务层 |
| E2 | 历史正文以工具参数回放 | 续写被拒答显著减少(Gemini 实测) | history-tool-call.js(1133ecbd、5a8178a3) | 【无冲突】纯请求期投影，不改存档/界面/楼层；只认 source.kind 为 model/user | 取。小。依赖 E1 的工具名，可先单取 |
| F1 | 撤销回退保存点 | — | surface-restoration.js | 【冲突(实现)】我们撤销回退=选回保存的分支 | 不取 |
| F2 | 会话改写批量不复制整份日志 | 长局改写快 | f2224155(session-surface-mutations) | 【需适配】对我们 writeSurfaceEvent 路径的性能，可借鉴 | 视实测 |
| F3 | v4 回合/step 约束修复(0e9c0dbf、bc49f87b、96ac19b3、79bf224e) | — | 只对 DSH 0.2 | 【无关】0.1.5 无此约束 | 不取 |

## 2.5 特别回答：「原生锚点 + 对账器 + 存档优先」能否与「Chat 楼层 + select 事件 + 楼层投影」共存

先澄清事实（读代码所得）：我们的楼层投影并不是完全脱离 Chat——`projectChatFloors` 仍以 Chat 的楼层列表（storyFloorTurns(chat)）为输入，只是把“每层楼在日志里的位置”交给日志推。所以两边其实都是「Chat 管有哪几层楼 + 日志管上下文」，分歧只在**对不上时听谁的**，以及**用什么写法修**。

- 锚点：能共存。上游锚点=(turn, 输入 seq, 回复 seq)，沿 replace 的 sourceEventSeqs 溯源（round-anchor.js 的 lineage）；我们 originInput/originBody 做同样的溯源。select 之后节点就是原事件，溯源更直接。两套不要并存，保留 floor-projection 一份。
- 对账器：**实现不能共存**（读已删的 suppressedDshTurns/regeneratedDshTurns，且在“重新隐藏”时用影子占位 replace，这正是被 select 取代的写法）；**思想可以共存**，且我们缺这块。
- 存档优先修复：**写法不能共存，原则可共存**。上游的“Chat 为唯一权威”与我们 ADR-0008/0009 的“日志为唯一事实源”在**内容**上冲突；但实际对不上只有两类——(a) 完成了的一轮 Chat 没记（崩溃/中断）：应从日志补记，与上游相同；(b) Chat 已回退而上下文没跟上：我们由事务恢复协议（§5.1）保证，不需要对账。
- 谁让步：上游让步（权威归日志、写法用 select）；我们让步的只是产品承诺——“任何历史操作都不得因为定位失败而拒绝”，我们的代码目前仍有这些拒绝点（round-history.js:85/:543、body-editor.js:79、rollback-surface“已不在可回退的消息流中”）。
- 代价：改写 C1/C2/B3 约 中等工作量；若不取，则维持现状，风险是“对不上”时玩家只能继续发新消息、坏回复留在上下文里（上游记录此类修复已有 47 个）。

## 3. 必须由用户拍板的问题

1. **要不要做“操作不得因定位失败而拒绝”（C1/C2/B3）？** 选项：(甲)做，改写成 select+追加的修复，约中等工作量，推荐；(乙)不做，保持现状，等真实出现再修。倾向甲，但可在甲之前先用 4-1 的实机验证确认我们是否真会遇到。
2. **要不要上游的分页存档（A1/A3/A4）？** 它解决的是万轮长档的打开/继续速度和磁盘膨胀，对短档无感；工作量大且会改动 Chat 存储（需适配 variantStates、MVU 读写）。选项：(甲)不做，等长档真正成问题；(乙)做 A1+A3，不做 A4；(丙)全做。倾向甲或乙；用户的主要玩法若是长局（数百轮以上）则选乙。
3. **“分叉历史只留最近 50 轮”（A5）能不能接受？** 代价是较早楼层不能再“分叉成新会话”，强行分叉提示历史已清理。我们的 branch+checkout 不受影响。倾向：随 A4 一起决定，不单取。
4. **正文走工具调用（E1）与历史回放（E2）是否都要？** E2 只改发给模型的请求，风险小、见效快，倾向先单取 E2；E1 要改回合收尾写法，倾向在确认 E2 仍不够时再做。两者默认关闭，设置里可开。
5. **压缩分卷与保留最近 N 轮（D1/D2）：** 倾向直接取，唯一要确认的是最近 N 轮默认值 10 是否合适。
6. **是否允许把上游的 `rollback-surface/round-history/body-editor` 当作“按功能手工移植的对照物”而非合并对象？** 倾向是。整文件合并会带回 replaceSessionSurface 和逐回合表。

## 4. 不确定、需实机验证

1. **#196 在我们这里是否存在**：一轮在模型侧已完成、Chat 却没记下（崩溃/中断/脚本写入时序）。上游修了它，我们 fork 没有对应补记代码（uncommitted-rounds 在 MB 之前不存在，我们 0 提交）。需要用中断生成/杀进程的实机场景验证；静态阅读无法下结论。
2. **“找不到就拒绝”能否被现实触发**：在我们的 select 方案下，回退/重新生成/编辑正文后上下文对不上的路径是否已被封死？静态上看拒绝点仍在代码里，但触发条件是否可达需要故障注入（删节点、压缩后回退、导入的会话）。
3. **压缩检查点形状**：已查已安装宿主 `dsh-compaction/lib/index.js:119` 的 compactCheckpointSource 带 `compactionId`，上游 storySummaryVolumes 的识别条件成立；但 `dsh-compaction-basic` 的末尾指令消息在已部署内核上是否仍带 producer 标记（上游注释称 0.1.x 带、0.2.x 不带，其识别代码已兼容两种），需一次实机压缩确认提示词确实替换成剧情版。
4. **压缩与 select 的交互**：回退到压缩检查点之前后，select 的节点列表不含摘要节点是结构性保证，但“压缩后再回退、再玩、再压缩”时卷头里的 `through` 轮号是否仍正确，需实机跑一遍。
5. **submit_story 的折叠写入走事务是否被宿主接受**：上游折叠依赖 replace 范围引用调用/回执节点；在 0.1.5 + 我们事务层(G2 配对)下是否通过预检，未验证。
6. **分页存档与 `variantStates` / projectTavernHelperMessage 的字段兼容**：native-conversation-storage.js:268 的字段白名单不含 variantStates，是否会让 MVU 随变体联动失效，需读写一轮后核对（静态推断，未实机）。
7. **撤回失败输入（C3）**：我们 chat-session-state/rollback-surface 已有 canClearIncompleteReply，但上游扩大了“显示撤回按钮”的条件(接口失败/手动停止都给)。我们现有条件是否已覆盖，需实机在“接口失败”“手动停止”两种情形下看按钮。
8. 本报告对上游代码的了解来自 `git show` 抽读（round-anchor、session-turn-input、native-surface-repair、story-alignment、uncommitted-rounds、story-tool-submission、history-tool-call、story-compaction 前 170 行、native-conversation-storage 前 300 行等），未运行任何上游测试。
