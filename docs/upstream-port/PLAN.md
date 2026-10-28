# 上游（flizzywine/dsh-tavern main）移植计划

决定日期：2026-10-20。分析报告在 `analysis/`，提交清单在 `analysis/upstream-feat-commits.txt`。

## 路线（用户已定）
1. **分批移植，保持 DSH 0.1.5-rc.2 内核。** 不做 `git merge upstream/main`：它会带回 replaceSessionSurface、
   逐回合隐藏表，并把 cordis/preset 配置换成 0.2.x 格式。内核升级是以后的独立项目（见下）。
2. **客户端采用上游拆分布局**（9dedc0ec，无损搬家），再重放我们约 10 处真改动
   （Story View 槽位注册、变体切换器、轨迹定义、assistant-visibility 记账行隐藏、host-session-patch 安装、
   对 turn-error-controls / history-viewport 的删除）。上游客户端用的 48 个 RPC 我们服务端没有，
   `features/*.js` 必须随对应功能分批引入。
3. **舞台/对话头像/配音/卡内插件先不做**，只记录在下方"暂缓清单"。

## 规则
- 在集成分支 `port/upstream-main` 上做，每批一个或几个提交；基线 = 标签 `pre-origin-merge-20261020`，
  失败清单 `~/dsh-tavern-fork-baseline-pre-origin-merge.txt`（2893 例 / 124 失败，algebra 177/177）。
- 每批完成必须：`node bin/test-tavern.mjs` 失败集合 ⊆ 基线；`node bin/build-tavern-client.mjs --check`；
  `node bin/build-plugin-package.mjs --check`；隔离 e2e（`tests/e2e/gameplay.mjs`）走到与基线相同的位置。
- 凡写 surface 的文件（round-history、rollback-surface、body-editor、story-timeline、session-surface-mutations 等）
  **不取上游整文件**，只把上游当对照物，按功能手工移植。
- `lib/client.js` 是构建产物，禁止手合，合完源码重建。
- 与内核无关、涉及上游实现的新请求层功能，先看 `analysis/core-conversation.md`。

## 批次（按 价值/成本）
- **批 0 客户端布局**：采用拆分布局，构建产物必须与重放后的单体等价；不引入新功能。
- **批 1 零冲突小包**：世界书小包（全局选择/搜索/快捷面板/冷却/懒挂载）；状态面板一族（台账手动版、Guide、人物设计档案逐条删、候选面板精简、剧本进度）；人物卡格式（CHARX/封面/PNG/宫格）。
- **批 2 接进 Story View**：渲染深度（改写进 TavernStoryFloor）+ 正文排版；iframe 性能三件（需先确认"按需读取"通道）。
- **批 3 中等体量**：场景生图整包（先服务端+设置页，再重画/补画/画廊/每轮自动生图，注意切变体不重复出图）；存档管理（单局清单、导出/导入存档，导入端必须检测 select 补丁，需实机往返）；MVU 工具链（原地 MVU、转 MVU、卡片工作台新工具，取 tools/ 布局）。
- **批 4 请求层/核心（按我们的设计改写）**：压缩分卷 + 保留最近 N 轮；历史正文以工具参数回放；
  "操作不得因定位失败被拒绝"（用 select+追加改写，现有拒绝点 round-history.js:85/:543、body-editor.js:79、rollback 的"已不在可回退的消息流中"）；插件接口骨架+读取类+数据媒体（接缝约 150–300 行）。
- **之后再评估**：分页存档（仅当长档确实卡）、服务端运行卡脚本、MVU 变量编辑器（先对准变体语义）、失败轮"撤回输入"与重新生成表单改版。

## 不取
上游对账器/修复原语的实现（依赖已删的 suppressedDshTurns/regeneratedDshTurns 与 replace 写法）；
旧档迁移 cce1e238、f8222828；历史窗口按页扩展（我们没有 historyWindow）；getBackgroundSuppressedTurns 调用点；
surface-restoration（撤销回退保存点，我们用 select）；v4 回合/step 约束修复（0.1.5 无关）。

## 暂缓清单（先记录，以后评估）——演出层与卡内插件
- 舞台（右侧小舞台/全屏、背景音乐、随卡启用）、对话头像（台词标注、情绪换图、点击放大）、角色素材（ST 立绘包导入、castAssetSource）。
- 配音（台词按人物声音朗读；渠道可由插件添加；火山引擎/豆包 V3 渠道代码自包含，可最先单取）。
- 卡内插件（.dshcard 随卡分发；**无沙箱运行**，需先决定安全策略）、导演舞台/大肥鱼示例卡。
- 插件接口后续版本：结算任务（settlementTask/manualTask/replaceSettlement）、versionSignal、publishState/watchState、registerStatusSection/registerTurnView/registerCardListView、cardImporter、skillSource、registerStartGroup、cardRevision。
- 这批功能挂在宿主 conversation.chat.node 槽，Story View 下不显示，必须先搬进 TavernStoryFloor；体量约占插件相关新文件（约 5100 行）的 40%。
- 评估入口：`analysis/plugin-api-and-stage.md`。待拍板：切变体如何通知插件（建议新增 onTimelineChanged kind=variant，不重发 onTurnSettled）；卡内插件取不取；onTurnSettled 去重记录要不要持久化。

## 内核升级到 DSH 0.2.1（暂缓，独立项目）
- 补丁 7 个锚点在 0.2.1-rc.2 真包里仍恰好出现一次，可迁移；必须改：SHA 清单作废（可改"锚点+自检"）、select 分支补 `contentGeneration += 1`、新增 v3-to-v4 包登记 marker、追加导出 JsonlSessionPersistence、token meter shim 从 1 处扩到 4 处。
- 日志格式 v3→v4 单向；会推翻 ADR-0007；ticket 19 不会自然消失（0.2.1 有 3 个新投影静默忽略 select）。
- 换内核必须用另一个目录并行验证，不原地升级；先冻结备份。
- 详见 `analysis/kernel-0.2.1.md`。

## 进度（保持更新）
- **批 0 完成**（2026-10-21）：历史已用 `-s ours` 接上（b269b593）；`main.js` 按上游布局拆成 26 个片段（22290e26，构建产物逐字节相同）；
  片段缩进对齐上游（1efd92ad，记号流经 acorn 校验一致）。此后摘取上游提交基本无需处理缩进冲突。
- **批 1 · 世界书小包 完成**：全局选择（93315f46）、搜索与新旧排序（e5799d01）、条目懒挂载（3755e293）、召回说明（f78a2dd1）、
  目录缓存（ddce9397）、筛选排除后 10 轮冷却（021fcbbd）。完整测试新增失败 0，e2e 与基线一致。
- **世界书里暂缓的**：顶栏快捷面板（2b337649，依赖"顶栏快捷入口可自定义"5d060841 与 features/play-controls.js 的新结构，随顶栏/设置批次取）；
  回复结束后预筛（8bb7fc3a，依赖上游按需读楼层，属存储核心）；进行中游戏自动采用库内改动（3256ffca，依赖 tavern-script-host-adapter 合并）。
- **批 1 · 状态面板一族 完成**（2026-10-21）：
  - 候选面板（a72857b5 等 4 个）：点选追加到输入框、再点移除，`candidateDismissMode` 默认改 after-send；保留我们的“查看后台 Agent”按钮（上游 dbf59ef6 删了）；
    `TAVERN_MOBILE_QUERY` 暂定义在 play-controls.js，移植 mobile-layout 模块后改为引用。
  - 剧本进度（439a00ac/5a433958/1d413050）：新面板每页 7 块；`tests/script-navigation-ui.test.mjs` 按新界面重写（上游把它删了）。
  - 手动台账（e6fcb341/0c8fd3c6/d1985cf2）：整理按钮 + 进度 + 下一轮正文参考一次；未带入 CHARACTER_DESIGN_REUSE_TOOL 与插件上下文测试。
  - Guide（2a5aea0d…228d7047、0e437272 的 MVU 注入）：按最终状态移植 guide-library / conversation-guides / guide-content，Guide 库标签、保存到库、按 id 删除；
    状态面板保持我们的布局，仅加两个按钮；仪表盘样式（b34dd02d）未取。
  - 完整测试：失败 119 条，全部在基线内（基线 124）；e2e 在候选与 Guide 步骤通过，死在 ticket-19 的“金币：40”（与基线一致）。
- **批 1 · 被依赖阻塞，未移植**：
  - 人物设计档案逐条删除（70c0c51e）：依赖“人物设计 → 本局世界书条目”整条链（87c4b25a、83a4ff6b、a0cf6179，约 440 行，且与 5509757f 结算项重构相关）。建议作为独立功能评估。
  - 人物卡格式（CHARX/封面/导出 PNG/宫格/同文件复用）：建立在 cast-assets、card-archive、zip-file、`lib/http/routes.js` 与插件界面层（plugin-extensions）上，属于已暂缓的演出/插件层；随该层一起评估。
  - 结算项重构 5509757f、状态面板仪表盘 b34dd02d：按计划暂缓。
- **批 1 界面冒烟**（2026-10-21，隔离实例 + Chromium，`node tests/e2e/gameplay.mjs --batch1-ui`）：Guide 添加/保存到库/库内修改/加载/删除方案、台账区块与“更新游玩台账”、世界书库标签均通过；
  由此发现并补上遗漏：世界书“如何召回”折叠卡依赖上游通用 `dsh-tavern-help` 样式（已追加，召回说明规则挪到其后）。
  注意：e2e 偶发早期失败（变量结算等待超时/iframe 未就绪），同一代码连跑 3 次稳定通过，视为环境偶发。
- **批 2 · 显示与卡片性能 完成**（2026-10-23）：
  - 渲染深度（6f8a79c8）：设置里"渲染深度"，默认 3；更早的轮次出「渲染此轮」按钮，点了只渲染该轮。
  - 正文排版（916b17ee）：外观里字号/行间距/字间距；正文与气泡跟随 DSH 字号（0.1.5 的主题接口是 `setFontSize(px)`，与上游不同，已适配）。
  - 卡片 iframe 性能（手工移植，cherry-pick 全部冲突）：单次自顶向下测高（970d90e7，a57419c8）；纯文字/纯绘制变动不触发整页测高（b754116b，08c25274，
    并忽略本树仍有的字号适配器临时 `<style data-dsh-tavern-font-measure>`）；全部消息 frame 共用一个宿主主题监听（3ba39f0b，4c55cfa9，只含消息 frame，我们没有 inline-fragment）；
    上下文比对缓存序列化 + 主题读取按帧节流（31c6c361 的 F2/F4 部分，94815555）。
  - **未移植**：31c6c361 的 F1（只内联最近 48 楼、去掉 template_display/template_rendered）——依赖 `historyAccess` 按需读取通道，我们没有；
    且 helper-facade 的 `saveTemplatePatch` 会写回这些字段，无法在无真实卡片的情况下验证安全。a087be28/f274e141（删除"卡片界面跟随 DSH 字号缩放"）是功能删除，等用户决定。
  - 批末检查：完整测试失败名全部在基线内（唯一"新"项是 916b17ee 把 text-layout 的 include 放进了 TavernSettingsSection 与 UserPreferenceProfileTab 之间，
    破坏 conversation-settings-ui 的源码截取；已把 include 前移并给测试补桩，d8e50f83）；负载下偶发 133 帧测试/生图开关测试 30 秒超时，与改动无关。
    `build-tavern-client --check`、`build-plugin-package --check` 通过；e2e `--batch1-ui`、`--render-depth --display-regression` 通过，普通 e2e 仍只死在 ticket-19 "金币：40"。
- **批 3 · 场景生图 完成**（2026-10-24，62b0c341 服务端、3ad04e6c 界面、其后的测试修正）：
  - 服务端：我们从未改过的 `dsh-image-gen` 包与 `lib/domain/scene-*` 整组取上游最终状态（构建产物的 import 与旧版完全一致，不依赖 DSH 0.2）；
    `lib/index.js` 手工接线：每局/全局默认的"生图 Agent 模型"（`imageModelSelection`/`defaultImageModel`，默认跟随前台并用最低推理强度）、
    新 RPC（testSceneImageGeneration、listSceneImageHistory、removeSceneImageHistory、getImageAgentUndo、undoImageAgentTurn）、
    画师串预览与画廊读图两条 GET 路由、生图请求体上限 16KB→256KB、结算后自动生图（默认关，`auto-<key>` 请求号去重，已有图/删过图/失败/疑似已计费都不自动重画）、
    场景世界书快照按轮登记（只留最近 50 轮）、分叉复制引用、删游戏时释放。同时取了 `profile-data-store.js`（新增 list）与 `conversation-background.js`。
  - 界面：`SceneIllustration`（重画/同方案重画/改提示词/新增插图/造型参考）、`SceneImageGallery`（对话区"画廊"标签）、`SceneImageSettings` 独立成设置页"场景生图"、
    每轮操作栏图标生图（输入框上方的按钮取消）、本局设置里的"生图 Agent 模型"。Story View 在正文下接主图和同轮新增的图。
  - **行为变化（需告知用户）**：`场景生图`改为**全局开关**（默认关，配置完整后才能开）；旧版的"每局开启场景生图"开关取消。已配好生图的老用户升级后要去 设置 → 场景生图 打开一次。
    同轮新增的插图暂时排在正文后面（上游按段落锚定，依赖插件文本管线，未取）。
  - 测试：生图相关的 6 个测试文件和 `tavern-settings-browser` 夹具换成上游版本（旧测试断言的是上游已删除的行为，如固定画风预设；其中一个会因此永远等待）；
    每局开关测试文件删除；字节上限、批量删除、输入框快照、本局设置界面测试按新行为更新。上游新的 native 夹具依赖 DSH 0.2 的包，保留我们的。
    完整测试失败名全部在基线内；e2e `--batch3-images` 通过（设置页、画廊标签、本局模型选择）。
  - **未做**：真实生图渠道的端到端（需要用户的 API Key），只验证了界面与服务端单测。批 3 剩余：MVU 工具链。

- **批 3 · 存档管理 完成**（2026-10-25）：
  - 服务端：`.dshsave`（ZIP，格式 v2）导出/导入（`game-save*.js`、`zip-entries.js`、`save-image-compression.js`），单局数据清单 `game-footprint.js`（导出按它打包，删除按它清理），RPC `exportGameSave` / `importGameSave`；导入永远生成新游戏（新对话/会话编号、重建原生会话、重编号历史，失败回滚）。
    `file-resources.js` 增加同名卡/剧本隔离导入（`unique`）与 `originalCardPayload`；`background-agent-sessions.js` 增加 `releaseFor`。
  - 界面：导出菜单加"存档"，选择人物卡页加"导入存档"（SillyTavern 聊天记录仍在选卡后导入）。
  - 我们的取舍：不含插件数据（舞台/头像/TTS 层未移植）；存档含 `dsh-tavern/surface-select` 事件时，会话补丁未生效则拒绝导入；预设沿用我们的 `tavern` 预设挂载（`tavernPresetSetup`）。
  - **行为变化（需告知用户）**：删除游戏现在会真正删除原生会话和各类日志/缓存（以前只归档）。DSH 仍加载着的会话（刚用过的）延后到下次启动清理（`pending-session-deletions.json`，含它们的缓存与日志），所以删完后磁盘上会暂留到重启。
  - **未装**：WebP 压缩需要 `@jsquash/{jpeg,png,webp}`。`package.json` 未加依赖（dev 的 `node_modules` 是指向已部署安装的软链，pnpm 会改动线上依赖，故没动）；缺依赖时存档里图片保持原样，不影响功能。部署时如要压缩，需先在已部署的插件目录安装这三个包（已在临时目录验证压缩可用）。
  - 测试：上游 7 个存档测试（往返夹具去掉我们没有的"绑定剧本"部分、版本号读本仓库）；批量删除测试补清理断言；e2e `--batch3-saves` 在真实 DSH+浏览器+固定模型上通过（连跑 4 次）：打两轮→重新生成→切变体→回退→界面导出两份→界面导入（原游戏不受影响、变体数一致、无原编号残留）→继续/切变体/回退/重新生成→分叉→同一份存档再导入→本机无人物卡时从存档带回→界面删除导入和分叉的游戏→磁盘按名字/内容扫描无残留（含重启后清掉排队的会话）。
  - **顺带发现（早已存在，非本次引入）**：有两个变体的那一轮之后再玩一轮再回退，上一轮的变体计数变成 3/3（多出被回退线）；在存档前的 HEAD 上同样复现。是否与已部署版本一致未核对。

- **批 3 · MVU 工具链（第一段，2026-10-26）**：
  - 已取（小而独立）：c7460255、a3b5943a（脚本型原状态栏协议适配）、d219c680、63ae6e6c、a51ad3b0、a15ec319、95949fc0、de1a6241、7a0c0278、969f001e；8d74ba4d（官方 MVU 固定产物整目录取上游终态，带入 431da10c 的无语义改动，产物字节数同步）。
  - 变量回灌前台（974f53a8、db4bc409、5a8471f3、f3e0dbce）手工移植：上游 `hooks/request.js` 在我们这里不存在，钩子并入 index.js 的 agent/pre-step；e2e 确认第二轮会话里有"【上一轮变量变化】"行，存档往返/回退/重新生成照常。b3569d55 不需要（我们的回退把插件行一律当上下文）。
  - 不取：8d84a002（依赖 `installBackgroundModel`/额外模型解析代理，我们没有这套）、f7ef2b4a（我们没有 `runtime-preset-front` 区段，内核 0.1.5 也无 `interpolate`）。
  - **卡住的原因**：我们没有上游的 `lib/tools/` 拆分（工具定义内联在 index.js 约 5000 行之后），卡片工作台的新工具（tavern_search_card / tavern_replace_card_text / 校验预设与世界书）、原地 MVU、`ee728107`（用"直接编辑+格式校验"取代草稿/定义/指纹体系，净删约 3600 行）都碰这块，无法直接摘取。需要先定做法：①在现有布局里按行为手工移植、暂留草稿体系；②先把工具定义拆成 `tools/` 再摘取；③暂缓。

- **批 3 · MVU 工具链（第二段，2026-10-27，用户选定"按行为手工移植、暂留草稿体系"）**：
  - 已加：`tavern_search_card`（全卡搜文字）、`tavern_replace_card_text`（全卡批量替换，可限定位置/预期处数，保存后报告剩余并附格式校验）、`tavern_validate_card` 支持预设和世界书文件、人物卡校验新增 MVU 格式检查（`mvu-card-check.js`：开场 initvar 能否解析、字段一致、[mvu_update] 规则、状态入口与面板正则、面板脚本语法等，只报告不执行）。对应上游 3108bd9e、08f3ec10、00e37c7d 以及 ee728107 里"新增"的那一半。
  - 布局：工具定义放进新目录 `lib/tools/`（`card-reading.js`、`card-editing.js`、`card-validation-check.js`，签名与上游一致，测试直接取上游的）；`index.js` 只调注册函数。`saveChanges` 增加可选 `path`（改指定卡）。
  - 没做（有意）：删草稿/转换/指纹体系（ee728107 删除的那一半）；上游"直接改文件"的 skill 改写；`tavern_update_preset/worldbook` 描述里"仅在用户明确确认后"改成"按用户要求"（产品策略变化，没用户同意不改）；署名（card-credit）。
  - 验证：上游 3 个新测试 + 我们的转换/草稿测试全过；e2e `--card-memory` 里真实卡片工作台模型请求的工具表含新工具且 `tavern_read_card` 仍在（中途发现过一次误删 `tavern_read_card`，已恢复并核对：原先每个工具名都还在）；完整测试失败名 ⊆ 基线。
  - 部署注意：新增目录 `tavern-plugin/lib/tools/` 要进白名单复制。

- **批 4 · 第一段：压缩稳健性（2026-10-27）**：
  - `request-lineage`（上游 30c12746 + cf0d795e，手工）：前台投影（兼容/原生）、指令呈现、压缩分段、故事压缩、完整模板、导入上下文准备统一用"带 Symbol 标记的拷贝"识别自己产出的请求，替换对象同一性的 WeakSet，消除投影与指令过滤互相重发的风险（上游 #146 曾 OOM；#148 宿主冻结请求写标记失败）。
  - 摘要只返回工具调用/空内容时，无工具、纯文本重试一次（b5d04832）；失败提示附最内层原因（db1ed45a）；智谱 1261 识别为超窗口并让重试限流器让位于压缩（79445692，钩子接在 index.js）。
  - 验证：相关单测；真实 DSH e2e `--compaction=manual/overflow/rounds` 通过。
  - **未取**：7b5c2d28（两个 llm/stream 钩子合并，与保留最近 N 轮一起做）。
  - **评估结论（勘察，未动手）**：
    - 保留最近 N 轮原文（87b94a5b/377f70cf/68dff3dd）：内核 0.1.5 可行（多文本块摘要已核对），但保留的楼层是"文本并入检查点"，不是真实节点，select 无法再引用——被压进检查点的楼层会不能回退/重生成/切变体（`rollback-surface.js` 遇检查点返回 null）。需先定："已压缩楼层标为不可回退"并让楼层投影识别。
    - 分卷摘要/提示词（0eb28243、0b8206e8、d54395d9、e8145dd0、57104435）：依赖保留 N 轮的管道，排在其后。
    - 周边：09701afe（模板同步不改写压缩检查点，#202，我们大概率也有）、851fc159（压缩提示可关）、d8806e18/0d3cc56f（未打开的游戏也能压缩）、f3945537（删旧协调器）可独立小做。
    - 历史正文以工具参数回放（1133ecbd 等，约 100 行）：逻辑不依赖 0.2 内核，但上游实测前提是"契约里声明了 submit_story 工具"，我们没有 E1；不声明工具模型可能模仿调用不存在的工具；DeepSeek 思考模式补 reasoning 与回放的顺序有冲突风险。需先实测或决定是否做最小工具声明。
    - 操作不得因定位失败被拒绝：拒绝点 round-history.js:85/:543、body-editor.js:79、rollback-surface.js:397；做法是"存档为准 → 纯规划找最长一致前缀 → append 缺失节点 → 一次 select"，约 250–350 行 + 4 个接线点；撤销回退（`canUndoRollback`）与压缩覆盖轮次需设计。
    - 插件接口：现装没有任何插件；最小接缝约 250–350 行，建议先写 hello 插件实测加载方式/归属识别再定，近期不装上游插件就整体推迟。

- **批 4 · 定位失败修复：复核后暂不做（2026-10-27）**：
  - 复核发现真正会拒绝的场景很窄：压缩后、下一轮还没打之前（0.1.5 立即压缩只原样保留最后一条消息，此时 `locateRollbackSurface` 遇到检查点返回 null，"回退"不可用，打一轮新的就恢复）。其余拒绝点对应存档与原生会话已经不一致，拒绝是安全的。
  - 要"存档优先"地放行，回退/重新生成/编辑正文都要改动 `algebraHistory.prepare/recover`、撤销回退、楼层投影的事务路径；并且压缩后被保留的最后一条原文仍在消息面上，只改存档不改 select，模型还会看到被回退的回复。风险大、证据弱，现有测试明确断言"拒绝"（round-history.test.mjs:130/:644）。
  - 同理 09701afe（模板同步改写压缩检查点，#202）不适用：我们的模板同步只按精确文字匹配，没有轮次锚点，摘要文字不会等于玩家原文。
  - 若以后在真实使用里遇到"存档报废"，再带着具体现场重开这一项。

- **stage 验收（2026-10-28）**：用户在 stage 上验收批 1–4 现有改动，MVU 结算、回退、切换变体及其他功能均正常。
  - 验收中发现的问题：stage 的运行时是独立副本，`defaultHostRequire` 原来只能解析到插件旁边（生产）的宿主包，与正在运行的会话存储不是同一份，会话补丁没装上，导致后台历史回退被宿主原版校验拒绝（"assistant/message embeds its source stream…"）。修复：`bin/dsh` 符号链接按真实路径查找（bfa971a7，带测试）。生产布局下不受影响。
  - 同时保留了两项诊断：后台历史回退失败时错误信息带原因、日志输出堆栈（7f10021d 等）。
  - 以后在 stage 上验证任何依赖会话补丁的功能前，先确认补丁已装上（`getSessionPatchStatus`）。

## 摘取流程（每个提交）
1. `git cherry-pick -x --no-commit <hash>`；2. `lib/client.js` 冲突不手合，`node bin/build-tavern-client.mjs` 重建；
3. `tavern.css` 末尾追加冲突：保留我们的 Story View 规则，再追加该提交自己的新增行；
4. 提交带来的与功能无关的文档/不属于本批的文件丢弃，并在提交信息里写明；5. 跑该提交的测试与相关测试，批末跑完整 `node bin/test-tavern.mjs` 与基线逐条比对、e2e。
- 注意：自动解决冲突的脚本必须"先读后写"并加长度保护（曾因先 open('w') 清空文件而差点提交空文件）。
