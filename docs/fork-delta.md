# fork-delta：我们与上游的差异清单

## 原则

1. **我们独有的逻辑放进我们自己的文件**（如 `tavern-plugin/lib/domain/conversation-algebra/*`、`tests/algebra/*`），共享文件（上游也有的文件）里只留“薄挂钩”：一行 import、一个注册调用、一个可选参数。
2. 每次同步上游前，先对照本清单：上游这次动了清单里的哪些共享文件，这些文件就是冲突热点（`bin/upstream-ledger.mjs pending` 的 `shared` 列就是按本清单统计的）。
3. 新增功能时先问：能不能放进新文件、只在共享文件里加一行挂钩？不能时，在这里登记原因。
4. 生成文件（`tavern-plugin/lib/client.js`、`plugin.patch.yml`、`docs/index.html`、`pnpm-lock.yaml`、各包构建产物）不计入共享文件：冲突时重建，见 `docs/upstream-port/SYNC-PLAYBOOK.md` 与 `bin/regen.sh`。

## 怎么生成

```
node bin/fork-delta.mjs          # 终端摘要
node bin/fork-delta.mjs --md     # 下面“自动清单”的来源
```

“共享文件”的判据：两边都有、内容不同、且 `5ae0c1f5..HEAD`（旧基点至今）我们动过；排除生成文件与 `tests/`。
行数是 `git diff --numstat upstream/main HEAD`，**包含上游在我们之后又改的部分**，所以“-行”很大不等于我们删了东西（例如 `install.ps1` 我们只改了 7 行，其余是上游后来的重写）。“我们的提交数”才反映我们自己的改动频度。
生成时间：2026-10-31，对照 `upstream/main` = 84bf905c。

## 人工分析：共享文件 top 25（为什么改、能否改成薄挂钩）

依据是 `git log 5ae0c1f5..HEAD --not upstream/main -- <文件>` 的提交标题与文件现状；标“待查”的是没有读透、不下结论的。

| # | 文件 | 为什么改 | 能否改成薄挂钩 |
|---|---|---|---|
| 1 | `tavern-plugin/lib/index.js` | 51 个我们的提交：会话代数（algebra）接线、压缩保留 N 轮/分卷、查原文、回退/重新生成恢复、诊断、场景生图 RPC、MVU 回灌、存档导入导出的 RPC 注册。我们的 index.js 5716 行，上游已拆成 3829 行 + `lib/tools/`、`lib/hooks/`、`lib/http/` | 部分可以。上游已有的 `hooks/`、`tools/` 拆分是同样方向；我们新增的 RPC/钩子应各放新文件，index.js 只留注册调用。拆分本身会让下次合并这一个文件的冲突最大，建议单独一批做，且在做之前不要让 index.js 再长。 |
| 2 | `tavern-plugin/lib/client-assets/tavern.css` | 18 个提交：Story View 样式、手机布局链、场景生图界面、正文排版。多数是“末尾追加” | 可以。我们的规则放进新样式文件（构建时拼入），tavern.css 不再追加。需要先看构建脚本如何装配 css（`bin/build-tavern-client.mjs` 读取该文件）——待查是否支持多文件。 |
| 3 | `tavern-plugin/src/client/features/play-controls.js` | 14 个提交：预设合并页、本局设置 4 分区、手机布局快捷入口、重新生成按意见改写、变量回灌开关、存档导出菜单、场景生图入口 | 部分可以。设置分区、预设页可拆成独立 feature 文件；顶栏/操作栏的入口只加挂钩。待查哪些是跟着上游设置改版链（ce30412f 等）走的，哪些是我们独有。 |
| 4 | `install.ps1` | 只有 1 个提交、7 行：安装文件清单里加了 `host-compatibility.js`。diff 的大头是上游后来的重写 | 不需要。下次同步直接取上游版本，再把清单那一项补回（或确认上游已有）。 |
| 5 | `tavern-plugin/lib/domain/round-history.js` | 27 个提交：楼层按位置定位而非轮次号、重新生成恢复点、v4 日志适配、algebra 的事务路径、定位失败诊断 | 难。属于会话写入核心，上游与我们的写法分叉（ADR-0008/0009）。algebra 已在 `lib/domain/conversation-algebra/`，应继续把逻辑往那边收，round-history 只调用。 |
| 6 | `tavern-plugin/src/client/main.js` | 29 个提交：已是 `// @include` 片段模板；改动是 0.2 宿主适配（主视图认对话、会话就绪判据、子代理目录同步）、预设页/设置/手机布局的 include 位置 | 可以。适配类改动应放进 `runtime/` 下独立片段，main.js 只增 include 行。 |
| 7 | `tavern-plugin/src/client/features/assistant-renderer.js` | 5 个提交：0.2.0 会话 API 兼容垫层、场景生图插图挂载、原生 #send_textarea 选项填入 | 可以：兼容垫层和输入框桥放独立文件，这里只留调用。 |
| 8 | `tavern-plugin/lib/domain/rollback-surface.js` | 10 个提交：v4 producer kind、编辑步骤正文记住原轮次、algebra 回退、定位按位置 | 同 #5：逻辑往 conversation-algebra 收，这里只留委托。 |
| 9 | `tavern-plugin/lib/domain/scene-illustration.js` | 1 个提交：场景生图服务端整包按当时上游终态取入。+672 行是因为**上游之后“删除原生场景生图的后端生成链路”（82fd3a85）并把生图交给插件接口**——我们保留了原生链路 | 不是挂钩问题，是产品分叉：下次同步必须先决定是否跟随上游改为插件接口，或继续自己维护这条链。需要使用者拍板。 |
| 10 | `tavern-plugin/lib/domain/tavern-script-host-adapter.js` | 5 个提交：撤销回退点的渲染簿记判定、结算期间脚本写入并入结算、按分支推导变体对齐 MVU 状态（含 merge b3c4b5d7，保留 fork 的快路径） | 部分。簿记判定可抽成纯函数文件；“快路径”与上游路径并存，待查能否合并。 |
| 11 | `tavern-plugin/src/client/features/sidebar.js` | 12 个提交：0.2 宿主适配（主视图/会话列表基线/就绪判据）、预设页、手机布局、导入选择器 | 适配部分可以放兼容垫层文件；其余待查。 |
| 12 | `tavern-plugin/lib/domain/file-resources.js` | 3 个提交：同名卡/剧本隔离导入（存档导入）、原地 MVU、全局世界书选择 | 可以：存档与 inPlace 逻辑放新文件，这里加导出。待查与上游当前版本的差距（+386）有多少是上游后续改动。 |
| 13 | `tavern-plugin/src/client/features/scene-images.js` | 3 个提交：场景生图界面按当时上游终态取入。差异同 #9（上游之后改为插件接口） | 同 #9，先定产品方向。 |
| 14 | `tavern-plugin/lib/domain/foreground-orchestration-strategies.js` | 5 个提交：algebra 阶段 0、v4 producer kind、llm/stream 重发钩子按请求血缘去重、种子轨迹自定义与 StoryMaterials 注入（本地改动） | 种子轨迹/StoryMaterials 属我们独有功能，应放新文件；其余随 algebra。待查具体行。 |
| 15 | `tavern-plugin/src/client/legacy-composer.js` | 2 个提交：原生 #send_textarea 选项填入 DSH 输入框、jQuery trigger('input') 兼容。上游之后重做了宿主输入框（-316 多是上游改动） | 可以：输入框桥放新文件；待查上游新版是否已自带。 |
| 16 | `tavern-plugin/lib/domain/turn-orchestration.js` | 5 个提交：转 MVU 工具、卡片工作台工具、场景生图结算后自动生图、手动台账、内置默认 MVU 状态面板 | 可以：每个都是“注册一个工具/任务”，应放 `lib/tools/`（该目录我们已有）。 |
| 17 | `tavern-plugin/lib/domain/body-editor.js` | 5 个提交：algebra 编辑正文第二阶段迁移、按位置定位、定位诊断 | 同 #5。 |
| 18 | `tavern-plugin/lib/domain/tavern-settings.js` | 11 个提交：retainRounds、预设/提示词方案、顶栏快捷入口、进入游戏打开酒馆状态、变量回灌、场景生图设置 | 部分可以：每项设置的默认值/校验放各自文件，这里只合并 schema。设置模式文件天然是共享热点，待查是否可由注册表组合。 |
| 19 | `tavern-plugin/lib/domain/story-compaction.js` | 4 个提交：保留最近 N 轮、分卷摘要、查原文提示、v4 压缩检查点识别 | 我们独有设计（上游是另一条实现，PLAN.md 批 4）；分卷/保留 N 轮的纯函数可拆新文件。 |
| 20 | `tavern-plugin/src/client/runtime/message-frame-lifecycle.js` | 5 个提交：手工移植的 iframe 性能补丁、输入框桥 | 待查：上游后续是否改了同处；iframe 性能部分本就来自上游。 |
| 21 | `tavern-plugin/lib/domain/foreground-worldbook.js` | 1 个提交：被筛掉的条目 10 轮冷却（取自上游）。上游之后“退役后台世界书召回管线”（-190 多来自此） | 待查：上游已退役该管线，下次同步要决定跟随与否。 |
| 22 | `tavern-plugin/src/client/features/text-layout.js` | 1 个提交：正文排版（取自上游，适配 0.1.5 的 setFontSize）。差异来自上游后续迭代 | 待查是否可直接取上游版本。 |
| 23 | `tavern-plugin/lib/domain/play-card-snapshots.js` | 1 个提交、2 行：场景生图相关。-218 是上游后续改动 | 随 #9 决定。 |
| 24 | `tavern-plugin/lib/domain/regeneration-recovery.js` | 9 个提交：algebra 重新生成（预切分支+checkout）、恢复点、日志落盘缺失处理 | 我们独有的恢复逻辑，应并入 conversation-algebra 目录，这里只留委托。 |
| 25 | `tavern-plugin/src/client/features/settings.js` | 提交标题显示：retainRounds 设置项、本局设置 4 分区、顶栏快捷入口、渲染深度、候选面板（多数取自上游，之后上游继续迭代） | 待查：哪些仍是我们独有；retainRounds 一项可单独放进新设置片段。 |

## 自动清单（`node bin/fork-delta.mjs --md` 生成，2026-10-31）

### 我们独有的新文件（共 926 个，目录级聚合）

| 路径 | 文件数 |
|---|---|
| `docs/research/*` | 172 |
| `docs/images/manual/*` | 96 |
| `tests/algebra/*` | 50 |
| `tavern-plugin/packages/dsh-image-gen/src/*` | 40 |
| `docs/design/conversation-algebra-phase1-evidence/*` | 23 |
| `docs/verification/*` | 19 |
| `packaging/*` | 18 |
| `tavern-plugin/packages/dsh-image-gen/tests/*` | 18 |
| `docs/experiments/*` | 13 |
| `tavern-plugin/packages/dsh-better-sidebar/*` | 11 |
| `docs/manual/*` | 7 |
| `docs/upstream-port/*` | 7 |
| `tavern-plugin/packages/dsh-image-gen/docs/*` | 6 |
| `docs/examples/manual-demo/*` | 5 |
| `tavern-plugin/lib/domain/conversation-algebra/*` | 5 |
| `tests/`（零散单文件） | 132 |
| `tavern-plugin/lib/vendor/`（零散单文件） | 105 |
| `tavern-plugin/lib/domain/`（零散单文件） | 68 |
| `tests/fixtures/`（零散单文件） | 44 |
| `tavern-plugin/packages/dsh-image-gen/`（零散单文件） | 16 |
| `docs/design/`（零散单文件） | 15 |
| `bin/`（零散单文件） | 8 |
| `tests/e2e/`（零散单文件） | 8 |
| `docs/`（零散单文件） | 7 |
| `tavern-plugin/prompts/`（零散单文件） | 7 |
| `docs/assets/`（零散单文件） | 6 |
| `.github/workflows/`（零散单文件） | 3 |
| `presets/tavern/skills/`（零散单文件） | 3 |
| `tavern-plugin/src/client/`（零散单文件） | 3 |
| `(根)/`（零散单文件） | 2 |
| `config/`（零散单文件） | 2 |
| `docs/adr/`（零散单文件） | 2 |
| `claude/`（零散单文件） | 1 |
| `docs/images/readme/`（零散单文件） | 1 |
| `patches/`（零散单文件） | 1 |
| `references/`（零散单文件） | 1 |
| `tavern-plugin/lib/`（零散单文件） | 1 |

### 共享文件（共 153 个；按改动行数排序）

| # | 文件 | +行 | -行 | 我们的提交数 |
|---|---|---|---|---|
| 1 | `tavern-plugin/lib/index.js` | 3995 | 2108 | 51 |
| 2 | `tavern-plugin/lib/client-assets/tavern.css` | 148 | 1868 | 18 |
| 3 | `tavern-plugin/src/client/features/play-controls.js` | 984 | 619 | 14 |
| 4 | `install.ps1` | 128 | 1440 | 1 |
| 5 | `tavern-plugin/lib/domain/round-history.js` | 400 | 844 | 27 |
| 6 | `tavern-plugin/src/client/main.js` | 255 | 555 | 29 |
| 7 | `tavern-plugin/src/client/features/assistant-renderer.js` | 201 | 582 | 5 |
| 8 | `tavern-plugin/lib/domain/rollback-surface.js` | 179 | 583 | 10 |
| 9 | `tavern-plugin/lib/domain/scene-illustration.js` | 672 | 24 | 1 |
| 10 | `tavern-plugin/lib/domain/tavern-script-host-adapter.js` | 419 | 194 | 5 |
| 11 | `tavern-plugin/src/client/features/sidebar.js` | 255 | 257 | 12 |
| 12 | `tavern-plugin/lib/domain/file-resources.js` | 386 | 116 | 3 |
| 13 | `tavern-plugin/src/client/features/scene-images.js` | 392 | 47 | 3 |
| 14 | `tavern-plugin/lib/domain/foreground-orchestration-strategies.js` | 138 | 260 | 5 |
| 15 | `tavern-plugin/src/client/legacy-composer.js` | 78 | 316 | 2 |
| 16 | `tavern-plugin/lib/domain/turn-orchestration.js` | 103 | 270 | 5 |
| 17 | `tavern-plugin/lib/domain/body-editor.js` | 49 | 272 | 5 |
| 18 | `tavern-plugin/lib/domain/tavern-settings.js` | 64 | 242 | 11 |
| 19 | `tavern-plugin/lib/domain/story-compaction.js` | 166 | 139 | 4 |
| 20 | `tavern-plugin/src/client/runtime/message-frame-lifecycle.js` | 54 | 233 | 5 |
| 21 | `tavern-plugin/lib/domain/foreground-worldbook.js` | 85 | 190 | 1 |
| 22 | `tavern-plugin/src/client/features/text-layout.js` | 98 | 161 | 1 |
| 23 | `tavern-plugin/lib/domain/play-card-snapshots.js` | 30 | 218 | 1 |
| 24 | `tavern-plugin/lib/domain/regeneration-recovery.js` | 112 | 136 | 9 |
| 25 | `tavern-plugin/src/client/features/settings.js` | 51 | 187 | 7 |
| 26 | `tavern-plugin/src/client/runtime/helper-bootstrap.js` | 99 | 139 | 3 |
| 27 | `tavern-plugin/src/client/runtime/helper-script-runtime.js` | 29 | 209 | 3 |
| 28 | `README.md` | 86 | 149 | 1 |
| 29 | `tavern-plugin/src/client/ui/message-frame.js` | 44 | 184 | 4 |
| 30 | `tavern-plugin/src/client/runtime/frame-document.js` | 120 | 103 | 5 |
| 31 | `tavern-plugin/lib/domain/opening-preparation.js` | 44 | 169 | 1 |
| 32 | `tavern-plugin/src/client/runtime/helper-host.js` | 28 | 175 | 2 |
| 33 | `tavern-plugin/lib/background-agent-task.js` | 71 | 128 | 10 |
| 34 | `tavern-plugin/lib/domain/conversation-initialization.js` | 80 | 104 | 5 |
| 35 | `tavern-plugin/src/client/runtime/helper-facade.js` | 34 | 143 | 2 |
| 36 | `tavern-plugin/lib/domain/chat-session-state.js` | 23 | 137 | 5 |
| 37 | `tavern-plugin/src/client/features/guide-library.js` | 78 | 78 | 1 |
| 38 | `tavern-plugin/lib/domain/history-recall.js` | 98 | 47 | 1 |
| 39 | `tavern-plugin/src/client/modules/live-tavern-view.js` | 84 | 57 | 2 |
| 40 | `tavern-plugin/lib/domain/model-request-log.js` | 34 | 106 | 1 |
| 41 | `tavern-plugin/lib/domain/template-history.js` | 50 | 89 | 3 |
| 42 | `tavern-plugin/lib/tools/card-reading.js` | 4 | 132 | 1 |
| 43 | `tavern-plugin/src/client/runtime/host-artifacts.js` | 36 | 98 | 4 |
| 44 | `tavern-plugin/src/client/features/card-library.js` | 65 | 66 | 2 |
| 45 | `tavern-plugin/src/client/features/card-list.js` | 14 | 117 | 2 |
| 46 | `tavern-plugin/src/client/modules/global-settings.js` | 17 | 112 | 1 |
| 47 | `tavern-plugin/lib/tools/card-editing.js` | 5 | 120 | 2 |
| 48 | `tavern-plugin/lib/domain/tavern-helper-context.js` | 49 | 75 | 3 |
| 49 | `tavern-plugin/lib/domain/candidate-generation.js` | 71 | 36 | 1 |
| 50 | `tavern-plugin/src/client/modules/session-view-sync.js` | 14 | 92 | 1 |
| 51 | `tavern-plugin/lib/domain/session-view-reader.js` | 19 | 83 | 1 |
| 52 | `tavern-plugin/lib/domain/background-surface.js` | 21 | 80 | 2 |
| 53 | `tavern-plugin/lib/domain/surface-restoration.js` | 39 | 57 | 2 |
| 54 | `presets/tavern/skills/card-to-mvu/SKILL.md` | 72 | 6 | 4 |
| 55 | `tavern-plugin/lib/background-agent-sessions.js` | 25 | 53 | 4 |
| 56 | `tavern-plugin/lib/domain/worldbook-library.js` | 11 | 67 | 3 |
| 57 | `tavern-plugin/lib/domain/worldbook-recall.js` | 20 | 58 | 2 |
| 58 | `tavern-plugin/lib/domain/mvu-background-settlement.js` | 5 | 72 | 7 |
| 59 | `tavern-plugin/lib/domain/foreground-frame-session-adapter.js` | 23 | 48 | 2 |
| 60 | `tavern-plugin/lib/prompt-catalog.js` | 13 | 56 | 2 |
| 61 | `tavern-plugin/src/client/features/worldbook-library.js` | 24 | 42 | 6 |
| 62 | `tavern-plugin/lib/domain/auto-compaction.js` | 40 | 25 | 1 |
| 63 | `CONTEXT.md` | 16 | 46 | 2 |
| 64 | `tavern-plugin/lib/domain/session-surface-mutations.js` | 44 | 17 | 4 |
| 65 | `tavern-plugin/lib/domain/story-timeline.js` | 13 | 47 | 2 |
| 66 | `tavern-plugin/src/client/variable-receipts.js` | 2 | 55 | 1 |
| 67 | `tavern-plugin/src/client/features/preset-library.js` | 23 | 33 | 3 |
| 68 | `tavern-plugin/lib/domain/skill-visibility.js` | 20 | 35 | 1 |
| 69 | `tavern-plugin/src/client/features/request-context.js` | 23 | 31 | 2 |
| 70 | `presets/tavern/skills/edit-card/SKILL.md` | 31 | 21 | 4 |
| 71 | `tavern-plugin/lib/domain/manual-ledger.js` | 21 | 31 | 1 |
| 72 | `tavern-plugin/lib/domain/compaction-request.js` | 23 | 28 | 4 |
| 73 | `tavern-plugin/src/client/modules/host-session-patch.js` | 51 | 0 | 1 |
| 74 | `tavern-plugin/lib/domain/runtime-preset-lifecycle.js` | 19 | 29 | 1 |
| 75 | `tavern-plugin/lib/domain/host-compatibility.js` | 8 | 38 | 1 |
| 76 | `tavern-plugin/packages/dsh-tavern-card-memory/index.js` | 17 | 29 | 1 |
| 77 | `package.json` | 34 | 10 | 1 |
| 78 | `tavern-plugin/prompts/story-compaction.md` | 26 | 18 | 1 |
| 79 | `tavern-plugin/src/client/runtime/helper-loader.js` | 25 | 19 | 2 |
| 80 | `AGENTS.md` | 2 | 41 | 1 |
| 81 | `tavern-plugin/lib/domain/background-session-retirement.js` | 0 | 43 | 1 |
| 82 | `tavern-plugin/lib/domain/session-stable-prefix.js` | 22 | 21 | 3 |
| 83 | `tavern-plugin/src/client/features/skills.js` | 12 | 31 | 2 |
| 84 | `tavern-plugin/src/client/features/user-profile.js` | 31 | 8 | 3 |
| 85 | `tavern-plugin/lib/domain/story-ledger.js` | 5 | 33 | 1 |
| 86 | `tavern-plugin/lib/domain/game-footprint.js` | 10 | 26 | 1 |
| 87 | `tavern-plugin/lib/domain/worldbook-recall-log.js` | 2 | 32 | 1 |
| 88 | `tavern-plugin/lib/domain/last-round-replacement.js` | 22 | 11 | 2 |
| 89 | `tavern-plugin/lib/domain/context-planner.js` | 8 | 24 | 1 |
| 90 | `tavern-plugin/lib/domain/worldbook-activation.js` | 21 | 11 | 1 |
| 91 | `docs/features.txt` | 13 | 18 | 1 |
| 92 | `tavern-plugin/lib/domain/host-session-patch.js` | 25 | 6 | 4 |
| 93 | `tavern-plugin/src/client/runtime/script-execution.js` | 8 | 23 | 4 |
| 94 | `tavern-plugin/lib/domain/tavern-helper-worldbook.js` | 0 | 30 | 1 |
| 95 | `tavern-plugin/src/client/card-organization.js` | 14 | 16 | 1 |
| 96 | `tavern-plugin/src/client/modules/assistant-visibility.js` | 17 | 12 | 2 |
| 97 | `tavern-plugin/lib/domain/session-seed-trajectory.js` | 20 | 7 | 3 |
| 98 | `tavern-plugin/package.json` | 11 | 16 | 2 |
| 99 | `tavern-plugin/lib/domain/conversation-background.js` | 14 | 12 | 1 |
| 100 | `patches/dsh-web-mobile@3.1.0.patch` | 1 | 24 | 1 |
| 101 | `tavern-plugin/lib/domain/tavern-token-meter.js` | 25 | 0 | 1 |
| 102 | `tavern-plugin/lib/domain/foreground-context-pressure.js` | 20 | 4 | 1 |
| 103 | `tavern-plugin/lib/domain/import-context-preparation.js` | 11 | 13 | 3 |
| 104 | `tavern-plugin/lib/domain/mvu-working-copy.js` | 7 | 17 | 1 |
| 105 | `tavern-plugin/src/client/features/preset-hub.js` | 9 | 15 | 1 |
| 106 | `bin/dsh-compatibility.mjs` | 11 | 12 | 1 |
| 107 | `tavern-plugin/lib/domain/surface-recovery.js` | 14 | 7 | 1 |
| 108 | `tavern-plugin/src/client/features/resources-library.js` | 15 | 6 | 2 |
| 109 | `bin/test-tavern.mjs` | 15 | 4 | 1 |
| 110 | `tavern-plugin/lib/domain/session-events.js` | 19 | 0 | 1 |
| 111 | `tavern-plugin/src/client/modules/host-theme.js` | 4 | 15 | 2 |
| 112 | `tavern-plugin/lib/domain/regeneration-diagnostics.js` | 15 | 3 | 3 |
| 113 | `tavern-plugin/lib/domain/reply-presentation.js` | 15 | 1 | 1 |
| 114 | `tavern-plugin/lib/domain/card-preparation.js` | 4 | 11 | 1 |
| 115 | `tavern-plugin/src/client/modules/sidebar-start.js` | 5 | 10 | 2 |
| 116 | `docs/design/agent-memory-retrieval.md` | 14 | 0 | 2 |
| 117 | `tavern-plugin/cordis.patch.yml` | 5 | 9 | 2 |
| 118 | `tavern-plugin/lib/domain/mvu-card-apply.js` | 12 | 1 | 1 |
| 119 | `tavern-plugin/lib/domain/chat-history-import-service.js` | 6 | 6 | 2 |
| 120 | `tavern-plugin/lib/domain/mvu-diagnostics.js` | 8 | 4 | 1 |
| 121 | `tavern-plugin/lib/domain/chat-history-session.js` | 5 | 6 | 1 |
| 122 | `tavern-plugin/lib/domain/conversation-fork-point.js` | 5 | 6 | 1 |
| 123 | `tavern-plugin/lib/domain/foreground-variable-changes.js` | 11 | 0 | 2 |
| 124 | `tavern-plugin/lib/domain/session-view-sync.js` | 4 | 7 | 2 |
| 125 | `tavern-plugin/src/client/runtime/conversation-lifecycle.js` | 2 | 9 | 4 |
| 126 | `tavern-plugin/src/client/ui/error-center.js` | 6 | 5 | 2 |
| 127 | `tavern-plugin/lib/domain/user-preference-profile.js` | 2 | 8 | 1 |
| 128 | `tavern-plugin/lib/domain/workspace-instruction-presentation.js` | 5 | 5 | 2 |
| 129 | `tavern-plugin/lib/domain/worldbook-snapshot.js` | 5 | 4 | 2 |
| 130 | `tavern-plugin/lib/domain/zip-entries.js` | 3 | 6 | 1 |
| 131 | `tavern-plugin/lib/domain/card-reading.js` | 8 | 0 | 1 |
| 132 | `tavern-plugin/src/client/modules/confirm-dialog.js` | 4 | 4 | 1 |
| 133 | `tavern-plugin/lib/domain/card-workspace-message.js` | 3 | 3 | 1 |
| 134 | `tavern-plugin/lib/domain/compaction-checkpoint.js` | 1 | 5 | 1 |
| 135 | `tavern-plugin/lib/domain/game-save.js` | 0 | 6 | 1 |
| 136 | `tavern-plugin/lib/domain/message-source.js` | 6 | 0 | 1 |
| 137 | `tavern-plugin/src/client/modules/frame-touch-scroll.js` | 1 | 5 | 1 |
| 138 | `tavern-plugin/src/client/modules/session-compat.js` | 5 | 0 | 4 |
| 139 | `config/dsh-compatibility.json` | 1 | 3 | 1 |
| 140 | `tavern-plugin/prompts/card-workspace.md` | 2 | 2 | 1 |
| 141 | `tavern-plugin/lib/domain/bounded-compaction.js` | 2 | 1 | 2 |
| 142 | `tavern-plugin/lib/domain/phone-chat.js` | 2 | 1 | 1 |
| 143 | `tavern-plugin/lib/domain/plugin-text-segments.js` | 1 | 2 | 1 |
| 144 | `tavern-plugin/pnpm-workspace.yaml` | 3 | 0 | 1 |
| 145 | `docs/adr/0005-replace-last-round-without-swipes.md` | 1 | 1 | 1 |
| 146 | `presets/tavern/skills/card-to-mvu/references/mvu-format.md` | 2 | 0 | 1 |
| 147 | `tavern-plugin/lib/domain/candidate-script-context.js` | 1 | 1 | 1 |
| 148 | `tavern-plugin/lib/domain/helper-user-session-context.js` | 1 | 1 | 1 |
| 149 | `tavern-plugin/lib/domain/lazy-history-read.js` | 1 | 1 | 1 |
| 150 | `tavern-plugin/prompts/card-task-preset.md` | 1 | 1 | 1 |
| 151 | `tavern-plugin/prompts/card-task-worldbook.md` | 1 | 1 | 1 |
| 152 | `tavern-plugin/src/client/modules/host-compatibility.js` | 1 | 1 | 1 |
| 153 | `tavern-plugin/lib/domain/compaction-failure.js` | 1 | 0 | 1 |
