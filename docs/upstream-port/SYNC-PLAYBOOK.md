# 下次同步上游：剧本

原则：**merge + rerere，不 rebase**；小步、每批一次 merge；每批都能单独验证、单独回退。工具说明与难度基线见 [SYNC-TOOLS.md](SYNC-TOOLS.md)，我们改过的共享文件见 [../fork-delta.md](../fork-delta.md)。

## 0. 新环境第一次

```
bin/setup-sync.sh --fetch     # rerere、merge.ours 驱动、upstream-sync 分支（本地配置，换机器要重跑）
```

## 1. 看清楚还差什么

1. `git fetch upstream && bin/setup-sync.sh` —— `upstream-sync` 只做 `--ff-only` 跟随，不放我们的改动。
2. `node bin/upstream-ledger.mjs pending | head -50` —— 还没处理的上游提交；`shared` 列大于 0 的是会碰到我们改过的文件的。先把 `shared=0` 且文件已与上游一致的批量核销（`mark … ported 内容等同`），剩下的才是真工作。
3. 对照 `docs/fork-delta.md`：这次上游动了哪些热点文件（`tavern-plugin/lib/index.js`、`play-controls.js`、`main.js`、`round-history.js` 等）。先决定产品分叉：上游已删 `plugin.patch.yml`/`docs/index.html`，并退役了原生场景生图后端——跟随还是继续维护，需要使用者拍板，不要在合并里边冲突边决定。
4. `bin/upstream-dry-run.sh`（整体）或 `bin/upstream-dry-run.sh <A>..<B>`（候选批）—— 看冲突文件数/块数。目标是每批手工文件 ≲ 10、块 ≲ 30；超了就把范围切小（按日期或按功能）。

## 2. 分批合并（每批一个 merge，不 rebase）

在从 `upgrade/…` 切出的同步分支上，每批：

```
git switch -c sync/<日期>-<批名> <当前主线>
git merge --no-ff --no-commit <批的结束提交>   # upstream-sync 上选一个提交，不要一次合到 tip
# 生成文件冲突已自动取我们这边；其余手工解，rerere 会记住解法
bin/regen.sh                                   # 重建 client.js、plugin.patch.yml、MVU schema、docs/index.html 并校验
git commit                                      # merge 提交，说明本批范围
node bin/upstream-ledger.mjs mark <hash> ported|partial|skipped|n-a "<理由>"   # 本批每个提交都登记
bin/test-all.sh                                 # 必须全绿；新增失败当场修，不攒着
```

注意：

- 凡写 surface 的文件（round-history、rollback-surface、body-editor、story-timeline、session-surface-mutations 等）不要取上游整文件；按功能手工合，逻辑往 `lib/domain/conversation-algebra/` 收。
- `pnpm-lock.yaml` 取我们这边后若上游改了 `package.json` 依赖，按 SYNC-TOOLS.md 的“pnpm-lock.yaml”一节人工处理，不要在 fork 里 `pnpm add/install`。`dsh-image-gen`、`dsh-tavern-remote` 的 `lib/` 是包自己的构建产物，改了源码就要在对应包里重建。
- 解冲突时能把我们的逻辑挪进自己的文件就挪（薄挂钩），并更新 `docs/fork-delta.md`。
- 每批合并后刷新 ledger：没登记的提交下次还会出现在 `pending` 里。

## 3. 内核（DSH）升级单独做

- 与上游同步**分开**：先同步完、测试全绿、部署稳定，再升内核；或先升内核、再同步，二者不要混在一个批里。
- 换内核必须用另一个目录并行验证（`bin/stage-021.sh` 这类暂存实例），不原地升级；先冻结备份。
- 参考 `docs/upstream-port/analysis/kernel-0.2.1.md`：补丁锚点自检、日志格式是否单向、会话补丁在新内核上是否仍装得上（`getSessionPatchStatus`）。

## 4. 发布前

1. `bin/regen.sh --check`、`bin/test-all.sh`（两次连跑稳定）。
2. 打发布标签（形如 `deploy-<版本>-<日期>`，只在使用者同意后）。
3. `DEPLOY_TAG=<标签> bin/deploy.sh stage` —— 暂存发布树，末尾与旧发布树对比文件清单；有缺失会非零退出，**逐项确认是有意删除**才能 `ALLOW_MISSING=1`。
4. `bin/deploy.sh check` —— 暂存区起空实例核对启动与补丁自检（非生产端口）。
5. 验收实例（`bin/stage-021.sh`，3092/3093）上跑 e2e：`node tests/e2e/gameplay.mjs` 及相关 `--…` 场景；让使用者验收。
6. 使用者同意后：`CONFIRM=yes bin/deploy.sh cutover`。部署后 `bin/deploy.sh verify` 逐字节核对。

## 5. 备份点与回退

- 部署前备份（上次）：`/home/claw/backups/dsh-pre-deploy-20261031/`（生产家目录只读拷贝、runtime/apps/profiles 的 sha256、git bundle、README 里有恢复命令）。下次用 `DEPLOY_BACKUP=<新目录>` 并在部署前建好。
- git 保护点：标签 `pre-dsh021-upgrade-20261028`（升级前）、`deploy-021-20261031`（上次发布）、分支 `backup/pre-dsh021-20261028`。每次大同步前也打一个 `pre-sync-<日期>` 标签。
- 回退：`CONFIRM=yes bin/deploy.sh rollback`（旧目录是改名保留的，游戏数据归档而非删除）；权威恢复方式见备份目录 README。0.2.1 上产生的游戏旧内核打不开，要保留先导出 `.dshsave`。
- 同步分支出问题：直接丢弃 `sync/…` 分支；`upstream-sync` 与主线不受影响。rerere 记录在 `.git/rr-cache`，丢分支不丢解法。
