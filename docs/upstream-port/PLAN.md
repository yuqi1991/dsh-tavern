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
