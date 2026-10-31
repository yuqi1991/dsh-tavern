# 同步上游的工具与本地配置

策略：**merge + rerere，不 rebase**。上游分支 `upstream-sync` 只做 `--ff-only` 跟随 `upstream/main`，里面没有我们的改动，不 push。

## 一次性准备（本地配置，不改全局）

```
bin/setup-sync.sh            # 幂等；加 --fetch 先 git fetch upstream
```

它做三件事（都只写本仓库 `.git/config`）：

- `git config rerere.enabled true`、`rerere.autoupdate true`：记住冲突解法，下次同样冲突自动套用并暂存。
- `git config merge.ours.driver true`：让 `.gitattributes` 里标了 `merge=ours` 的生成文件在冲突时取我们这边。**这是本地配置，新克隆/新机器要重新跑 setup-sync.sh**，否则 `merge=ours` 不生效（git 会当作未知驱动，按默认合并）。
- 创建/快进 `upstream-sync` 分支到 `upstream/main`；如果它不是 `upstream/main` 的祖先（有人放了别的东西），脚本拒绝处理并报错。

## 工具

| 工具 | 用途 |
|---|---|
| `node bin/upstream-ledger.mjs pending [--limit N]` | 列出 `5ae0c1f5..upstream/main` 非合并提交里**不在** `docs/upstream-port/ledger.tsv` 的（按日期升序，附触及文件数、触及共享文件数） |
| `node bin/upstream-ledger.mjs mark <hash> <ported\|partial\|skipped\|n-a\|unknown> <备注> [--ours <提交>]` | 追加/更新记录 |
| `node bin/upstream-ledger.mjs stats` | 各状态计数 |
| `node bin/fork-delta.mjs [--md\|--json]` | 我们独有文件与共享文件清单；人工分析见 `docs/fork-delta.md` |
| `bin/upstream-dry-run.sh [<ref>\|<A>..<B>\|<提交…>]` | 临时 worktree 试合并/逐个 cherry-pick，输出冲突块数、是否生成文件、是否共享文件；`RERERE=1` 使用已记录解法，`KEEP=1` 保留临时目录 |
| `bin/regen.sh [--check]` | 重建并校验生成文件（client.js、plugin.patch.yml、MVU schema、docs/index.html） |

### ledger 的可信度

`ledger.tsv` 是**首批种子**，不是逐提交审计：

- 来源是 PLAN.md 各批说明（按分句的关键词启发式 + 人工校订）、我们提交说明里出现的上游哈希、与上游同标题的提交、以及“触及的文件现与 upstream/main 逐字节相同”的推断（备注里写明“内容等同（推断）”）。
- 批 0 把客户端整体换成上游拆分布局、`-s ours` 合并，没有逐提交记录，所以大量上游提交**既不在表里、其效果又已在树里**。这些会出现在 `pending` 里，需要在下次同步前按文件范围分批核销（用 `mark` 批量标记，或先看 `shared` 列为 0 的提交）。
- PLAN.md 写“未取”但后来被我们的功能提交覆盖的项（手机布局链、预设合并页等）标为 `partial` 并注明“逐提交覆盖未核对”。
- `unknown` 只用于无法判定的项（目前 1 条）。

当前计数（2026-10-31）：见下方“基线”。

## 难度基线（2026-10-31，对 `upstream/main` = 84bf905c 的整体试合并）

`bin/upstream-dry-run.sh`（rerere 关闭；merge-base 为早先的 `-s ours` 合并点）：

| | 加 merge=ours 规则前 | 加规则后 |
|---|---|---|
| 冲突文件 | 491 | 488 |
| 冲突块 | 1001 | 817 |
| 生成文件冲突 | 4 个 / 89 块（client.js、docs/index.html、plugin.patch.yml、tavern-plugin/pnpm-lock.yaml） | 2 个 / 2 块（docs/index.html、plugin.patch.yml：**上游已删除这两个文件**，modify/delete，驱动不适用，需决定保留或删除） |
| 需手工处理 | 487 文件 / 912 块 | 486 文件 / 815 块 |
| 其中测试文件 | 147 | 147 |
| 在 fork-delta 共享清单内 | 59 | 60 |

（`dsh-tavern-runtime.json` 是上游 CI 发布的清单，原来一个文件占 97 块，现取我们这边。）

读法：真正的难度在 ~340 个非测试文件、~660 块；其中块数最多的是 `tavern-plugin/lib/index.js`（60 块）、`play-controls.js`（19）、`main.js`（14）、`sidebar.js`（13）、`round-history.js`（13）。**一次性整体合并不现实，应分批**（见 SYNC-PLAYBOOK.md）。上游已删除 `plugin.patch.yml`、`docs/index.html`，并退役原生场景生图后端：这些是需要先做的产品/打包决定。

对 3 个提交的 cherry-pick 预演示例：`bin/upstream-dry-run.sh f06726e6 0c18f25e ffbdb60b` → 8 个冲突文件 / 21 块，其中 client.js 8 块为生成文件。

## pnpm-lock.yaml

`merge=ours` 只保证文件不进入冲突状态；上游若在 `package.json` 里加了依赖，我们的 lock 不会包含它。**不要在 fork 里跑 `pnpm add/install`**（会改动线上依赖）。处理步骤：

1. 合并后 `git diff <合并前>..HEAD -- '**/package.json'` 看依赖是否有变化；没有变化则 lock 不用动。
2. 有变化：在**另一份干净拷贝**（如 `/tmp` 下新克隆）里 `pnpm install --lockfile-only`，把生成的 lock 人工比对后拷回，单独一个提交说明原因。
3. 有疑问就取上游的 lock 并让使用者决定。
