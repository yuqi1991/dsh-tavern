# 第三项第二批：中止重生成的分支恢复

状态：修正后的中止重生成恢复及首屏加载已于2026-09-29通过用户验收。成功重生成的提交投影仍属第三项余项；第三项整体未完成。

## 修正内容

之前的 265e0a0 只是把旧墓碑写入包进事务，没有实现本批所需 branch+checkout。原名为“after a cut”的测试也没有注入故障。该部署方案已撤回，旧121项数字不作为本批恢复证据。

现在实际 createRegenerationRecovery.abort：验证失败尝试为当前后缀 → 用已有 createConversationHistory.prepare 预检 branch+checkout → 单独保存 regenRecovery.abortTransaction → 提交同一意图 → 恢复原 Chat 正文及变量，保留已提交 branchRegistry。新分支完整引用失败尝试版本，checkout 返回当前已提交前缀，因此此前正文编辑保留。无新写通路。

保存意图后，即使关闭新写入开关，重试仍执行该意图；无新意图且开关关闭时走旧兼容路径。首次写入前重启只接受宿主 session/end-seed 头变化，其他外部写入拒绝。历史读取屏障检测 abortTransaction，在服务历史或生成前恢复；并发读取等待正在执行的 abort/recover。

## 证据

- 静态检查通过：白名单 JS node --check、独立 algebra import、git diff --check、client build --check。
- 开发副本与保留 fork 独立改动的集成副本各130项离线测试全绿。
- 集成副本的旧 round-history、regeneration-recovery、regeneration-abort-safety 共91项回归全绿。
- 专项9项测试调用实际 abort/recover：首条写入前、首条写入后、原生提交后、flush失败、Chat最终保存失败；恢复时关闭新写入开关。另覆盖旧路径兼容、后来玩家输入拒绝零写入、并发读取等待。
- 使用真正的宿主 zstd Persistence API 与 Chat journal，在开发隔离目录存储中断状态，再关闭／重新打开并恢复。没有直接改压缩文件。
- 产品 regenerate 入口模拟失败，验证原正文恢复、变量保留、失败尝试分支保存；这些测试使用隔离 Session，不等价于运行安装实测。

## 范围与验收

仅迁移中止/失败重生成的临时后缀恢复。普通失败回合 replay 清理、成功重生成 complete 投影仍保留旧路径；第三项整体、第五项 reroll 重构均未完成。

本批部署5个服务端文件：regeneration-recovery.js、rollback-surface.js、round-history.js、conversation-algebra-history.js、index.js。新增的两个文件修改用于复用已有分支提交与接入读取恢复屏障；没有客户端改动。SHA256 白名单见 deployment/regen-recovery.json；原3文件清单已更新。无需再次授权，用户已明确同意本批部署。

运行验收：在 session-ebefd02d-a2d2-4d20-a9a1-d43cb9db3b19，等后台任务结束，启动“重新生成正文”，出现输出后用界面停止生成。确认原正文保留、状态面板正常、轨迹没有残留失败的新正文；刷新后再次重生成一次并正常完成，再继续发一轮。仅使用正常 UI 停止，不杀进程、不编辑文件。实现方检查 checkoutTransactions 比基线增加及日志；保存分支操作仍使用 checkout: 前缀。

备份及回滚仍按§6白名单协议。新 abortTransaction 或分支写入后，不得还原成不理解该意图的旧实现；关闭新写入并保留本批恢复代码，先核对恢复完成。所有 Session 与 Chat 写入经现有宿主 API，禁数据手术。

## 运行安装启动证据

PID 1013161，HTTP 200，5个部署文件哈希一致，无启动错误。测试会话 loaded/enabled/historyReady=true；其他会话开关关闭。checkoutTransactions 验收基线为5。备份 `/tmp/dsh-tavern-regen-abort-backup-20260929-172728`。部署证据见 deployment/regen-recovery-live.json（fork中位于conversation-algebra-phase1-evidence）。启动检查不代表用户中止重生成的功能验收已通过。

## seq 660 归属修复

线上首次重生成在 seq 660 失败：它是之前 checkout 事务产生的空控制墓碑，旧范围校验拒绝。只读 API 确认 seq 660/661 属于已提交 checkout 事务。修复仅允许精确匹配、已提交且为空的 dsh-tavern checkout/metadata 控制行；非空、未提交、外部玩家输入仍拒绝。新增边界和真实产品重生成回归，开发/fork 各134项通过，旧回归87项通过。仅部署 rollback-surface.js，PID 1015609，备份 /tmp/dsh-tavern-regen-control-backup-20260929-173337。

## 首次打开缺正文修复

用户截图确认首次页面仅显示context注入和技能目录，手动加载旧页后恢复；原诊断只统计节点数量而未统计可见正文，不能据此认定首屏正常。真实宿主分页回归复现：50条append预算被空事务／恢复占位消耗。插件在有代数记录的首次snapshot按当前fold补入最近对话及完整替换来源，保留连续窗口和原cursor、assistant/projection基线。未使用代数的会话保留原分页。来源闭包可使首次窗口大于50条，这是呈现完整性的必要代价，本批未声称大历史性能目标已完成。

开发/fork各137项测试通过，已部署conversation-algebra-isolation.js，PID1019499；备份 /tmp/dsh-tavern-history-opening-backup-20260929-174303。真实浏览器首次打开及刷新（未调用loadOlder）确认13个可见且非空的玩家/助手DOM行、openState=open、getSession成功。用户确认“可以了”，首屏加载验收通过。证据 history-opening-live.json。

## 中止重生成批次验收

用户按界面流程中止重生成、刷新、正常重生成并继续对话后确认“正常”。测试会话读取正常，checkoutTransactions 从首屏修复前的 6 增至 9，期间服务端日志无错误。客户端已加载窗口中可见新提交的 checkout 事务；只读诊断不能逐项证明每一次 checkout 的产品来源，因此将用户功能复验与事务计数共同作为本批验收证据。成功重生成的 `complete` 投影仍走旧路径，尚未迁移。

## 成功重生成 complete 投影迁移（2026-09-30）

`regeneration-recovery.complete` 开关启用时，userProjection 与 assistantProjection 收进单个 `runTransaction`（operationId = `regen-complete:<saved.id>`）。事务前 `waitForTransactionReady` 恢复中断尾部；恢复重发布的分支元数据写入当前 Chat 变更行内。开关关闭保持原路径。

- 新增 4 例测试；开发副本 157/157，fork 156/156。开发 `edc9fdc`，fork `c5e10314`。
- 已于 2026-09-30 部署并通过用户功能验收：带输入编辑的重生成，regen-complete:75f1fd2b 双写事务提交（seq 1532/1533），chat 三镜像同步，fold 一致 0 挂起，界面确认无异常。本小节完成。普通失败回合 replay 清理仍走旧路径。
