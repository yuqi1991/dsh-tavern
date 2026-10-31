#!/usr/bin/env bash
# 幂等地为“跟随上游同步”准备本仓库的本地配置（只写本仓库 .git/config，不碰全局配置，不 push）：
#   - rerere：记住冲突解法，autoupdate 让已记录的解法自动暂存
#   - merge.ours 驱动：.gitattributes 里标成 merge=ours 的生成文件，冲突时取我们这边（之后用 bin/regen.sh 重建）
#   - upstream-sync 分支：只跟踪 upstream/main，只允许 --ff-only 更新，不放任何我们的改动
# 用法：bin/setup-sync.sh [--fetch]   # --fetch 先 git fetch upstream（需要网络）
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
UPSTREAM_REMOTE=${UPSTREAM_REMOTE:-upstream}
UPSTREAM_BRANCH=${UPSTREAM_BRANCH:-main}

git config rerere.enabled true
git config rerere.autoupdate true
git config merge.ours.driver true
echo "[setup-sync] rerere.enabled=$(git config rerere.enabled) autoupdate=$(git config rerere.autoupdate) merge.ours.driver=$(git config merge.ours.driver)"

if [ "${1:-}" = "--fetch" ]; then git fetch "$UPSTREAM_REMOTE"; fi

REF="refs/remotes/$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git rev-parse --verify -q "$REF" >/dev/null || { echo "[setup-sync] 缺少 $UPSTREAM_REMOTE/$UPSTREAM_BRANCH，先 git fetch $UPSTREAM_REMOTE" >&2; exit 1; }

if git rev-parse --verify -q refs/heads/upstream-sync >/dev/null; then
  cur=$(git rev-parse refs/heads/upstream-sync)
  if [ "$cur" = "$(git rev-parse "$REF")" ]; then
    echo "[setup-sync] upstream-sync 已是最新 ($(git rev-parse --short "$cur"))"
  elif git merge-base --is-ancestor "$cur" "$REF"; then
    # 只做快进：不检出该分支，直接移动引用（若它正被某个 worktree 检出则拒绝）
    if git worktree list --porcelain | grep -q '^branch refs/heads/upstream-sync$'; then
      echo "[setup-sync] upstream-sync 正被某个 worktree 检出，请在那里执行 git merge --ff-only $UPSTREAM_REMOTE/$UPSTREAM_BRANCH" >&2
    else
      git update-ref -m "setup-sync: fast-forward to $UPSTREAM_REMOTE/$UPSTREAM_BRANCH" refs/heads/upstream-sync "$(git rev-parse "$REF")" "$cur"
      echo "[setup-sync] upstream-sync 快进到 $(git rev-parse --short "$REF")"
    fi
  else
    echo "[setup-sync] 警告：upstream-sync 不是 $UPSTREAM_REMOTE/$UPSTREAM_BRANCH 的祖先（里面有别的东西？）。不自动处理，请人工检查。" >&2
    exit 1
  fi
else
  git branch --track upstream-sync "$REF" >/dev/null
  echo "[setup-sync] 已创建 upstream-sync -> $(git rev-parse --short "$REF")"
fi
