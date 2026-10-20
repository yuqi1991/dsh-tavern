# 上游产品功能与客户端大重构评估（product-features）

状态：边读边写的工作稿，章节逐步补全。只读分析，未改任何仓库文件。
基点 MB=e990cbc9（2026-09-28）；上游=upstream/main（DSH 0.2.1）；我们=HEAD（DSH 0.1.5-rc.2 + surface-select 补丁）。
标注约定：【0.1.5可用】= 在我们现用内核上就能用；【需0.2.1】= 依赖 0.2.1 内核/上游新存档格式才可用。

## 0. 先给事实（已查实）
- 客户端大重构 9dedc0ec（09-30）把 11 000 行的 main.js 拆成 features/（16 个）+ runtime/（10 个）+ ui/（2 个）；上游 main.js 现在只剩 1168 行。7c270f7c 把 lib/index.js 的 1387 行拆到 tools/、hooks/、http/routes.js。这两个提交本身是“纯搬家”，不改行为。
- 我们的 main.js 实际语义改动很小：忽略空白后相对 MB 是 +353/-875。表面上的 4421/4943 是 e063da72 把整份 main.js 重排了缩进（同时重新生成了 lib/client.js，11231 行），不是真改动。
- 但 -875 里相当一部分不是“我们的新设计”，而是 e063da72 把已部署开发树的旧版 main.js 整份换进来，抹掉了 MB 里的 2026-09 性能接线（indexed-array、帧尺寸 sizing、增量 MVU 派发等）。所以对 git 来说“我们删了这些”，会与上游产生一批虚假冲突。
- lib/client.js 是 main.js 的构建产物（109 处冲突标记），任何合并都不要手合，合完重新构建。

## 1. 客户端大重构（9dedc0ec、7c270f7c）：怎么取最划算（已实测）
实测方法：只读，把 main.js 的 `// @include` 递归展开，和拆分前对比。
- **9dedc0ec 是无损搬家**：展开后的 15312 行与拆分前逐行相等（忽略空白）。上游自己的 README 也写明“构建产物逐字节不变”，所有片段仍在同一个工厂作用域，只是 `// @include features/xxx.js`。所以“拆分”本身没有任何行为，也不构成冲突来源。
- **真正的冲突来自内容，不是结构**。把 MB、我们、上游三份 main.js 各自展开成一条流再做三方合并：我们 14566 行、上游 22708 行（上游客户端比 MB 多长了约 8000 行），共 **79 处冲突**，中位数 15 行，最大一处 847 行（Story View 整块）。逐个看过冲突开头：
  - 约 25 处在 Helper/iframe/会话视图读取（receiptSync、contextDelta、帧 sizing、indexed-array 接线）。这些是 e063da72 整份换入已部署开发树时“抹掉”的 MB 期性能接线，并非我们的新设计；这些冲突应一律**取上游**。
  - 约 10 处是我们真正的改动：Story View 槽位注册（O301 行）、变体切换器 TavernVariantSwitcher、轨迹定义注册、assistant-visibility 的记账行隐藏、host-session-patch 安装、对 turn-error-controls / history-viewport 的删除。
  - 其余约 40 处是两边都在同一块界面代码上改（人物卡列表、设置页、模型选择行、重新生成指导表单、状态面板页签），多为几行级别的并列修改，需人工看但不难。
- **结论：不建议“逐段合并 main.js”，也不建议“照搬上游客户端目录”，建议『以上游的拆分布局为底，重放我们约 10 处真改动』**。理由：(1) 上游此后所有 UI 功能（台账、候选面板、Guide、人物卡库、设置改版、生图页）都落在 features/*.js 里，不拆就得把每个提交手工“翻译”回单体 main.js，工作量随功能数线性增长；(2) 我们的真改动只有约 350 行加、其中 Story View/trajectory/host-session-patch 本来就是独立 modules 文件，只需 main.js 里约 100 行接线 + 变体切换器约 40 行；(3) 做法可机器校验——展开后构建产物必须等价，`build-tavern-client.mjs --check`。
- **但有一个硬前提**：整套上游 features/runtime 依赖上游服务端接口。上游客户端调用 139 个 RPC，其中 **48 个在我们服务端不存在**（如 exportGameSave、importSettingsBundle、listGuideLibrary、setGlobalWorldBook、sceneImage 历史、castStage、speechForLine、cardPlugins、getBackgroundSuppressedTurns 等），另有 viewSync 的 resourceSync/openingWindow/historyFrom/contextDelta 协议字段。所以“采用拆分”必须与“采用这些服务端功能”同步分批，不能只换客户端。实际做法：先在我们树里按上游布局建空壳（或直接取上游的 runtime/ 与 ui/ 里与协议无关的文件），features/*.js 随各功能一起引入。
- 其中 getBackgroundSuppressedTurns 属于上游“逐回合隐藏表”体系，是**必须丢掉**的一个调用点（我们已删该表）。
- **7c270f7c（lib/index.js 拆 tools/hooks/routes）几乎不影响我们**：我们在 index.js 的 80 个改动块里，只有 1 块落在被搬走的代码里，其余 79 块都留在 `apply()` 里。index.js 的 28 处文本冲突来自上游其它 2000+ 行改动（核心机制/存储/插件接口），不是拆分造成的。拆分带来的好处是此后上游新增的 11 个模型工具（tavern_search_card、tavern_replace_card_text、tavern_mvu_overview/apply 等）落在 tools/*.js，可直接取，几乎不碰 index.js。建议：取 tools/ hooks/ routes 的新布局，但 hooks/request.js、model-stream.js、turn-lifecycle.js 里含核心请求路径（见 core-conversation.md），按那份报告的取舍处理，不要整文件覆盖。
- **lib/client.js 是构建产物**：我们 5547+/5772-（忽略空白后 1026+/1251-），与上游 109 处冲突，禁止手合，合完源码后重新构建。

## 2. 结论（一段话）
上游的产品功能**大部分可以取，而且和我们的新设计几乎不冲突**：生图、世界书、台账/Guide/候选面板、MVU 工具链、人物卡格式、存档导入导出、设置改版，都是“新增文件 + 在 index.js / 客户端各接几行”，不碰会话写入，在我们现用的 DSH 0.1.5-rc.2 上就能用。真正要动脑的只有三类：(1) 针对“宿主原生对话页”的客户端性能手段（渲染深度、远楼占位）——Story View 下**仍有意义，但不会自动生效**，要把几十行接进 TavernStoryFloor；历史窗口按页扩展则**不适用**（我们根本没有历史窗口）；(2) 凡是“按楼层/按变体存东西”的功能（生图、MVU 变量编辑器、存档包）要核对变体语义；(3) 所有放在 features/*.js 里的 UI 功能，取决于我们是否采用上游的拆分布局（§1：建议采用）。**据静态阅读，没有任何一项必须 0.2.1 才能用（未在 0.1.5 上逐项实机验证）**——被标【随核心】的几项（分页存档、自动整理存档、存档格式 2）取决于 core-conversation 报告里的存储取舍，不取决于内核版本。

## 3. 逐项能力表
列：能力｜用户感到什么｜上游实现（关键）｜与新设计【关系】｜建议 / 量 / 依赖。均标【0.1.5可用】除非另注。
| 能力 | 用户感到 | 上游实现 | 关系 | 建议 / 量 / 依赖 |
|---|---|---|---|---|
| 场景生图：NovelAI 多接入点、画师串库、提示词预设、自动画风/锁定画风、按构图横竖图 | 同一局可配多个 NAI 中转，画风稳定 | 04a0f34b 5d2ffacf 7307d2f3 dc1f7ffd 855c82a7；scene-image-novelai.js(+318) scene-image-channels.js；packages/dsh-image-gen | 【无冲突】scene-*.js、dsh-image-gen 均不在我们改动清单（文本合并干净） | 取。中。无 |
| 重画（重新构思/同方案/手改提示词）、补画、失败重试、同轮多图、插图下改提示词、撤销最近一轮 | 想画就画，旧楼也能补 | 90373467 b5387d40 d97c2efd 3100d223 a2596cf4 70930eda fc472779；客户端 features/scene-images.js(480 行)、scene-illustration.js(+335) | 【需适配·小】图片按 sceneTarget(turn+正文哈希) 存，切变体后哈希变→自然显示该变体的图，是对的；Story View 已在 TavernStoryFloor 里挂 SceneIllustration，key=turn，可直接用；但 scene-illustration/scene-state/scene-worldbook 读 message.swipes，我们 P2-A 不再写 swipes，需确认回退到 sourceText（实机） | 取。中。依赖：客户端布局决定（接线点） |
| 画廊（对话区标签页，按轮次浏览/批量删）、历史图片 | 看本局所有插图 | 4781c947 7dcd2ca5；listSceneImageHistory 等 RPC | 【无冲突】画廊是独立 conversation.view 标签，与 Story View 并存（id 不同） | 取。小。依赖生图 |
| 每轮自动生图、画最值得画的一幕 | 不用点按钮 | 739f072a 60af1b39；在结算完成钩子里触发 | 【需适配·小】接到我们已有的 onSettlementSettled；需防“重新生成/切变体时重复生图” | 取。小。依赖生图 |
| 世界书：全局选择、搜索、顶栏快捷面板、条目懒挂载 | 切世界书/找条目更快 | 93315f46 e5799d01 2b337649 3755e293；worldbook-library.js features/worldbook-switcher.js | 【无冲突】 | 取（先取）。小。无 |
| 世界书：冷却 10 轮、回复后预筛、召回说明 | 发送更快、少重复召回 | 021fcbbd 8bb7fc3a f78a2dd1；worldbook-prefilter.js(新 36 行) worldbook-recall.js | 【需适配·小】预筛读“最近楼层”（3b4285d4 依赖上游按需读楼层，属存储核心）→ 先取不依赖它的部分；预筛挂在回复结束钩子 | 取。小–中。无 |
| 世界书：进行中游戏默认自动采用库内改动 | 改了世界书不用重开局 | 3256ffca；play-card-snapshots.js(+105) | 【需适配·小】tavern-script-host-adapter.js 也被改(8 行)，那个文件我们也改过(19 处文本冲突) | 取。小。依赖 host-adapter 合并 |
| 台账（玩家手动整理）、人物设计档案可逐条删、Guide(原剧情指导)、候选面板精简、剧本进度面板重做 | 状态面板更清爽，备忘更可控 | e6fcb341 d1985cf2 70c0c51e 0e437272 a72857b5/7092523c/2f77cac7 439a00ac；manual-ledger.js、story-ledger.js、script-navigation.js | 【无冲突】都在状态面板/玩家输入框，与对话视图无关；candidate/script 文件我们没改 | 取（先取）。每项小。注意：5509757f 把台账变成“结算项”依赖结算项注册表，可先不取 |
| 原地 MVU、转 MVU 工具(tavern_mvu_overview/apply)、卡片工作台新工具 | 新建卡直接带 MVU；一键转 MVU | ccceeaf0 6108567a 3108bd9e 08cdb7df；mvu-card-apply.js(255) mvu-self-source.js；tools/card-editing.js | 【无冲突】只改卡文件，不碰会话 | 取。中。依赖：tools/ 布局（7c270f7c，建议同取） |
| 服务端运行卡脚本；页面前台时由页面执行 | 手机后台/关页也能跑脚本、变量继续更新 | 0d086d2e 1f76adf5；server-script-executor.js tavern-script-dispatch.js script-execution.js | 【需适配·中】脚本读/写变量必须对准“按分支推导的当前变体”（projectTavernHelperMessage）；tavern-script-host-adapter.js 19 处冲突要人工合 | 改写后取。中。依赖 host-adapter 合并；需实机 |
| 变量回灌前台(开关)、变量目录一次性注入 | 前台模型看到上一轮改动的变量 | 974f53a8 5a8471f3 9c0791ef；foreground-variable-changes.js(50) hooks/request.js | 【需适配·小】改请求层，不写 surface；session-stable-prefix.js 我们也改了(1 处冲突) | 取。小。依赖 |
| MVU 变量编辑器（当前楼层） | 手改变量 | 42effe3e；mvu-variable-editor.js(97) client modules/mvu-variables.js(185) | 【需适配·中】编辑器按 message.swipe_id / message.variables 读写；我们变量按“分支推导 swipe”对齐，写错槽位会改到非当前变体 | 改写后取。中；实机必验 |
| 人物卡：CHARX/CCv3 立绘导入与导出、.dshcard、封面、导出 PNG、宫格视图、同文件复用 | 卡库像样，能分享 | c3828d1c 6d136543 b1a18b5c 2c2fbe70 97c1509d 68e79e6c 49d36eb0；card-assets.js(+271) card-archive.js zip-file.js（PNG 写卡 2530d7ae 2c2fbe70） | 【无冲突】与对话无关 | CHARX/PNG/封面/宫格：取，中。.dshcard 的“卡内插件”不在本报告，见 plugin-api-and-stage.md |
| 存档：单局数据清单+删游戏时清理、导出/导入存档(包 v2、WebP)、ST 聊天批量导入、Markdown 导出带插图 | 能备份/迁移一局；清得干净 | 44c916b2 e1ad06fc 851a0f09 eedd6e92 68ba19b9 c901170e 2b6e0805；game-save.js game-footprint.js chat-import-batch.js save-image-compression.js(WebP 编码，package.json 新增依赖) | 【需适配·中】导出的是“回退检查点修订 + 原生会话”：我们的原生会话含 surface-select 事件，导入端需有同一补丁才能还原；清单要把我们新增的分支登记等产物列进去；WebP 编码依赖（pnpm-lock +31 行）要确认本机能装 | 取。中。导入存档需实机往返验证 |
| 存档：空闲自动整理、按规则瘦身、块包格式 2、分叉历史只留 50 轮、旧档升级 | 长局存档变小变快 | 023ce505 14abd223 b609a1c6 1b320639 cce1e238 | 【随核心】属上游分页存档体系；用户说旧档不迁移 | 暂不取，随 core-conversation 决定 |
| 设置：本局设置做减法(8→4 区)、预设/系统提示词/长期偏好合并为“预设”页、系统提示词多方案、预设包导入导出、顶栏快捷入口自定义、正文排版 | 设置页更清楚，正文字号行距可调 | ce30412f ed406b1b 0100a6a8 0b5ebe4d 5d060841 988e8486；features/settings.js preset-hub.js text-layout.js sidebar-start.js | 【需适配·小】正文排版的 CSS 选择器是 .dsh-tavern-assistant，Story View 同样使用→直接生效；本局设置/重新生成表单与我们 main.js 的 submitBodyRegeneration 同区改动（冲突多但小） | 排版/预设页/顶栏：取，小–中。依赖：客户端布局决定 |
| 渲染深度（只最近 N 轮渲染卡片 HTML，默认 3，其余出“渲染此轮”按钮） | 重美化卡不再卡死 | ffabf965；assistant-renderer.js deferHtml + message-frame.js 按钮 | 【需适配·小】逻辑在 renderTavernProjection 选项里，Story View 调用同一函数；Story View 20 楼一页、加载更多后全部 iframe 常驻，**更需要**；只要在 TavernStoryFloor 里按(最新楼层号−本楼号≥深度)传 deferHtml | 改写后取（优先）。小 |
| 远楼同高占位（≥20 楼且远离视口只留高度）+ 卡片按实测高度占位、保持阅读位置 | 长局上翻不卡、不跳 | be4143e1；useTavernDistantFloor(IntersectionObserver，约 30 行)挂在宿主 TavernAssistantMessage；retained-message-frames.js(+110) 预量高 | 【需适配·中】占位挂点在宿主原生消息组件，Story View 没有；hook 本身与宿主无关，可搬进 TavernStoryFloor；retained-message-frames.js 我们也改过(162 vs 310 行) | 改写后取。中。依赖渲染深度先做；效果需实机量 |
| iframe 只内联近期 48 楼且去掉模板展示产物；主题观察器共享；帧高度单趟测量、纯文字变化不重测 | 重卡内存/卡顿明显下降（上游实测 srcdoc 23.6MB→2.3MB） | 31c6c361 3ba39f0b 970d90e7 b754116b f274e141 a087be28；message-frame-lifecycle.js frame-document.js host-theme.js | 【无冲突·但依赖接线】纯 iframe 内部，与对话页是否原生无关；我们 main.js 里是旧版（e063da72 抹掉了 MB 期同类接线）。“只内联 48 楼”需要“按需读取”通道（getChatMessages 按需） | 取。中。依赖“按需读取”是否已有（实机） |
| 历史窗口按页扩展(120 楼)、开局窗口 | 旧楼滚入视野才加载 | 2a41a763；bounded-history.js、historyWindow 协议 | 【不适用】我们的服务端没有 historyWindow/openingWindow（实测零命中）；Story View 自己按 20 楼分页读取 | 不取 |
| 失败轮“撤回这条输入”、拒答说明、失败错误折叠 | 失败后一键回到本轮开始前 | f42c1b0e e23ea4df；turn-error-controls.js(上游+55，我们已删) | 【冲突·已用别的办法解决大半】我们删了 DOM 错误控件，改由 TavernStoryFailedTurn 展示/重放；“撤回输入”=一次回退，可用现有回退事务实现 | 改写后取（在 TavernStoryFailedTurn 里加按钮）。小–中。依赖 core |
| 重新生成：自动填入上次指导、填了意见则“按意见改写”、合成一个按钮 | 重来更顺手 | d7ed9577 9ef26981 21a2087d；RegenGuideForm | 【需适配·中】表单与我们 submitBodyRegeneration/变体切换同区；“按意见改写”是请求层提示，不写 surface | 改写后取。中。依赖 core 的重生成路径 |

## 4. 推荐先取清单（按 价值/成本 排序；全部【0.1.5可用】）
1. **世界书小包**（全局选择、搜索、快捷面板、冷却、懒挂载）：小，零冲突，用户天天用。
2. **渲染深度**（改写进 Story View，约几十行）：小，重卡玩家立刻有感；顺手加正文排版（988e8486，选择器已适用）。
3. **状态面板一族**：台账（手动版 e6fcb341）、Guide、人物设计档案逐条删、候选面板精简、剧本进度重做：各小，零冲突（文件我们没动）。
4. **iframe 性能三件**（只内联近期楼层、共享主题观察器、帧高度单趟测量）：中，纯 iframe 内部，不涉对话机制；先确认“按需读取”通道。
5. **场景生图整包**：中，服务端文件我们一行没改；客户端 SceneIllustration 已在 Story View 里；先取服务端+设置页，再取重画/补画/画廊/每轮自动生图。
6. **存档管理**（单局数据清单、导出/导入存档、ST 聊天批量导入）：中；导入存档必须实机往返验证。
7. **MVU 工具链**（原地 MVU、转 MVU 工具、变量回灌、卡片工作台新工具）：中，依赖 tools/ 拆分布局（建议同取 7c270f7c 的 tools/ 目录）。
8. **人物卡**（CHARX、封面、PNG、宫格）：中，与对话无关；.dshcard/卡内插件放到插件接口批次。
9. 设置改版、顶栏自定义、预设合并：中，和客户端布局决定绑定，放在拆分布局落地之后。
后取/暂不取：远楼占位（先做渲染深度、实测后再决定）；服务端运行卡脚本与 MVU 变量编辑器（要先对准变体语义）；存档自动整理/块包格式 2（随核心存储决定）；历史窗口按页扩展（不适用）；失败轮“撤回输入”与重新生成表单改版（依赖 core 重生成路径）。

## 5. 42 个两边都改过的源码文件分级（git 三方合并实测；tests 另计）
清单 44 项 = 42 个源码 + lib/client.js（构建产物）+ tavern-plugin/cordis.patch.yml（及根 plugin.patch.yml）。
- **A 自动合并且语义无冲突（git 零冲突，10 个）**：context-planner、conversation-fork-point、conversation-initialization、last-round-replacement、mvu-working-copy、reply-presentation、session-view-sync(lib)、tavern-settings、history-viewport(两边都删)、session-surface-mutations(文本干净，但上游加了按轮游标优化，属核心，合并后须跑 tests/algebra)。我们这边的改动都只是“死代码/逐回合表清理”或一两行加参数，上游改动与之无关。
- **B 一处冲突、可机械解决（约 15 个）**：tavern.css（两边各追加）、cordis.patch.yml、foreground-frame-retirement（我们删文件，上游小改→取我们的删除）、input-fields-projection（我们删了未接线的模块，上游在它上面做了修复→**取决于是否重新接回 indexed-array 一族性能模块**）、turn-error-controls（我们删除，上游加折叠→删除成立，折叠功能按 Story View 重做）、variable-receipts（我们=抹掉 MB 性能接线→取上游）、story-materials（上游删文件、我们改 1 行→按核心报告）、story-timeline（我们 -3 行逐回合表，上游加台账角色→叠加）、foreground-frame-session-adapter（两边各加一段→叠加，注意来源字段写法 kind:'plugin' 对 'plugin:dsh-tavern'，属 0.2.x 语义）、model-request-log、session-stable-prefix、worldbook-read-handoff、worldbook-snapshot（**两边都改了同一段提示语措辞**，产品取舍，见 §6）、host-session-patch 与 plugin.patch.yml（内核相关，见 kernel-0.2.1.md）。
- **C 需看懂再合（2–4 处冲突，约 13 个）**：background-agent-task、import-context-preparation、session-view-reader、assistant-visibility（我们的记账行隐藏 vs 上游的“撤回已存在节点”修复，二者可并存）、session-view-sync(client)、background-surface、foreground-orchestration-strategies、surface-restoration、tavern-helper-context、chat-session-state、regeneration-recovery、template-history、live-tavern-view。共同点：我们这侧是“改走事务/删逐回合表”，上游是“来源字段、锚点、按需读取”，要按 core-conversation.md 的取舍逐函数合。
- **D 必须人工语义合并（7 个）**：body-editor(7)、rollback-surface(8)、round-history(16)、tavern-script-host-adapter(19)、index.js(28)、main.js(单体 13；展开后 79)、lib/client.js(109，重建不手合)。其中 rollback-surface / round-history / body-editor 绝不能取上游整文件（会带回逐回合表）；tavern-script-host-adapter 与产品功能直接相关（服务端脚本、自动采用库内改动）。
- 提醒：上面的“零冲突”只是文本层面；凡涉及 surface 写入的文件，合完都要跑 tests/algebra 与 npm test。

## 6. 必须用户拍板的问题
1. **客户端布局**：(a) 采用上游拆分布局并重放我们约 10 处真改动（倾向，§1）；(b) 保持单体 main.js，每个功能手工翻译。倾向 (a)，理由是后续所有 UI 功能都落在 features/*.js。
2. **MB 期性能接线（indexed-array、帧 sizing、增量 MVU 派发、resourceSync/openingWindow）要不要重新启用**：它们被 e063da72 抹掉只是因为已部署开发树没有，并非设计决定。重新启用意味着采用上游的会话视图读取协议（core 主题）。倾向：先只取纯 iframe 内部的三件（§4 第 4 项），协议部分随核心决定。
3. **世界书快照提示语**：我们改成“【世界书 · 以下设定需要参考和遵守】”，上游改成“【本轮世界书上下文】（仅本轮触发条目）”，两者连语义都不同（全量 vs 增量）。倾向：整体随 core 报告里“请求层”的取舍，不要单独合。
4. **范围**：舞台/配音/卡内插件/对话头像不在本报告（见 plugin-api-and-stage.md）；注意它们挂在宿主 conversation.chat.node 槽，Story View 下不会显示，必须搬进 TavernStoryFloor。是否要这批功能先定，因为它决定 features/ 里哪些文件取。
5. **导出存档的兼容目标**：导入端是否保证也装了 surface-select 补丁？倾向：是（我们自己用），但在包里写明格式版本，导入时检测补丁缺失就拒绝，避免静默丢分支。

## 7. 不确定、需实机验证的点
- Story View 里开渲染深度后，“渲染此轮”按钮点击再渲染单个 iframe 是否正常（eagerFrame 只给最新楼层）。
- 31c6c361“只内联近期 48 楼”依赖的按需读取通道在我们 Helper 传输里是否已有；没有则旧楼卡片脚本读不到数据。
- 生图：切变体后 sceneTarget 的哈希是否真的取到当前变体正文（scene-illustration 读 message.swipes，我们不再写）；每轮自动生图在重新生成/切变体时是否重复出图（计费）。
- MVU 变量编辑器与服务端脚本对“当前变体”的读写槽位。
- 存档导出→导入往返：含 surface-select、分支登记、variantStates 的局能否在新局里还原回退/变体；WebP 依赖在本机可装。
- 展开合并（79 处）只是文本估计；采用上游布局后必须 `build-tavern-client.mjs --check` 与客户端浏览器测试，静态阅读不能代替。
- 上游客户端有 48 个服务端不存在的 RPC，具体哪些随采用的功能一起带，需逐个对表（我只做了名字比对）。
