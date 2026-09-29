# 阶段 1 第三项接线前复核

状态：用户已确认“回退第二轮不得撤销第一轮编辑”；规格与 checkout 原语已修正并完成离线回归。第三项产品回退/恢复接线仍未完成，未部署或重启。

## 实际调用点

- rollback-surface.js 的 clearFailedTurnSurface / clearRegenerationAttemptSurface 是失败尾部与中断重生成清理，当前写空 user 墓碑。
- round-history.js rollbackChat 才是已提交剧情回退：Chat Timeline 回退后，在约561行写空 assistant 替换一轮；undoRollback 经 restoreSurface 恢复前后台。实现方案将该行列在第五项，但第三项的产品回退接线也必须考虑此处，不能仅改两个清理函数便宣布完成。
- regeneration-recovery.complete 投影已经提交的重生成正文及可选用户输入；这是第五项仍使用的 journal-first 恢复协议，不能在调用方未迁移时直接删除。
- 当前 branch/checkout 的 metadata writer 在生产 readiness 中未配置；进入分支接线时必须补齐持久注册表投影及启动恢复，不能仅给正常提交传 writer。

## 可复现实例

`node experiments/checkout-anchor-review.mjs`，纯内存事件，未读写用户数据。

1. 第一轮 assistant 原始锚点 seq=1。
2. editStep 修改第一轮正文，替换事件追加在 seq=2。
3. 再追加第二轮玩家输入与正文。
4. checkout({anchorSeq:1}) 使用 events.filter(seq<=1)，目标回到第一轮旧正文。

实际输出 currentFirstRound=第一轮已编辑正文，checkoutFirstRound=第一轮旧正文，断言失败。这是当前原语将事件历史时间切片当作逻辑分支位置的结果，不是运行安装测试。

规格 §2 规定锚点不可变、编辑不改变后续锚点，§4.1 又同时允许 AnchorRef 与 BranchId，但没有分别定义内容版本解析规则。涉及数据保留语义，按用户红线须先确认规格，不能在接线时自行变通。

## 待批准的补充（建议加入规格 §3.3 / §4.3）

- checkout(AnchorRef)：在当前分支当前已提交 fold 中解析逻辑位置，通过替换来源链定位原锚点对应的现存 step，保留截止该位置的当前内容版本；不得仅按事件 seq 截断而撤销已完成的前缀编辑。工具配对边界仍须完整。
- checkout(BranchId)：恢复该命名分支保存 head 所代表的已提交版本，后续编辑不回写旧分支。
- 分支保存版本的 event head 与当前分支逻辑位置是不同种类的引用，接口显式区分；无法唯一定位的锚点应在零写入状态拒绝，不猜测。

批准后先将本复现改为正式回归并修复原语，再实施生产回退、恢复隔离与注册表接线。D1–D6 不重开，后续 reroll 迁移仍独立验收。

## 锚点修正结果

checkout(AnchorRef) 从当前 surface 定位并沿单节点替换链追踪原锚点，保留整个当前前缀；多节点范围替换后无法唯一定位则拒绝。BranchId 仍使用保存版本。新增4项回归覆盖连续编辑、早期输入编辑、工具边界、真实宿主隔离 Session 的 branch+checkout 回退与回旧线。完整103项离线测试通过；静态检查通过；运行安装未验证。本条修复不会提前部署不完整的第三项接线。
