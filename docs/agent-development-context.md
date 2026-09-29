# dsh-tavern 开发上下文

这份文档给新的开发会话使用，记录模块关系、领域不变量、插件装载方式和开发检查顺序。架构走查始于 2026-09-29 的本机安装包 2.3.0；本仓库的 `HEAD` 可能包含更新改动。开始新任务时先检查 `git status`、`git log`、当前 `package.json` 和相关源码，以仓库现状为准。

## 先读什么

开始改动前，按下面顺序恢复上下文。以下路径均相对于本仓库根目录：

1. `CONTEXT.md`：领域词汇的唯一来源。重点是 `Story Timeline`、`Foreground Turn`、`Background Operation`、`Tavern Script Execution Module`、`Tavern Script Dispatch`、`MVU Delivery` 和 `Host Adapter`。
2. `docs/architecture.md`：DSH seam、领域 module、适配器和当前产品不变量。
3. `docs/adr/`：尤其是 ADR-0005、ADR-0006、ADR-0007。已接受的决定不能因为一次局部实现不便而重新解释。
4. DeepSeek Harness 的 `docs/architecture.zh.md`（若本机有相邻 checkout）：Cordis、Profile、bundle、事件域和 DSH 的 Session/Agent/工具模型；本仓库的运行时基线以 ADR-0007 为准。
5. 本文其余部分：确认权威状态、调用链和已知摩擦后再编辑。

本机另有 `/home/claw/workspace/dsh-tarvern` 在线运行家目录。那里包含安装包和真实用户数据，没有源码工作树；以本仓库为编辑和提交目标，确认测试通过后再按具体部署任务同步到安装树。

## 工作区与源码平面

本仓库是可提交的源码 checkout。在线安装包和用户数据位于独立运行家目录；排查线上行为时先确认运行包所用的版本与本仓库是否一致。

| 路径 | 身份 | 开发含义 |
| --- | --- | --- |
| `tavern-plugin/lib/` | 服务端可加载实现 | `index.js` 装配 Cordis，`domain/` 保存 Tavern 领域逻辑；服务端实现改动后需重启运行时 |
| `tavern-plugin/src/client/` | Web 客户端维护源码 | 按 Feature Module 修改并重新构建；`lib/client.js` 是构建产物 |
| `tavern-plugin/packages/` | 同仓插件 package | Tavern remote、侧栏、换肤、生图和 card-memory 等 package |
| `bin/`、`presets/`、`config/` | 启动、Agent preset 与 profile 配置 | 用当前 manifest 和 patch 核对实际装载关系 |
| `tests/`、`testsets/` | 行为、浏览器与游戏回归 | 从这里选择与改动对应的测试，不使用真实用户数据 |
| `CONTEXT.md`、`docs/` | 领域词汇、架构与 ADR | 读当前版本，历史设计以已接受 ADR 和现行实现校验 |
| `/home/claw/workspace/dsh-tarvern/` | 本机运行家目录（若存在） | `apps/dsh-tavern/` 是安装包，`profiles/tavern/` 是激活 profile，`profile-data/tavern/data/` 是用户数据；不在此提交 |

在线实例使用固定数据根。同一数据根只由一个 Tavern 实例写入；开发测试使用隔离的临时数据，不复用用户存档。

## 运行时结构

DeepSeek Harness 建立在 Cordis 上。插件向共享 `ctx` 注册服务、事件监听器和可逆副作用；产品功能都通过插件挂载。Profile 是 bundle 的有序组合，patch 可以按条目 id 替换整个配置或插入新条目。

仓库声明的 bundle 顺序在根目录 `package.json` 的 `dsh.profile.bundles` 中；在线安装的组合可见运行家目录的 `profiles/tavern/package.json`，两者可能不同。`tavern-plugin/cordis.patch.yml` 恢复 Tavern 所需的文件、shell、Web、Agent preset 和权限能力。确认真实启动树时使用宿主的 `--dump-config`，仅凭 manifest 不能确定某个 plugin 已激活。

`tavern-plugin/lib/index.js` 是装配根。它创建领域 module，连接 DSH `ctx`、文件存储、Session、模型和 Web server，再注册 RPC、工具、事件和 disposers。它不是单一领域 module；阅读一条功能链时，从这里找到 module 的创建点和注入依赖，再进入 `lib/domain/`。

服务端领域实现主要在 `tavern-plugin/lib/domain/`。客户端按产品能力拆成 `tavern-plugin/src/client/modules/`，构建脚本把它们组装成 `tavern-plugin/lib/client.js`。服务端 `lib/` 是当前源码仓库的可加载实现；客户端生成物由构建脚本维护。

## 核心领域模型

### Story Timeline

`Story Timeline` 是 Tavern Chat 中唯一权威的剧情状态。它记录 `branch`、单调递增的 `revision`、`checkpoint`、正文 operation、Background Operation 和 participant。DSH Session、后台 Agent 与浏览器 View 都是 producer 或 projection。

`lib/domain/story-timeline.js` 当前对外提供 `apply`、`complete`、`inspect` 和 `rollbackTarget`。正常正文、后台结算和回退已经通过它处理；它应当继续拥有 branch/revision/checkpoint/stale result 的不变量。

当前已知架构摩擦是：历史导入、会话分叉、部分压缩和回退路径仍直接读写 `chat.timeline` 的内部字段。例如导入会直接 push checkpoint 并递增 revision，分叉会直接重建 timeline。后续若处理这一候选，应把这些路径转成 Timeline intent，并让 transition 规则集中在 `story-timeline.js`。删除测试：删除 Timeline 后，复杂度会在导入、分叉、回退和后台协调的多个调用方重新出现，因此这是一个值得保留并加深的 seam。

### DSH Session 与 Chat 存储

DSH Session 是只追加的事件日志。模型可见的消息、工具调用和流式输出必须能够从日志重建；需要修改展示时使用 projection 或新的事件，不原地改写 Session 历史。

Tavern Chat 是另一种持久化对象。`chat-journal-store.js` 使用 snapshot + append-only JSONL journal 物化 Chat，`chat-persistence.js` 负责 revision、三方合并、冲突检查和 detached read。两者都支持回退读取，但它们不是 Story Timeline，也不是 DSH Session。

因此要区分三件事：

- Session append-only log：DSH 的运行轨迹和模型可见事实。
- Story Timeline：Tavern 的当前剧情状态、分支和 checkpoint。
- Chat snapshot/journal：Tavern Chat 的存储和历史 revision。

### Foreground Turn

`Foreground Turn` 是玩家输入和正文回复的独立提交边界。正文成功后立即推进 Story Timeline revision 并创建 checkpoint；后台状态结算属于绑定该正文 branch/revision 的派生 Background Operation。

ADR-0006 规定正文提交独立于派生结算。结算失败保留正文、记录失败并允许重试；旧 operation 的迟到结果必须因为 branch/revision 不匹配而变成 stale。ADR-0005 规定重新生成只替换最后一个已提交正文，不提供产品级 Swipe 分支。

涉及正文回合时，优先阅读：

- `lib/domain/turn-orchestration.js`
- `lib/domain/foreground-orchestration-strategies.js`
- `lib/domain/round-history.js`
- `lib/domain/foreground-handoff.js`
- `lib/domain/story-timeline.js`

### Background Agent 与 Background Operation

一个 Tavern Chat 的剧情相关任务共享一个持续后台 Agent：候选生成、状态结算、按需世界书模型筛选与人物设计在这条链中运行，并将结果绑定 Story Timeline 的 branch/revision。`background-agent-sessions.js` 也承载场景配图与手机任务，但它们选择不同的 resident key 或一次性会话路径；先检查具体任务的生命周期，再判断是否由同一个持续 Agent 承担。

运行链分成三层：

- `background-agent-sessions.js`：创建、恢复、复用、释放和压缩后台 Session。
- `background-agent-task.js`：Agent lifecycle、stable prefix、rewind、progress、tool allowlist 和最终结果。
- `background-task-coordinator.js`：把 Timeline operation 与持久 Chat 写入、幂等、checkpoint、commit、fail、recover 连接起来。

当前已知摩擦是 `background-agent-task.js` 用 task 字符串同时处理 candidate、settlement、worldbook-filter、image、phone 和 character-design 的 persona、提示词、工具和终态策略。后续可以在共享执行逻辑后收深 task-role seam，同时保留各任务真实的 Session lifetime 和 Story Timeline 的权威关系。

### Candidate Task

候选任务由 `candidate-tasks.js`、`durable-task-mailbox.js` 和 `candidate-generation.js` 协作。Mailbox 提供 queued/running/stage/result 的持久命令投影，Story Timeline operation 提供 branch/revision 和提交有效性；`candidate-tasks` 负责两者的 reconcile、legacy fallback 和 Session view。

这里存在两套相互关联的生命周期记录。处理候选性能或恢复问题时，先确认哪个事实属于 Story Timeline，哪个事实只是 mailbox projection，再修改写入频率。mailbox 不能成为第二份剧情权威。

### Tavern Script Execution Module

酒馆脚本运行模块是在浏览器隔离环境中重新实现 Tavern Helper 和人物卡脚本可观察语义的模块。它不拥有 DSH Session、Chat、变量或世界书的权威。

`tavern-script-dispatch.js` 管理浏览器脚本工作的 queue、offer、claim、start、可续租执行、幂等回执和 runtime presence。`tavern-script-host-adapter.js` 把脚本对消息、变量、世界书、模板和展示的调用映射到 dsh-tavern 的权威状态。

Host Adapter 是人物卡脚本看到的唯一公开 seam。它当前约 762 行，同时处理 MVU settlement transaction、eventId 校验、世界书并发写入、Prompt Template cursor/settings 和 lease RPC。若继续收深，应收进内部 capability module，保留 Tavern-shaped 外部 interface；浏览器 iframe executor 和 host-side dispatch 是不同的 concrete adapters。

MVU 相关文件：

- `mvu-background-settlement.js`：模型生成的变量结算、draft、validation 和 effect。
- `mvu-settlement-effect.js`：绑定 branch/revision 的纯数据效果。
- `mvu-settlement-reconciler.js`：启动扫描、Session Signal 唤醒和可重试恢复。
- `tavern-script-host-adapter.js`：把 Helper/MVU 脚本写入纳入当前 settlement transaction。

### Projection 与 Signal

Projection 是从权威状态派生的只读表示。Session view、Background Activity、Tavern status view 和浏览器交互状态都可以重建，不能成为第二份权威状态。

`session-signal-transport.js` 和 `coordination-event-publisher.js` 发布带版本的唤醒通知。Signal 只表示“重新检查”，不表示任务存在、执行成功或提交完成。消费者在首次连接和重连时仍要从领域 module 校准。

## 代码地图

| 目的 | 入口 |
| --- | --- |
| 插件装配、DSH 事件、RPC、工具 | `tavern-plugin/lib/index.js` |
| 剧情 branch/revision/checkpoint | `lib/domain/story-timeline.js` |
| 正文回合 lifecycle | `lib/domain/turn-orchestration.js`、`foreground-orchestration-strategies.js` |
| 回退、重新生成、失败尾部恢复 | `lib/domain/round-history.js`、`regeneration-recovery.js`、`surface-recovery.js` |
| 后台 Agent lease 和执行 | `background-agent-sessions.js`、`background-agent-task.js`、`background-agent-runner.js` |
| 后台 operation 持久生命周期 | `lib/domain/background-task-coordinator.js` |
| 候选生成和候选持久任务 | `candidate-generation.js`、`candidate-tasks.js`、`durable-task-mailbox.js` |
| 酒馆脚本和 MVU | `tavern-script-dispatch.js`、`tavern-script-host-adapter.js`、`mvu-background-settlement.js` |
| Chat snapshot/journal/revision | `chat-journal-store.js`、`chat-persistence.js` |
| Session 到 Tavern View 的读取和增量同步 | `session-view-reader.js`、`session-view-sync.js`、`chat-session-state.js` |
| 人物卡、世界书、预设 | `card-preparation.js`、`worldbook-library.js`、`preset-library.js`、`sillytavern-compatibility.js` |
| 客户端纵向能力 | `tavern-plugin/src/client/modules/` |
| DSH remote RPC package | `tavern-plugin/packages/dsh-tavern-remote/` |

`index.js` 是装配根，约 5,000 行并有大量 import。先判断某段逻辑是装配还是领域实现：装配属于 root，领域不变量属于 deep module。文件长度本身不足以证明拆分能增加 depth。

## 插件生态

插件的真实 seam 是 package manifest 的 `dsh.bundle` / `dsh.client` 与 Cordis patch，不是把所有功能塞进 Tavern domain module。

| package | 角色 | 入口和注意事项 |
| --- | --- | --- |
| `dsh-tavern-plugin` | Tavern domain bundle 和 Web client 注入 | `tavern-plugin/package.json`、`cordis.patch.yml` |
| `dsh-tavern-remote` | Typert/RPC remote client、host/client 类型和 gateway 接入 | `packages/dsh-tavern-remote/`；host/client 两个 build face |
| `dsh-better-sidebar` | pinned Web sidebar surface | 通过 bundle patch 装载；先核对当前 profile 是否启用 |
| `dsh-dream-skin` | DSH Web theme/skin | 自己提供 bundle patch 和 client injection |
| `dsh-image-gen` | Gemini/OpenAI/Seedream/DashScope/ComfyUI 等图片能力 | 独立 build/test；通过 DSH credentials、tools、settings 等 peer package 接入 |
| `dsh-tavern-card-memory` | Tavern 内部 card memory package | 依赖 dsh-mnemon；没有独立 DSH manifest，当前属于 Tavern 实现内部 package |
| vendored assets | SillyTavern macros、Prompt Template、MagVarUpdate、运行时资源 | 固定版本和来源；兼容行为改变时同时看对应 baseline/design 文档 |

Profile 组合和 patch 关系以根目录 `package.json`、`tavern-plugin/package.json`、`tavern-plugin/cordis.patch.yml` 和 `config/plugin-web.patch.yml` 为准。修改 bundle 时要同时考虑 host plugin、client injection、依赖解析和卸载 disposer。

## 继续开发的工作流

### 1. 先定位权威事实

先确认要改的是哪一个领域事实：剧情正文、Story Timeline、Background Operation、MVU Delivery、脚本 runtime、Chat storage 还是 Projection。然后从 `index.js` 找装配点，再沿着 domain module 的 interface 追到 producer、adapter 和 consumer。

完成标准：能画出从 RPC、DSH event 或工具入口到权威写入，再到 Projection/Signal 的完整调用链，并能指出其中唯一的 authority。

### 2. 查文档和已接受决定

涉及 branch/revision/checkpoint 时读 `CONTEXT.md`、`docs/architecture.md`、ADR-0005/0006。涉及 DSH runtime、bundle、Session event 或 Agent lifecycle 时读上游 `deepseek-harness/docs/architecture.zh.md`。涉及脚本、MVU、模板或兼容语义时读对应 `docs/design/` baseline。

完成标准：改动的每个状态事实都能归属于一个现有 module；如果要改变 ADR 语义，先明确这是重新打开决策，而不是顺手重构。

### 3. 选择 seam 和 test surface

优先把复杂度放进已有 deep module。Interface 是 test surface；测试应从调用者实际跨越的 seam 进入，而不是读取 implementation 内部状态。只有两个具体 adapters 都存在时才引入新的可替换 seam，例如生产 transport 和 in-memory test adapter。

完成标准：想象删除候选 module：复杂度随之消失，说明它很浅；复杂度重新散到多个调用方，说明它有 depth。测试能从同一 interface 覆盖生产路径和必要的替代 adapter。

### 4. 做窄变更并保持生命周期完整

Cordis 注册必须通过 `ctx.effect()`、`ctx.on()` 或 registry 的 disposer。Waterfall listener 必须调用 `next()`；插件卸载必须撤销 timer、listener、Session Signal、Agent handle 和临时 patch。后台结果提交前检查 branch/revision，不能用当前 Chat 的存在性代替版本检查。

客户端改动编辑 `src/client/`，再运行 client build/check；服务端 `lib/` 改动要确认实际加载的是同一份文件并重启当前实例。Prompt 文件按运行约定可热加载，插件实现和 Harness source 要重启。

完成标准：所有新增 effect、timer、listener、runtime handle 都有对称清理；过期、重启、取消和重复请求都有明确终态。

### 5. 用匹配风险的验证

先跑受影响的 module tests，再跑对应生命周期测试和必要的 e2e。命令以本仓库当前 `package.json` 为准；测试文件位于 `tests/` 和 `testsets/`。

重点映射：

- Story Timeline：`story-timeline.test.mjs`、`background-task-coordinator.test.mjs`、`round-history.test.mjs`、`chat-journal-timeline-integration.test.mjs`。
- Background Agent：`background-agent-runner.test.mjs`、`background-agent-lifecycle.test.mjs`、`settlement-restart-recovery.test.mjs`。
- Candidate Task：`candidate-tasks.test.mjs`、`candidate-generation.test.mjs`、`durable-task-mailbox.test.mjs`。
- Script/MVU：`tavern-script-dispatch.test.mjs`、`tavern-script-host-adapter.test.mjs`、`helper-host-api.test.mjs`、`mvu-settlement-reconciler.test.mjs`。
- Chat storage/View：`chat-persistence.test.mjs`、`chat-journal-store.test.mjs`、`session-view-reader` 相关测试、长历史性能测试。

模型或产品用户可见行为改变时，使用本仓库的浏览器、游戏或固定回放测试验证组装后的应用行为；单个 module test 不能覆盖端到端体验。客户端改动执行 `check:client`，插件 package 改动执行 `check:plugin-package`；若同时修改 Harness，遵循 Harness 自身的 keyless snapshot 门槛。

完成标准：行为测试从 interface 通过，生命周期路径覆盖启动/恢复/取消/过期，生成物检查通过，且报告了未覆盖的平台或运行模式。

## 架构候选（待选择）

2026-09-29 的架构审查按预期收益列出以下候选；它们是后续讨论入口，实施范围由具体开发任务决定：

1. **封闭 Story Timeline 的 transition seam**：导入、分叉、回退和普通回合仍有路径直接改 timeline representation。先收拢它能为其他模块提供共同权威。
2. **收深 Background Agent task-role seam**：把 candidate、settlement、worldbook-filter、image、phone 和 character-design 的任务差异从共享 Agent lifecycle 中收进 role adapters。
3. **按能力收深 Tavern Script Host Adapter**：保留唯一公开 Host seam，把 MVU transaction、资源 revision、模板 cursor 和 lease 实现收进内部 module。
4. **收拢 Foreground Turn 生命周期**：让 Native Play 和 Compatibility 两个 strategy 共享正文 commit/stale/recovery 规则，保持 ADR-0005/0006。
5. **收拢 Candidate Task mailbox projection**：保持 Story Timeline 为唯一权威，隐藏 mailbox 和 Timeline operation 之间的 requestId/operationId/stage 翻译。

先处理第 1 项时，推荐的阅读入口是 `story-timeline.js`、`chat-history-session.js`、`chat-history-import-service.js`、`conversation-fork.js`、`round-history.js` 和 `tavern-compaction.js`。先补 transition 行为测试，再让 import/fork/rollback producer 通过同一 implementation；不要先改数据格式或 DSH Session 事件格式。

## 必须保持的护栏

- DSH runtime 基线由 ADR-0007 固定；新能力优先在 Tavern module 或 plugin seam 上实现，不顺手升级上游 Harness。
- Model-visible 等于 logged。任何进入模型请求的新输入都要能从 Session log 重建，并补 `SessionEventMap` 或对应投影路径。
- Story Timeline 是剧情 authority；Background Activity、MVU receipt 的界面汇总、Session View、status view 和 Signal 都是 projection。
- Foreground Turn 成功提交正文后，Background Operation 失败不能删除正文，也不能阻塞下一次正文。
- 迟到的后台结果必须匹配 branch/revision；“Chat 还存在”不足以证明结果仍有效。
- Host Adapter 只暴露 Tavern-shaped interface。人物卡脚本不应直接认识 DSH Session、Chat journal 或内部 storage revision。
- Chat storage 的 detached read 不能被当作 writable Chat；三方合并、revision patch 和 journal rotation 属于 storage implementation。
- 新增 seam 前确认至少两个 adapters；单一实现的 indirection 不会增加 depth。
- 修改 source plane 后同步必要的 generated artifact、文档和测试；不要直接手改 `lib/client.js`。
- 本机在线用户数据位于运行家目录的 `profile-data/tavern/data`；代码变更和测试 fixture 使用独立数据根。

## 收尾清单

完成一项 dsh-tavern 开发任务前，确认：

- 领域名词来自 `CONTEXT.md`，没有用新的模糊名字替代已有概念。
- 权威状态只有一个 owner，Projection、Signal 和 adapter 没有形成第二份真相。
- 改动经过正确的 interface test surface，包含失败、取消、恢复、重复和 stale 路径。
- Cordis effect、listener、timer、Agent handle 和临时 patch 都有 disposer。
- 受影响的 client/package/generated artifact 已构建并检查。
- 必要的 README、architecture/design/ADR 或 Agent Note 已更新；文档记录的是原因和约束，命令与版本继续留在环境文件。
- 测试结果和未覆盖的平台边界已经写入交付说明。
