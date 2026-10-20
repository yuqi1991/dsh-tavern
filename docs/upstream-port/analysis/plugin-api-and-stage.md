# 上游「插件接口与演出层」与我们新设计的对照（plugin-api-and-stage）

状态：完整版。只读分析，未改任何仓库文件。基点 MB=e990cbc9；上游=upstream/main（DSH 0.2.1）；我们=HEAD（DSH 0.1.5-rc.2 + surface-select 补丁）。
与 core-conversation.md 的口径一致：上游的原生锚点/对账器/replace 写法不取；本报告只涉及「读」楼层/正文版本的接缝，不碰会话写入。

## 1. 一段话结论

**插件接口层可以基本原样搬，接缝很薄。** 原因：上游插件接口对「轮次」只依赖三件事，而这三件事我们的新设计里都还在——①`turn`=Chat 里助手消息的 `turn`（楼层号；重新生成时保持原号，回退后新一轮用宿主递增号，所以编号可能不连续，文档已声明）。这正是我们 floor-projection 的 `floor.turn`，**不是**宿主原生轮次（`hostTurn`/`nativeTurns` 插件看不到也不需要）；②`textVersion`=`sceneTarget()`（scene-illustration.js:36，我们已有且未改）对「聊天标识+前文各楼正文+本楼序号+本楼正文哈希」取的哈希；③插件的按轮数据、媒体、台词标注都**绑在 textVersion 上、读取时只认当前版本**，所以回退、撤销回退、切变体对它们天然正确，**上游根本没有「删轮通知」**——`onTimelineChanged` 只是告知，`versionSignal` 在版本变了就中止在途任务。「回退=选择事件而不是改写」对此无影响，因为插件读的是 Chat 修订，不读会话日志。真正要适配的只有：6 个「时间线变了」通知点接到我们的 RPC 入口（含**上游没有的「切变体」**）、分叉/导入存档时重算 textVersion 映射、以及客户端挂点（我们已用 Story View 取代宿主消息帧）。接缝代码估计 150–300 行 + 测试约 300 行。**真正的工作量不在接缝，而在体量**：插件相关新文件约 5100 行（plugin-api.js 1477 + 领域模块约 1300 + 演出/配音约 860 + 浏览器端约 1500），外加约 25 个核心文件里的接线点，其中 10 个我们也改过（index.js 上游+2708/我们+298，其余见 §5）。建议分三批取：先取只读与数据层（低风险），再取提示词/结算/世界书添加类（依赖结算管线重构），最后取客户端与演出（依赖 Story View 挂点与客户端拆分的决定）。

## 2. 逐项能力表

格式：能力｜用户感到什么｜上游实现｜与新设计关系｜建议｜工作量｜依赖。分类：【A】可低风险先取；【B】要等核心/其他主题定了再取。

| # | 能力 | 用户感到 | 上游实现（关键） | 关系 | 建议 / 量 / 依赖 |
|---|---|---|---|---|---|
| P0 | 插件开放层骨架：`tavern` 宿主服务、`apiVersion`、归属/卸载撤销、按局开关、错误记录、本局插件面板 | 无（基础设施）；用户在「本局设置→高级→插件」能关插件、看错误 | plugin-api.js（21a1e9ad 起；b97b4e31 第 2 版；dcb3b7fc/11ed8170 面板）；通过 `deps` 注入约 45 个核心函数（index.js:3148） | 【无冲突】全部新文件；接线在 index.js（两边都改） | 取。大（整体搬运+接线）。【A】 |
| P1 | 插件放进 `plugins/` 即加载，运行中增删，加载失败只记日志 | 放个文件夹就有插件，不用重启（浏览器侧刷新） | user-plugins.js 179 行：改写 profile 的 `cordis.patch.yml` 里 `tavern-user-plugin-*` 条目（7fb918ac、6a97b1af） | 【需实机验证】依赖 DSH profile/patch 机制，上游针对 0.2.x 的 profile 布局（profiles/tavern 与 desktop） | 取，先验证。小–中。【A】 |
| P2 | 读取类：`getTurn`、`getHistory`、`getTurnState`、`getCard`、`getCardContext`、`getCardImage`、`backgroundModel`、`listCards`、`readCardRaw`、`getCharacterDesigns` | 插件能读正文、变量、设定 | plugin-turns.js 98 行（`resolveGame/currentKey/readTurn/readLatestSettledTurn/readPendingTurn/readVariables`）；读 Chat 助手消息+`sceneTarget` | 【无冲突】我们 Chat 仍有 `messages[].turn/sourceText/variables`，fork 已有 sessionStateForSession/chatSliceForSession/readSceneImageState 同名依赖，`sceneTarget` 与我们的场景配图共用，等于已在我们的语义上验证过 | 取。小（接线）。【A】 |
| P3 | `textVersion` 与「跟着正文版本走」的数据：`saveTurnData/readTurnData/saveGameData/readGameData`、`attach/update/remove/list` 媒体项 | 回退/撤销回退/重新生成后，插件配图、记忆自动对得上；切回旧变体，旧版本的东西又出现 | plugin-data.js 122、plugin-media.js 229；写时校验 `textVersion` 等于当前，读时只认当前（plugin-design.md §4） | 【无冲突，且比上游更合】上游重新生成后旧版本数据永久读不到；我们有变体，切回旧变体时数据自然回来，正是文档承诺的「切回旧版本时恢复」 | 取。小（只剩分叉的 keyMap，见 P9）。【A】 |
| P4 | 生命周期观察：`onTurnSettled`、`onTimelineChanged`、`onGameRemoved`、`versionSignal` | 插件知道「这一轮写完了」「剧情线变了」，在途任务随版本变化自动停 | `turnSettled`（plugin-api.js:1065，按 textVersion 去重、内存集合）由 `onSettlementSettled` 触发（index.js:4104）；`timelineChanged` 只接受 5 种 kind；`checkVersions` 比对 `currentKey` | 【需适配·接缝】见 §3「语义变化」 | 取。小–中。依赖 P2、结算完成钩子（fork 已有 `onSettlementSettled`，index.js:2764）。【A】但切变体的通知要定语义 |
| P5 | 改最新一轮：`setVariables`、`editTurn` | 插件能改变量/润色正文（只限最新一轮、结算结束后） | plugin-variables.js 36（按 `variables[swipeId]` 写，CAS 补丁）；`editTurn`→`bodyEditor.replaceText`→`save()` | 【需适配】`replaceText` 只是包一层 `save()`，我们的 `save()` 已走 editStep 事务，所以走得通；`setVariables` 写 Chat 行，随变体存档，与「变量随变体」一致；文件 body-editor.js 两边都改，需手工并 | 取。小–中。依赖 P2。【A】 |
| P6 | 提示词类添加：`promptSection`、`turnSection`、`worldbookSource`、`worldbookEntries`、`getRequestContext` | 插件能往正文请求里加段落/世界书条目；条目进入 Tavern 召回、冷却 | turn-orchestration.js:438、hooks/turn-lifecycle.js:115、plugin-worldbook.js 34；`foregroundRequestContext(header.foregroundFrames,…)` | 【无冲突】前几项只改请求组装，不写 surface；fork 没动 turn-orchestration/turn-lifecycle（上游独占改动，可近乎直取）。`getRequestContext` 取「当前分支最近一次」→ 依赖 Story Timeline 分支 | 取。中。`getRequestContext` 要实机验证。【A，除 getRequestContext 为 B】 |
| P7 | 结算类：`settlementSection/Tool/Task`、`manualTask/startTask`、`replaceSettlement`、`candidateSection`、`compactionSection`、`runTask` | 插件能加每轮后台任务、接管姿势结算、手动任务按钮；玩家可排序/关闭 | 先要有「结算项注册表+阶段表」：background-pipeline.js 112 行（28832044、b5f4b052、6b9b5196、5509757f 4 个重构）；再 index.js `runSettlementCycle`（4048）、`runPluginTask`；background-agent-task.js（两边改） | 【需适配】不碰会话写入，但改后台结算流程，与 ADR-0006（前台先提交、结算 stale 即弃）一致：任务带 `textVersion`，版本变了 `signal` 中止 | 改写后取，晚于 P0–P6。大。依赖后台结算管线重构（另一主题）。【B】 |
| P8 | 人物卡库类：`cardRevision`/`onCardChanged`、`cardImporter`、`updateCardRaw(expectedRevision)`、Skill 读写、`skillSource`、`toolModes` | 卡片工作台类插件、导入别家卡包 | 2d550298；index.js 内 `cardProjectionRevision`、`importPluginCardFile` | 【无冲突】与对话历史无关 | 取。中。依赖 P0。【A】 |
| P9 | 分叉/导出/导入存档带走插件数据与媒体 | 游戏分叉、导出存档后插件内容还在 | `gameForked/exportGame/importGame`、`forkTurns`；用 `keyMap('turn\0key'→新key)` 重算新游戏的 textVersion（index.js:2784、1841） | 【需适配】这是**唯一**会因我们分叉写法不同而重写的地方：要用我们的 conversation-fork 产生的新 Chat 重算每层 textVersion；game-save.js 上游独占改动 | 改写后取。小–中。依赖 P3。【B】（待分叉实现稳定） |
| P10 | 台词标注/对话头像/角色素材/立绘 | 正文台词旁带头像，随情绪换图；人物卡可配头像、表情；可导入 ST 立绘包 | cast-presentation.js 75、cast-annotation.js 105、cast-assets.js 300；标注作为结算项挂在主结算上，数据存 `pluginData`（绑 textVersion） | 【需适配】服务端部分与 P3 同理无冲突；**依赖结算项注册表（P7）**；浏览器侧要改正文渲染 | 改写后取。大。依赖 P3、P7、P12。【B】 |
| P11 | 配音（TTS）：`speechProvider`、`synthesizeSpeech`、`speak`；内置渠道含浏览器朗读、OpenAI 兼容、MiniMax、火山引擎（ff250e26） | 台词按人物声音朗读；可接自己的语音服务 | speech.js 382（缓存键含渠道/声音/情绪/version）、客户端 features/speech.js 202 | 【无冲突】只读标注与正文，不涉对话历史；火山渠道（`volcengineResource/Emotion`、V3 接口）是自包含约 150 行 | 取（服务端）；客户端播放随 P12。中。依赖 P10。【B】，但渠道代码本身可先取 |
| P12 | 浏览器侧 `tavernUi`：`registerTextMarker/MessageAction/ComposerAction/MediaRenderer`、`registerPanel/StartGroup/StatusSection/CardListView`、`openOverlay`、`setInput/submitInput`、`callHost`、`assetUrl`、`watchState` 等 | 正文里的标记变图片、消息下的按钮、侧栏插件面板、全屏玩法 | features/plugin-extensions.js 744（大部分自包含）；挂点在 assistant-renderer.js:629–782（媒体列表、文字标记、消息按钮、整轮视图） | 【需适配】上游客户端已拆成 101 个文件（main.js 10828→1168 行），我们仍是旧 main.js + Story View；挂点要改到 `story-view.js:135` 的 `renderTavernProjection` 与 floor 容器 | 改写后取。大。依赖客户端结构决定（另一主题）。【B】；其中不碰正文的（面板、StartGroup、StatusSection、callHost、assetUrl、openOverlay）可先取【A】 |
| P13 | 舞台：`getStage/watchStage/registerStageView`、背景音乐 `playMusic`、整轮视图 `registerTurnView`、`publishState/watchState` | 右侧 Galgame 式舞台，逐句翻页、立绘、背景、音乐 | features/cast-stage.js 311、cast-presentation.js 164；`getStage` 读最近 N 轮的 `{turn,text,lines}` | 【需适配】读的是楼层+标注，与回退无冲突；`turns` 要按 floor-projection 的当前线取；舞台内嵌输入框与我们 Story View 会抢位置 | 改写后取。大。依赖 P10、P12。【B】 |
| P14 | 卡内插件（`.dshcard`）：随卡分发、确认后加载、只在本卡局里生效 | 导入带舞台的卡即玩；卡里程序限定在本卡 | card-plugins.js 155、card-archive.js、`guardScope`（plugin-api.js:~215）；格式见 docs/design/dsh-card-format.md | 【无冲突】但**安全性要拍板**：卡内插件在本机运行宿主代码（无沙箱），Tavern 只能在接口层限制 | 取与否待用户定。中。依赖 P0、P1、P8。【B】 |
| P15 | 导演舞台示例、hello 示例、`tavern-plugin` Skill/docs 站点 | 开发者有范例；AI 能照着写插件 | examples/tavern-plugin-director、tavern-plugin-hello、dafeiyu-card；docs/plugin-api.md 1084 行（接口版本记录） | 【无冲突】文档与示例；需把「变体」补进文档 | 取（文档随 P0 搬，示例随对应接口）。小。【A】 |

## 3. 语义逐项对照（核心问题的回答）

| 上游概念 | 上游依赖 | 在我们设计里对应 | 结论 |
|---|---|---|---|
| `getTurn(turn)` | Chat 里 `turn` 相同的助手消息；最新一轮须 `settleStatus∈{done,failed,idle}` 且无 `mvu.pending` | floor.turn；Chat 行未变 | 原样 |
| 重新生成 | `replaceLastRound` 保留 `turn: originalAssistant.turn`；旧正文丢弃，新 `textVersion` | 同样保留 `turn`（round-history.js 里恢复 oldTurn），旧正文留为变体；新 `textVersion`（正文哈希变） | 原样；`onTimelineChanged('regenerate')` 保持 |
| 切换变体（上游无） | — | 只允许最后一楼；Chat 行被 `restoreVariantState` 整体换成该变体的正文+变量，`sourceText` 变 → `textVersion` 变回旧值 | **新增语义**：建议新增 kind `variant`（文档已说明不认识的 kind 请忽略，向后兼容）；不重发 `onTurnSettled`（该版本已通知过，去重集合命中），若该变体从未结算过则等其结算完成时按常规通知 |
| 回退 | Chat 恢复到检查点修订；插件无「删轮」回调，旧版本数据读不到 | 回退=日志上一个 select 事件，但 Chat 也被恢复到对应修订；`textVersion` 由 Chat 算 | 原样；`rollback` 通知点接在 `rollbackTurn` RPC（index.js:3691） |
| 撤销回退 | 恢复 Chat；通知 `undo-rollback` 且重发 `onTurnSettled`（去重后通常不重发） | 撤销回退=选回保存的分支（F1 不取上游 surface-restoration） | 原样；通知点在 `undoRollbackTurn`（index.js:3690） |
| 编辑正文 | `bodyEditor.save` → 新 `textVersion` → 重发 `onTurnSettled` | 同，且我们的 `save()` 已走 editStep 事务 | 原样 |
| "回退后重新生成用新编号" | 文档语句 | 回退后新楼层号取宿主递增号（与上游同） | 同；`hostTurn` 不暴露给插件，别暴露 |
| 「跟着正文版本走」的变量 | `variables[swipeId]`（Chat 行） | 变体切换时整行由 `variantStates` 恢复，变量随之；无存档的老变体显示结算前基线 | 原样；见 §4 第 3 条 |
| 分叉（新游戏） | `keyMap` 重算 textVersion | 我们的 conversation-fork 另写 | 唯一需要重写的接缝（P9） |

## 4. 必须由用户拍板的问题

1. **切变体时插件怎么得知？**（a）新增 `onTimelineChanged` 的 kind=`variant`，不重发 `onTurnSettled`（倾向）；（b）借用 `regenerate`，插件不用改；（c）每次切换都按新版本重发 `onTurnSettled`。倾向（a）：文档本来允许新增 kind，旧插件忽略即可。
2. **是否取卡内插件（.dshcard）？** 卡内程序在本机无沙箱运行。选项：不取；取但默认关闭、导入时明确提示并需逐卡确认（上游做法，「确认后加载」）；只取格式不取插件。倾向最后一项先行，之后再决定。
3. **客户端先后：** 先取不碰正文的 tavernUi（面板/StatusSection/callHost/assetUrl/openOverlay），还是等 Story View 的插件挂点设计好再一次取全？倾向先取前者，正文挂点（文字标记、媒体位置、消息按钮、整轮视图）在 Story View 里单独设计。
4. **要不要演出层（头像/舞台/配音）？** 它占插件相关体量的约 40%，且依赖结算项注册表。若只想要插件接口而不要演出，可以只取 P0–P9、P11 的渠道（含火山引擎）与 P12 的非正文部分。
5. **插件数据是否持久化 `onTurnSettled` 的去重记录？** 上游只放内存，重启后切回旧变体会再通知一次。倾向不改（插件本来要求幂等）。

## 5. 体量、冲突面与低风险分批

- 新文件（我们没有）：plugin-api.js 1477；domain/ plugin-media 229、plugin-data 122、plugin-turns 98、plugin-variables 36、plugin-worldbook 34、plugin-game-settings 81、plugin-text-segments 100、plugin-assets 75、user-plugins 179、card-plugins 155、plugin-settlement-progress 26、tavern-chat-plugin-data 101；演出 speech 382、cast-presentation 75、cast-assets 300、cast-annotation 105；浏览器 plugin-extensions 744、cast-stage 311、cast-presentation 164、speech 202、card-plugins 93。合计约 5100 行，基本是整文件搬运。
- 上游在核心里的接线点涉及约 25 个文件。**我们也改过的（会冲突）**：index.js（上游+2708/-2047，我们+298/-140）、background-agent-task.js、body-editor.js、reply-presentation.js、input-fields-projection.js、tavern-helper-context.js、tavern-script-host-adapter.js、foreground-orchestration-strategies.js、客户端 main.js、客户端构建产物 lib/client.js。**我们没改的（近乎直取）**：turn-orchestration.js、hooks/turn-lifecycle.js、hooks/model-stream.js、background-pipeline.js、game-save.js、http/routes.js、live-card-update.js、template-message.js 等。
- 注意 `tavern-chat-plugin-data.js` 上游独占，不要与我们的 `variantStates` 混淆。
- **批 1（低风险，先取）**：P0 骨架+P1 加载（先验证）、P2 读取、P3 数据/媒体、P4 观察（含切变体通知）、P5 改最新一轮、P6 的 promptSection/turnSection/worldbookSource/worldbookEntries、P8 人物卡库类、P12 的非正文部分、P15。接缝适配：通知点 6 处（rollback/undo-rollback/regenerate/edit/variant + replay）约 30–50 行；`deps` 在 index.js 的接线约 150 行；分叉键映射另算（P9 约 60 行）。
- **批 2（等其他主题定）**：P7 结算类（等结算管线重构）、P9 分叉/导出、P10 演出服务端、P11 配音、`getRequestContext`。
- **批 3（等客户端结构）**：P12 正文挂点、P13 舞台、P14 卡内插件。

## 6. 我不确定、需要实机验证的点

1. **P1 的加载机制能否在 DSH 0.1.5-rc.2 的 profile 布局上工作**：user-plugins.js 以 `ctx.plugin`+profile 里 `cordis.patch.yml` 的 insert 条目加载，并假设 `profiles/tavern` 与 `profiles/desktop`。静态读不能确认 0.1.5 是否同样支持。
2. **`sceneTarget` 的 `prefix` 要遍历前面全部楼层**：我们没有上游的分页存档/按需读取，万轮长档里每次 `currentKey` 会读整个 Chat。短档无感；是否成为性能问题要实测（`versionSignal` 的 `checkVersions` 每次时间线变化都会重算）。
3. **未结算的变体**：`readLatestSettledTurn` 判定「已结算」靠 `header.settleStatus` 和 `mvu.pending`。切到一个没有结算存档的老变体时（`withoutVariantSettlement` 返回结算前基线），header 可能仍是 `done`，插件会读到「已结算但变量是基线」。需实机构造：重新生成→切回旧变体→看 `getTurn.variables` 与 `getTurnState.settled`。
4. **`getRequestContext` 的「当前分支最近一次」** 依赖 header.foregroundFrames 与 Story Timeline 分支；切回旧变体后返回的是新变体那次的请求还是旧变体的，需验证。
5. **回退后新一轮的 `turn` 取值**：我读到上游与我们的 Chat 层逻辑一致（`replaceLastRound` 保留原号，回退后用宿主递增号），但没有实机确认 select 事件下宿主的轮号计数没被重置。若重置，则「编号只增不减」的文档承诺失效，插件的 `readTurnData(turn)` 取「第 turn 轮及之前最新」会错读。
6. **`replaceSettlement`/结算任务与我们 MVU Delivery**：上游注明「官方 MVU 卡的变量结算仍由 Tavern 负责」；我们 MVU 结算效果走 Story Timeline 原子提交，二者互不覆盖，但插件 `before` 任务与 MVU pending 的先后需要在后台管线重构后再测。
7. **舞台与 Story View 的输入框位置**：上游「读到最后一句在底部 88px 显示输入框」假设宿主原生输入框；Story View 的输入区是否冲突，未验证。
8. **静态阅读限制**：我读了 plugin-api.js 关键段、plugin-turns/data/variables、round-history 的重新生成与切变体、floor-projection；`plugin-media`、`speech`、`cast-*` 与浏览器侧实现只看了接口说明与行数，没有逐行核对。
