# 开发与部署环境（fork：yuqi1991/dsh-tavern，跟随上游 flizzywine/dsh-tavern）

最后更新：2026-10-31（DSH 0.2.1-rc.2；生产部署标签 `deploy-021-20261031b`）。

## 目录分工

| 路径 | 用途 |
| --- | --- |
| `/home/claw/dsh-tavern-fork-021` | **唯一的开发仓库**（分支 `main`）。所有改动在这里提交。根目录的 `lib` 是指向 `tavern-plugin/lib` 的本地软链，不提交；`tavern-plugin/node_modules` 指向 `dsh-stage-021/plugin/node_modules`。 |
| `/home/claw/dsh-stage-021` | **验收与测试环境**：已验证的 0.2.1 运行时（`runtime/`）、依赖（`root-nm/`、`plugin/node_modules`）、验收实例家目录（`home/`，端口 3092，Pocket 3093）。`bin/test-all.sh`、`bin/deploy.sh stage`、e2e 都依赖它的运行时和依赖，不要删。 |
| `/home/claw/workspace/dsh-tarvern` | **生产家目录**（端口 3081，Pocket 3082）。`runtime/`、`apps/dsh-tavern/`、`profiles/tavern/` 由部署脚本维护，不要手改；用户数据在 `profile-data/tavern/`；`settings.yaml` 只由使用者管理。 |
| `/home/claw/backups` | 部署前备份：`dsh-pre-deploy-20261031/`（生产完整拷贝、sha256、README 含恢复命令）、`hotfix-*`、`dsh-pre-update-b-*`、git bundle。 |

生产里 `*-0.1.5-pre-deploy` 目录和 `profile-data/tavern/archive-0.1.5-20261031` 是 0.1.5 的回退点与旧游戏归档，确认 0.2.1 稳定后再清理。

## 日常开发

- 测试：`bin/test-all.sh`（完整，应全绿；algebra 单独不带预加载一段）、`bin/test-some.sh <测试文件…>`。已知 skip 见 `tests/KNOWN-FAILURES.md`，被删除的过期用例见 `tests/OBSOLETE.md`；**新增 skip 或删除必须登记**。
- 生成文件：改了客户端源码后 `node bin/build-tavern-client.mjs`；`bin/regen.sh` 一键重建并校验（客户端、插件包、手册）。`--check` 必须通过。
- e2e（真实 DSH + 浏览器 + 固定模型，隔离家目录与随机端口）：`TAVERN_E2E_RUNTIME=/home/claw/dsh-stage-021/runtime TAVERN_E2E_OUTPUT=<目录> node tests/e2e/gameplay.mjs [--flag]`。本机 Playwright 浏览器版本缺失的处理见 `tests/KNOWN-FAILURES.md`。
- 验收实例：`bin/stage-021.sh setup|start|stop|status|logs`，`enable-pocket` 加 Pocket（带两个补丁，见 `docs/stage-021.md`）。令牌与 PIN 由使用者自己取，不要打印。
- **测试收尾**：每次跑完 `bin/test-all.sh` 或 `tests/e2e` 之后执行 `bin/clean-test-leftovers.sh`。e2e 失败或超时会遗留 `--port 0` 的 DSH 进程（每个约 350MB）和 `/tmp/tavern-e2e-*` 目录，曾累积 13 个占 4.5GB。浏览器用例用 `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers` 时，这个目录也由脚本清理。
- 不要在 fork 里运行 `pnpm add/install`（会改动依赖目录的软链指向）。依赖变更与 `pnpm-lock.yaml` 的处理见 `docs/upstream-port/SYNC-PLAYBOOK.md`。
- 并行任务：每个任务用自己的 `git worktree`；**不要使用 `git stash`**（stash 栈在所有 worktree 间共享）；提交按明确路径添加。

## 同步上游

按 `docs/upstream-port/SYNC-PLAYBOOK.md`：`bin/setup-sync.sh` → `bin/upstream-ledger.mjs pending` → 对照 `docs/fork-delta.md` → `bin/upstream-dry-run.sh` → 小步 merge（不 rebase）→ `bin/regen.sh` → `bin/test-all.sh` → 验收实例 → 部署。已处理的上游提交记录在 `docs/upstream-port/ledger.tsv`。

## 部署与回退

- 流程：`git tag deploy-<日期>` → 备份 → `bin/deploy.sh stage`（暂存区构建、逐字节核对、与旧发布树对比文件清单）→ `bin/deploy.sh check`（非生产端口自检）→ `CONFIRM=yes bin/deploy.sh cutover`。细节与注意事项见 `docs/upstream-port/DEPLOY-021.md`。
- 只改少数运行文件的小更新：`bin/hotfix-release.sh [标签]`（备份 → 停服务 → 覆盖 → 逐字节核对 → 重启）。**生产启停与覆盖需要使用者明确授权。**
- 回退：`CONFIRM=yes bin/deploy.sh rollback`（回到 0.1.5 目录），或按 `backups/dsh-pre-deploy-20261031/README.txt` 整体恢复；小更新的回退是把 `backups/hotfix-*` 里的文件拷回原位后重启。
- 部署后在 0.2.1 上产生的游戏无法被 0.1.5 打开；要保留请先导出 `.dshsave`。
- Pocket 2.12.0 必须同时打两个补丁（服务控制 + 去掉与 dsh-web-mobile 重复的手机适配），否则 0.2.1 报重复注册。
- 不要使用应用内“检查更新”：它对照上游发布版，会覆盖 fork 的版本。

## 安全约定

不读取、不拷贝、不打印：`settings.yaml`、`dsh-pocket` 数据目录（PIN/令牌）、访问令牌。模型配置由使用者自己放入。
