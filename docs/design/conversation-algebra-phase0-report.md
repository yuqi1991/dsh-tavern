# 会话操作代数 · 阶段 0 验收报告

- 日期：2026-09-29
- 结论：阶段 0 完成；D2 回落 (a)；停在阶段 0，未开始阶段 1 接线。
- 开发副本：`/home/claw/dsh-tavern-dev/tavern-plugin`
- baseline：`6281f80`

## 产出与证据

1. 新增 `lib/domain/conversation-algebra/`：`guards.js`、`primitives.js`、`transaction.js`、`fold.js`、`index.js`。目录内仅 import 本地 `./` 模块，独立冒烟导入通过。
2. 新增宿主 adapter `conversation-algebra-host-adapter.js`。它只调用现有 `session-events.js` 与 `session-surface-mutations.js`，未创建第二条写入通路；阶段 0 未接入产品路径。
3. 性质测试：固定种子执行 100,000 组随机原语序列，形状、step 配对、顺序和三视图一致性零违规。
4. 守卫测试：G1–G7 非法输入抛 `GuardError`；事务预检失败及 expectedHead 冲突均为零写入；未闭合事务尾部被 algebra fold 忽略。
5. 黄金回放：只读 `/tmp/session-backup/` 中两份 zstd 会话（67 与 185 个事件，含 28 次 replace），`computeFold().surfaceNodes` 与独立宿主 surface 投影相同。未读写 `profile-data/tavern/data/`。
6. B 实验：运行安装使用环境变量临时开关，测试会话为 `session-01cd86eb-f6ee-4c5d-9750-1693b5befa21`。探针未进入完整上下文。代码与回归测试确认：原生路径会把 context 写为 Session 行，compatibility 路径会丢弃 context。因此 B-1 失败，按规格无需执行 B-2/B-3，D2 回落消息行 + `dropTagged`。

## 验证状态

- **静态检查通过**：所有新增/修改 JS 通过 `node --check`；algebra 门面可独立 import；`git diff --check` 通过。
- **离线测试通过**：`node --test tests/algebra/*.test.mjs` 共 19 项通过；其中随机性质测试为 100,000 序列。
- **运行安装实测通过**：插件白名单部署后可加载，DSH 在 `127.0.0.1:3081` 正常运行；B-1 的失败结果已在一次性测试会话复现。这里的“通过”指实验成功给出可重复判定，不表示注入方案 (b) 可用。

## 部署与回滚

- 首次备份：`/tmp/dsh-tavern-live-lib-backup-20260929-1406`
- compatibility 修复前备份：`/tmp/dsh-tavern-live-lib-backup-20260929-1412-compat`
- 实验环境变量已移除；当前进程未启用 `DSH_TAVERN_SCAFFOLDING_INJECTION_EXPERIMENT`。
- 实验代码仍由默认关闭的开关隔离；阶段 1 前不调用 algebra 宿主 adapter。

## 开发副本提交

- `ed7219c` — algebra domain module
- `8bd3324` — properties, guards and golden replay
- `a2554b8` — scaffolding injection probe
- `f5a064b` — existing Session mutation adapter
- `73a19f8` / `3c6e46d` / `083fe44` — experiment isolation and compatibility coverage
- `d7ecc43` — B-1 failure regression

阶段 0 到此停止，等待用户验收后才可开始阶段 1。
