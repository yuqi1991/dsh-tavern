# 内核迁移到 DSH 0.2.1：上游做了什么、对我们的补丁意味着什么

> 说明：本机运行时是 0.1.5-rc.2（/home/claw/workspace/dsh-tarvern/runtime）。真实的 0.2.1-rc.2 包本机没有预装，
> 我用 `npm pack @deepseek-ai/<包>@0.2.1-rc.2` 从 npm 公开仓库下到 /tmp/kscratch（只读比对，没有改任何仓库/运行时）。
> 因此下面"锚点在不在"是对真实 0.2.1-rc.2 文件的**逐字计数验证**（静态），不是推断；但"装上去能不能跑"没有实机验证。

## 1. 结论（先看这段）
- 我们 host-session-patch.js 里的 **全部文本锚点在 0.2.1-rc.2 里仍然恰好出现一次**（7 个替换点 0 个丢失），所以补丁可以迁移，不是重写。
- 但有 **5 件必须改/新增的事**：①SHA 固定清单全部作废（每个被钉的文件字节都变了）；②surface-select 分支必须同时 `contentGeneration += 1`（0.2.1 的 deriveMessages 缓存只看它，不加会读到旧上下文）；③新增 dsh-session-format-v3-to-v4 包，需要照上游做法编译并登记 marker；④持久化类不再导出，需追加 `export { JsonlSessionPersistence }`；⑤token meter 在 0.2.1 里有 **4 套**各自折叠表面的代码（其中 3 套是新的"投影定义"），我们的 shim 只盖住其中 1 套。
- 上游 main 的补丁文件已经是"按锚点+启动自检"、不再绑版本/SHA（839648e1），但它**没有** surface-select；我们的 SHA 固定设计（ADR-0007/0009）与上游新思路相反，迁移时要决定是否也改成"锚点+自检"。
- ticket 19（回退后再回退卡 invalid current range）：0.2.1 不会让它自然消失，反而新增了 2 个同类折叠点，更难修一圈（见 §3）。
- 与 ADR-0007（"DSH 核心基线固定 0.1.5-rc.2，此后不再升级"）直接矛盾：换内核等于推翻这条 ADR，需用户明确拍板。

## 2. 补丁锚点逐点核对（0.1.5-rc.2 本机 vs 0.2.1-rc.2 真包；"次数"= 该文本在文件里出现几次，补丁要求恰好 1）
| # | 补丁点（文件） | 作用 | 0.1.5 | 0.2.1 | 结论 |
|---|---|---|---|---|---|
| 1 | dsh-session/surface（lib/types/surface.js）`if (event.type === 'assistant/message' && raw !== undefined) {` | 放行替换时引用来源（正文编辑） | 1 | 1 | **在** |
| 2 | 同文件 `const surfaceOp = validateSurfaceMetadata(event);`（我们在前面插 select 分支） | surface-select 的校验/计划 | 1 | 1 | **在**，但周边变了：其后新增 developer 头校验和"消息投影"分支；函数形参多了 `projections`（我们用到的 events/baseSeq/state 仍在） |
| 3 | 同文件 `function applySurfacePlan(state, plan) {`（我们插 select 提交） | select 提交到节点序列 | 1 | 1 | **在**，**但语义要补**：replace 现在同时 `contentGeneration += 1`，我们的 select 分支只加 replaceGeneration，必须补 |
| 4 | dsh-session 主包 lib/index.js 同三处（`... raw !== void 0) throw`、上两条） | 存档回放/采纳事件时的校验副本 | 各 1 | 各 1 | **在** |
| 5 | dsh-session-format-v2-to-v3 `... sources !== void 0) throw` | 旧格式迁移放行 | 1 | 1 | **在**（文件只多 16 字节） |
| 6 | dsh-api-session-controller/client.js `... raw !== void 0) throw`（客户端副本） | 浏览器端校验 | 1 | 1 | **在**。注意该文件里并没有 applySurfacePlan/validateSurfaceMetadata 的 select 锚点——客户端 wire 校验只看信封与 surfaceOp，不拒绝未知类型，所以客户端只需要这 1 个点（与现状一致） |
| 7 | dsh-session-persistence `new Session*Error(` / `instanceof Session*Error` 正则改写，导出 validateStoredEvents | 持久化校验复制 | 在 | 在（计数相同） | **在** |
| 8 | persistence-jsonl：`JsonlSessionPersistence` 类、generationFormat/coldLogMemo/tracker、`import("koffi")` | patchPersistence 逐方法覆盖实例 | 在 | 在，但 **该类不再对外导出**（只导出 apply） | **变了**：需追加 `text + '\nexport { JsonlSessionPersistence };'`（上游 main 已这么做） |
| 9 | format-catalog 的 createRestore / encodeCurrentHeader / encodeCurrentEvent / currentVersion | 持久化格式钩子 | 在（来自 dsh-session-format） | 同名仍在（dsh-session-format 0.2.1 同行号 345-364） | **在**；但 catalog 变成多文件，且依赖新包 v3-to-v4 |
| 10 | dsh-session-query：SessionCorpus / SessionObservationReader / _observations / _corpus | patchQuery 覆盖原型 | 在 | 在（计数相同） | **在** |
| 11 | SurfaceManager 原型的 validateNext / _processDelta（运行时替换原型方法） | 让已创建的 Session 也认 select | 在 | 在，但 SurfaceManager 新增 `_assertProjections`、`projections` 字段，`_processDelta` 里多了投影回放 | **在，需实机验证**（我们复制到原型上的补丁版方法，依赖这些新字段，原型方法按名字保留，理论上能用） |
| 12 | 新包：dsh-session-format-v3-to-v4（0.1.5 没有） | 当前格式 v4 的行准入（assertV4RowAdmission、RELEASED_V3_EVENT_TYPES） | 无 | 新增 | **需新增**：上游补丁加 `migration.RELEASED_V3_EVENT_TYPES.add(marker)`；我们还要确认 select 事件经 v4 行准入时不被拒（它用 patched Session 的 KNOWN 集合，我们已加 select——静态判断可过，未验证） |
| 13 | persistence-jsonl 的 **worker.cjs**（内置一份完整 surface 折叠副本，0.1.5 和 0.2.1 都有） | 后台线程校验已写入的文件 | 有 | 有，体积变大 | **我们两个版本都没补它**；select 事件会不会触发该线程校验，需实机确认（0.1.5 上现在没出事说明路径可能不走，但不是证明） |

SHA 固定清单（PINNED_SHA256 的 8 个文件）：0.2.1 里这 8 个文件字节全部不同（我比对了 dsh-session、surface.js、persistence、persistence-jsonl、catalog、v2-to-v3、query、client.js，全部 DIFF），所以必须重新取哈希，或像上游那样改成"锚点恰好一次 + 启动自检"。
另：上游 main 的 `hostRequireCandidates`（host-package-resolution.js）解决"0.2.0 桌面把宿主包放进 app.asar"的解析问题，我们的 defaultHostRequire 只认 dsh-tools 旁边的解析，**在桌面版/DSHA 上要借用**；命令行版（我们在用的）不受影响。

## 3. 逐项能力表（上游为 0.2.0/0.2.1 做的事 + 对我们的含义）
| 项 | 用户感到什么 | 上游实现（提交/文件） | 与新设计关系 | 建议 | 工作量 | 依赖 |
|---|---|---|---|---|---|---|
| A. 宿主补丁锚点迁移（§2） | 回退/重生成/正文编辑在 0.2.1 上仍可用 | host-session-patch.js（839648e1 去 SHA/版本，改"锚点恰好一次+自检"）；self-test 造一条"替换并引用来源"的会话验证 | 需适配：锚点全在，但 select 分支要补 contentGeneration、新包 v3-to-v4、导出持久化类（§2 #3/#8/#12） | 改写后取（以我们当前文件为底，吸收上游 3 处改动） | 中 | 无 |
| B. token meter（ticket 19 所在） | 回退再回退不再卡住；token 占用数字准 | 0.2.1 token-meter：`_foldEvent(state,event)`+`_sync` 仍在（我们 shim 的两个入口都在）；另新增 3 个"会话投影定义"（tokenUsage/contextPressure/contextBreakdown，surface-projection.js、breakdown-projection.js），各自折叠表面 | 需适配：这 3 套只认 `isSurfaceEvent`（带 surfaceOp 的事件），select 没有 surfaceOp → 被**静默忽略**（不抛错，用的是"标量+阴影价"，无范围可错，所以不会卡死，但占用/压力数字会漂移、压缩触发点不准） | 迁移时同步给这 3 套投影也加 select 识别（或在投影注册处包装），否则压缩阈值会失真 | 中 | A |
| C. 消息投影（0.2.1 新官方机制） | 无直接感受 | dsh-session：`@messageProjection`、`registerMessageProjection`、foldSurface(events, projections)、deriveEventMessage(event, projectedMessages) | 与 surface-select 无冲突（select 改节点成员，投影改内容）；**可能让"正文编辑"不必再放宽 replace 来源规则**（官方给了合法的内容改写路径），但这要重构我们的正文编辑，是另一个项目 | 先不取；迁移期继续用放宽补丁，之后单独评估 | 大 | A |
| D. surface/session 接口变化 | — | surface.js：新增 developer/message、`contentGeneration`、`projectedMessages`、`assertSourceEventReferences`（原 assertProvenance 改名）；tool/result 的 isError 位置变了（content[0].isError → message.isError）；会话格式 v3→v4（SESSION_FORMAT_VERSION 3→4） | 需适配：凡是我们代码里读 tool/result 内容结构、旧事件格式的地方要查（上游 5a5e520f 处理消息 source 迁移到 v4 的 producer-owned kind） | 迁移时全量跑测试，重点 session-events / session-turn-result | 中 | A |
| E. conversation.view 槽位 | Story View 仍能挂载 | dsh-client-ui-conversation：`conversation.view` 槽与 views 注册表仍在，d.ts 差异只涉及草稿类型（draft: string→DraftInput）、附件/用户文本新类型 | 大概率无冲突；Story View 若用 draft 属性要改 | 迁移后实机验证 | 小 | — |
| F. preset 声明模型 | 无感；安装/启动是否成功 | f05d5dfa：presets/ 目录→@deepseek-ai/dsh-agent-preset 声明行；cordis.patch.yml 行 id agent-presets→agent-preset-registry，config 收敛为 {default: tavern}；不再在 host 层重启 tool-bash/pwsh/fs/web，改由 tavern preset 的 config.plugins 提供；user-tools-bridge、compaction 改裸包说明符并加入 exports；换行归一 | 需适配：我们改过 plugin.patch.yml/presets 吗？（这些是两边都改的文件，需另一份报告对账）；我们的"后台预设/前台预设"若自己有 preset 改动则冲突 | 取（只能随内核换），但要与我们的 preset 改动合并 | 中 | 换内核 |
| G. 依赖清单/lock/补丁重建 | 无感 | 8d236c8b：config/dsh-compatibility.json→0.2.1-rc.2；cli-runtime 的 package.json/package-lock 重生成（每个 @deepseek-ai/* 钉 0.2.1-rc.2）；dsh-better-sidebar 0.26→0.28（0.26 依赖 0.2.1 已无的 webRuntime，会卡 waiting for service）；删 better-sidebar@0.26.0 补丁；dsh-dream-skin 的 trustedHosts 改软取 | 无冲突 | 随内核取；本机 better-sidebar 现为 0.19.1，换内核必须升到 ≥0.28 | 小-中 | 换内核 |
| H. DSH 版本闸门 | 装错宿主时有明确提示而不是半坏 | 31001213（三态闸门）→54eb4e11（收敛为 allowedDshVersions 允许清单，清单外拦截）；host-compatibility.js、bin/dsh-compatibility.mjs | 与 ADR-0007 的"精确钉死"思路相近；我们现在 SHA 钉；无冲突 | 取允许清单形式（比 SHA 钉更便于升级）；与 A 一起做 | 小 | A |
| I. f8222828 统一存档升级 | 老存档升到 v4 | save-upgrade.js、session-log-codec/repair、docs/verification/dsh-021-save-upgrade.md（实测 1111 个旧会话转换成功） | 我们已决定旧会话不要兼容 → **可不取**；但 v3 日志里若含我们的 marker/select 事件，宿主原生迁移会因"未知事件类型"拒绝（RELEASED_V3_EVENT_TYPES），即便丢弃旧档也要保证新会话可写 | 不取（按用户已定决策）；若要保留旧档再议 | 大 | 换内核 |
| J. 安装/打包：Windows | Windows 一键装、更新 | 1684d41f/e5e58fe7（#232 装不上/更新卡死）、1f00e226/9cf5087a（#231 标题栏拖拽带）、b8f077a3 双击安装、becef249 切官方 DeepSeek Harness | 多数与内核无关 | 见 §5 | 小-中 | 部分 |
| K. 安卓/DSHA | 安卓能装、侧栏不卡 | 6c4f7fbe（DSHA 0.2.0 betterSidebar 被跳过）、c38568d4、ca81b8eb | 只对 DSHA≥0.2.0 有意义 | 换内核后才有意义 | 小 | 换内核 |
| L. 命令行/macOS/DSH NEXT | 命令行版、社区桌面版可装 | 2faf0a0f（命令行装 0.2.1）、3bafcb8b（NEXT/Desktop 官方优先）、86f8a4b0、f618e56f、daf7ed78（不再装过期 jsDelivr 缓存） | daf7ed78/86f8a4b0 与内核无关 | 部分独立取 | 小 | 部分 |
| M. launcher / profile 桥接 / 跨目录迁移 | 桌面侧栏启动按钮、与原版 DSH 配置互不覆盖、从旧目录继承数据 | 967d9320/c5d85140（dsh-tavern-launcher）、f8fe4e8f（退出后安全切换 profile 桥接插件）、ad21a0f5、5a4b0ed7 + bin/import-user-home.mjs（继承数据并留备份） | 桌面用户才用；本机是命令行版 | 本机不需要；将来出桌面版再取 | 中 | 部分 |

## 4. ticket 19 与内核
- 现状：我们 fork 的 tavern-token-meter.js 已处理 select（与开发树文件一致，diff 为空）；"钉住 invalid current range"来自 token meter 位置折叠（`planSurfaceTokens`，surface-fold.js:78）遇到 replace 时在它自己的节点表里找不到起止 seq——即它没把 select 当成"整串节点重置"。0.2.1 保留同一个 `_foldEvent/_sync` 缝，所以**不会自然消失**（0.2.1 的 surface-fold.js 逻辑与 0.1.5 一致，仍只认 surfaceOp）。
- 0.2.1 不是更难修就是同样难：同类折叠点从 1 个变成 4 个（`_foldEvent` 位置折叠 + 3 个投影），其中 3 个静默漂移。所以"回退再回退"的根因修在我们 shim 里（让 select 重置节点表并覆盖所有路径），换内核既不帮忙也不拦路，但迁移时要把 shim 范围扩到投影。
- 注意：我没有复现 ticket 19，只是静态推理；具体是 shim 里 `select()` 在什么序列下漏掉，需实机/测试复现（见 §7）。

## 5. 与内核无关、可独立取 vs 换内核后才有意义
独立可取（不依赖 0.2.1，但"能否直接 cherry-pick 到我们 fork"仍要对账，这些提交多数在两边都改过的文件里）：
- daf7ed78 不再从过期 jsDelivr 缓存装旧版；86f8a4b0 DSH 跳过插件包时安装直接失败并回滚；fdbb8da2 Windows 桌面探测误把社区版 node.exe 当桌面；1684d41f/e5e58fe7/e4da8f10/7afcb1cd（#232 更新诊断与锁）；38ba2ad6 Git 仓库运行时不启动应用内更新；f37b23fa 安卓 Git 安装恢复应用内更新；1f00e226/9cf5087a Windows 拖拽带；b79debab 预览脚本只装一次；a9c07228/0502d381/47766adc/2bba891a 手机手势与布局；7f3d4bc3 启动器不认领别的酒馆服务；266884e0 本地同步脚本。
- 与本机（Linux 命令行、固定 0.1.5-rc.2）基本无关：Windows/安卓/macOS/launcher/profile 桥接/跨目录迁移——我们的 ADR-0007 目标虽包含多平台，但当前部署只有命令行。
换内核后才有意义：f05d5dfa 全部、8d236c8b、33d6b7c2/8ada8468/cbcedf03（0.2.0 asar 宿主布局）、6c4f7fbe/c38568d4（DSHA 0.2.0）、3bafcb8b（DSH NEXT）、becef249/77c045b7（官方 DeepSeek Harness 渠道）、5a5e520f/dc191a77（v4 消息源/压缩检查点）、d27b5605（0.2.1 样式）、f8222828。

## 6. stable 分支能提供什么（只读 gh api compare）
- 关系：stable 比共同基点 MB 多 1066 提交；main 多 1522。stable...main：main 独有 463 提交，stable 独有 6-7 个（安装/更新入口改跟随 stable、README 说明、Windows 安装包 CI、33f7e38f"开启正文走工具调用后压缩不再永久失败"、runtime manifest）。`gh compare` 因此不是"stable 落后 main"，而是分叉。
- main 独有的 463 提交里约 101 个 feat、17 个 merge；去掉适配/安装类后，面向用户的新功能主要有：舞台与背景音乐/配音（火山引擎）、卡内插件、人物卡库宫格视图、对话头像点击放大与情绪换图、插件接口 v3（registerStatusSection/versionSignal/cardImporter 等）、SillyTavern 聊天记录批量导入、预设包统一导入导出与多套系统提示词、压缩分卷摘要（0eb28243、e8145dd0）、存档包 v2 去重（eedd6e92）、渲染深度（ffabf965）、按意见改写重生成（9ef26981/21a2087d）、历史正文走工具参数回放（1133ecbd、5a8178a3）、顶栏快捷入口自定义。
- 结论：**stable 本身没有这些新功能**（它们只在 main）；stable 只修严重问题。想要其中某些功能而不换内核，只能从 main 里 cherry-pick——但很多提交依赖 0.2.x 的 preset/会话接口，是否能在 0.1.5 上跑**我没有逐个验证**。注意：我们 fork 的基点 MB 已含 stable 的绝大部分（stable 1066 提交均在 MB 之后吗？MB 是 main/stable 共同祖先，而 stable 独占的 1066 个是 MB 之后的）；我们 fork 与 stable 之间的关系需要另行 `git merge-base` 对账，我未做。

## 7. 换内核的步骤与风险（用户机器 = 命令行版，运行时 324M，数据 1.7G）
步骤（推断自上游安装脚本与 ADR-0007，非实机演练）：
1. 先整体备份 `/home/claw/workspace/dsh-tarvern`（尤其 profile-data、sessions、runtime、profiles、settings.yaml）。
2. 新装 0.2.1-rc.2 私有运行时（上游是 config/cli-runtime 的 lock 重建；root 约 560 个 @deepseek-ai 覆盖项），旧运行时目录整份保留不覆盖。
3. dsh-better-sidebar 0.19.1 → ≥0.28；pocket 等依赖随上游清单重钉；cordis.patch.yml 改 f05d5dfa 的 preset 声明行模型。
4. 重做补丁（§2），把允许清单加入 0.2.1-rc.2。
5. 新会话才可用；旧会话按用户已定决策不兼容（也可选跑 save-upgrade，大工程）。
风险：
- **日志格式 v3→v4 单向**：0.2.1 写出的会话 0.1.5 读不了；换内核后新开/追加的会话回退内核即丢。想保留回退能力，必须在切换前冻结备份，且回退后丢弃切换后产生的新档。
- 旧会话里我们的 marker/select 事件，在 0.2.1 原生 v3→v4 迁移中是"未知事件类型"，会被拒绝（需 RELEASED_V3_EVENT_TYPES 登记 marker，select 在 v3 里本不存在）。
- 与 ADR-0007（不再升级 DSH 核心）冲突，需先改/废 ADR。
- 已部署版本是不能退化的底线：换内核期间用另一个目录并行验证，不要原地升级。
能回退的：代码（git）、运行时目录（保留旧目录即可切回）、补丁。不能回退的：已经被 v4 写过的会话文件、被升级器改写的存储（上游声称保留旧文件，但新进度只写新版）。

## 8. 需用户拍板
1. 是否推翻 ADR-0007，把基线改到 0.2.1？倾向：**不急**。收益主要是上游的 0.2 安装/手机/桌面修复与新功能；我们本机是命令行+固定内核，迁移成本高且单向。若坚持不换，则只取 §5 里"独立可取"的修复。
2. 若换：补丁走"SHA 钉死"（沿用 ADR）还是"锚点+自检"（上游做法）？倾向锚点+自检+允许清单，本报告 §2 显示 SHA 全作废，每个小版本都要重钉。
3. 旧会话：确认继续放弃兼容（不取 f8222828）？倾向：是。
4. 想要 main 的舞台/配音/卡内插件等新功能：是否接受"逐个 cherry-pick 并对账"，还是等换内核后整体合并？
5. 正文编辑是否将来改走官方消息投影（§3 C），让补丁变小？

## 9. 不确定、需实机验证
- 0.2.1 上补丁能否真正装上并通过自检（我只验了锚点计数，没跑安装）；原型方法 validateNext/_processDelta 在新 SurfaceManager 上的行为。
- select 事件经 v4 行准入、persistence-jsonl 的 worker.cjs 线程校验（它内置独立折叠副本，我们两个版本都没补）是否会拒绝。
- token meter 3 个投影的 select 漂移幅度；压缩触发是否因此失真；缓存检查点是否让漂移持久。
- ticket 19 的具体触发序列（静态推理，未复现）。
- 我们的 Story View 在 0.2.1 的 conversation.view 上（草稿类型变更）是否正常。
- 上游补丁在客户端副本只有 1 个点，ADR-0009 提到的"客户端 fold 副本"在 0.1.5/0.2.1 的 client.js 里并没有 applySurfacePlan/validateSurfaceMetadata 锚点（计数 0），说明客户端并不折叠表面——ADR 描述与现实是否一致需核对。
- stable 与我们 fork 的具体关系（merge-base）未核对。
