# 阶段 1 第一次迁移：脚手架退役接线

范围：实现方案 §4 第 1 项。仅开发副本，未部署；正文编辑/回退/RPC/UI 后续迁移未完成。

## 本次接线

- index.js 的 retireOldForegroundFrames 在 conversationAlgebra=true 时调用 retireForegroundWithAlgebra，关闭时保留旧退役实现。
- 系统提示装配前等待事务恢复，Tavern session view 读取前后等待恢复。
- 宿主 sessionController.history 的 page/sourceFor/follow 通过可撤销 wrapper 在传输处等待恢复；不截断持久化的 session/event。
- 冷会话通过 sessionQuery 观察；有未提交事务才 resume 并恢复，句柄在 finally 释放。
- 关闭写入开关不会关闭恢复检查。宿主 history 接口缺失时拒绝启用新写入。

## 验证（最新，2026-09-29）

- 静态检查通过：白名单 JS 语法、独立 algebra import、client build --check、git diff --check。
- 离线测试通过：开发副本及保留 fork 独立改动的集成副本，各 67 pass / 0 fail / 0 skip。
- 运行安装实测：未进行。本交付尚未部署、未重启，不能称作阶段 1 验收通过。
- 真实宿主 Cordis history 与 SessionEventStream 的离线测试覆盖持久化等待、提交前不发布、提交后单次发布、重连、翻页、dispose；完整 apply 在模拟服务和隔离 DSH_HOME 中通过，不等价于真实服务器或浏览器验收。
- 10 万随机序列覆盖范围沿用原测试；并发、checkout、故障截断和恢复由独立定向测试覆盖，不声称随机测试覆盖所有组合。
- 修复安装基线源码/生成物漂移：恢复已运行的改输入 UI 和轨迹折叠到 src/client。AST 对比去除新增 publication gate 后，与原 lib/client.js 完全相同。

## 部署与验收

部署包以开发副本 da70f99 的运行文件为准。白名单及部署前后 SHA256 见 deployment/phase1-retirement.json（15 个文件）；node_modules、tests、用户数据不部署。fork 的独立存储/UI 改动通过三方合并保留，fork 不是本次线上部署源。

按实现方案 §6，用户授权后：重新核验 liveSha256；备份 lib 及白名单 src；复制白名单；沿用现有启动方式重启唯一 DSH 实例。首次保持默认关闭，确认加载成功。随后仅以进程环境 DSH_TAVERN_CONVERSATION_ALGEBRA_SESSIONS 指定已由 UI 创建的一次性测试会话；不改 profile-data 设置。浏览器所有测试标签页必须刷新后再发消息。

验收范围仅 §4 第 1 项脚手架退役，没有新的 probe 按钮：

1. 开关关闭时，打开对话、发消息、看正文与轨迹，确认旧行为正常。
2. 测试会话开启时连续玩至少三轮：正文、玩家输入保留；旧技能/提醒等脚手架正常退役，工具调用与结果无孤儿，轨迹无短暂残缺。
3. 重生成两次、改输入重掷、回退各一次，确认既有行为未退化；这些功能自身尚未迁移到新代数。
4. 刷新/重连后当前正文与轨迹一致，无重复消息、卡住或加载错误。人工不做中途杀进程实验。
5. 实现方用只读 getConversationAlgebraStatus 核对 enabled/historyReady，以及 committedTransactions > 0、lastCommit.operationId 以 retire: 开头。若没有实际退休，不把“页面没报错”当作接线通过。

只读诊断请求：POST /api/dsh-tavern/getConversationAlgebraStatus，JSON body 为 {"sessionId":"<测试会话>"}。响应不包含正文。未加载会话 loaded=false 时计数不是磁盘总数。

回滚：停止新生成；关闭新写入并先确认没有未提交事务。仅恢复本次白名单备份、删除本次新增文件，重启；不覆盖其他文件、不操作数据。若存在未完成事务，保留当前恢复实现、关闭新写入并诊断，不能直接回退到不懂恢复标记的阶段 0。

后续必须先完成本项独立运行验收，再进入正文编辑迁移。阶段 1 整体尚未完成。

## 历史记录（以下为上一次提交时状态，已被上文更新）

静态检查通过。node --test tests/algebra/*.test.mjs：59 pass、0 fail、1 skip。
skip 为复制自 fork 的 inputChanges 测试；运行树基线无此功能，未将 fork 的独立改动覆盖进开发副本。
本次新增隔离测试覆盖等待持久化、恢复失败拒绝读取、订阅关闭、冷会话观察释放；此前的宿主 zstd、退役配对、checkout 恢复测试继续通过。

## 部署前仍需核对

- wrapper 接入真实 Cordis sessionController 的完整离线装配测试，目前测试使用同形接口和真实 detached Session，但不是完整服务器。
- 原生客户端收到提交后的逐事件回放时可能短暂重绘中间状态；需要客户端提交边界测试，不能把服务端等待完成宣称为 UI 原子更新。
- 先前权威规格与旧验收报告应同步进 fork，且需保留 fork 的并行改动。
- 运行安装共享文件重新对账、白名单、备份及用户授权后才可部署重启。

阶段 1 未完成，不能以当前测试数量宣布产品验收通过。
