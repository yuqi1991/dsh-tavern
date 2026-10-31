#!/usr/bin/env bash
# 上游同步预演：在 /tmp 临时 worktree 里试合并，不碰当前工作区；结束或中断时一定清理。
#   bin/upstream-dry-run.sh                      # 试合并 $UPSTREAM（默认 upstream/main）：merge --no-commit --no-ff
#   bin/upstream-dry-run.sh <ref>                # 试合并某个引用/提交
#   bin/upstream-dry-run.sh <A>..<B>             # 范围内非合并提交逐个 cherry-pick -n（冲突后取我们这边继续，记录每个提交的冲突）
#   bin/upstream-dry-run.sh <c1> <c2> ...        # 提交列表，同上
# 环境变量：UPSTREAM；RERERE=1 让预演使用 rerere 已记录的解法（默认关闭，量的是“裸”难度）；KEEP=1 保留临时目录便于查看。
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
REPO=$(pwd)
UPSTREAM=${UPSTREAM:-upstream/main}
WT=$(mktemp -d /tmp/upstream-dry-run.XXXXXX)
rmdir "$WT"            # git worktree add 需要不存在或为空目录；这里让它自己建
CREATED=0
cleanup() {
  local rc=$?
  trap - EXIT INT TERM HUP
  if [ "${KEEP:-0}" = 1 ] && [ "$CREATED" = 1 ]; then
    echo "[dry-run] KEEP=1，保留 $WT（用完执行：git worktree remove --force $WT）" >&2
  else
    if [ "$CREATED" = 1 ]; then git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1; fi
    rm -rf "$WT"
    git -C "$REPO" worktree prune >/dev/null 2>&1
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

GITC=(git -c rerere.enabled=false -c user.name=dry-run -c user.email=dry-run@invalid)
if [ "${RERERE:-0}" = 1 ]; then GITC=(git -c user.name=dry-run -c user.email=dry-run@invalid); fi

git worktree add --detach "$WT" HEAD >/dev/null 2>&1 || { echo "无法创建临时 worktree" >&2; exit 2; }
CREATED=1
cd "$WT" || exit 2

MODE=merge
PICKS=()
if [ $# -eq 0 ]; then
  TARGET=$UPSTREAM
elif [ $# -eq 1 ] && [[ "$1" != *..* ]]; then
  TARGET=$1
elif [ $# -eq 1 ]; then
  MODE=pick
  mapfile -t PICKS < <(git rev-list --reverse --no-merges "$1")
else
  MODE=pick
  PICKS=("$@")
fi

CONFLICT_LOG=$(mktemp /tmp/dry-run-conflicts.XXXXXX)
trap 'rm -f "$CONFLICT_LOG"; cleanup' EXIT

record_conflicts() { # $1 = 标签（提交号或 merge）
  local f n
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    n=$(grep -c '^<<<<<<< ' "$f" 2>/dev/null || true)
    [ "${n:-0}" -eq 0 ] && n=1   # 删改冲突/二进制：没有标记，按 1 处结构性冲突计
    printf '%s\t%s\t%s\n' "$1" "$n" "$f" >> "$CONFLICT_LOG"
  done < <(git diff --name-only --diff-filter=U)
}

if [ "$MODE" = merge ]; then
  echo "[dry-run] 试合并 $TARGET -> $(git -C "$REPO" rev-parse --short HEAD)（临时 worktree $WT）"
  "${GITC[@]}" merge --no-commit --no-ff "$TARGET" >/dev/null 2>&1
  record_conflicts merge
else
  echo "[dry-run] 逐个 cherry-pick -n，共 ${#PICKS[@]} 个提交"
  for c in "${PICKS[@]}"; do
    if ! "${GITC[@]}" cherry-pick -n "$c" >/dev/null 2>&1; then
      record_conflicts "$(git rev-parse --short "$c")"
      # 冲突文件取我们这边（含 AA/DU 之类），让后续提交还能继续
      git diff --name-only --diff-filter=U | while IFS= read -r f; do
        git checkout --ours -- "$f" >/dev/null 2>&1 || git rm -q --cached -- "$f" >/dev/null 2>&1
        git add -- "$f" >/dev/null 2>&1 || true
      done
      git cherry-pick --quit >/dev/null 2>&1 || true
    fi
  done
fi

cd "$REPO" || exit 2
TOTAL_FILES=0; TOTAL_BLOCKS=0; MAN_FILES=0; MAN_BLOCKS=0; GEN_FILES=0; GEN_BLOCKS=0; TEST_FILES=0; SHARED_MAN=0
if [ -s "$CONFLICT_LOG" ]; then
  # 按文件汇总（pick 模式下同一文件可能在多个提交里冲突）
  AGG=$(awk -F'\t' '{n[$3]+=$2; c[$3]=c[$3] (c[$3]?",":"") $1} END{for(f in n) printf "%s\t%d\t%s\n", f, n[f], c[f]}' "$CONFLICT_LOG" | sort)
  CLS=$(printf '%s\n' "$AGG" | cut -f1 | node "$REPO/bin/fork-delta.mjs" --classify)
  printf '\n%-6s %-9s %-7s %s\n' 块数 类别 共享清单 文件
  while IFS=$'\t' read -r f n commits; do
    cls=$(printf '%s\n' "$CLS" | awk -F'\t' -v f="$f" '$1==f{print $2"\t"$3"\t"$4}')
    gen=$(printf '%s' "$cls" | cut -f1); sh=$(printf '%s' "$cls" | cut -f2); ts=$(printf '%s' "$cls" | cut -f3)
    kind=手工; [ "$gen" = generated ] && kind=生成; [ "$ts" = test ] && kind=测试
    # 被 merge=ours/.gitattributes 标记的生成文件在 merge 模式下不会出现；若仍出现，说明规则没生效
    printf '%-6s %-9s %-7s %s' "$n" "$kind" "$([ "$sh" = shared ] && echo 是 || echo 否)" "$f"
    [ "$MODE" = pick ] && printf '   [%s]' "$commits"
    if [ "$MODE" = merge ] && [ "$kind" = 生成 ]; then
      stages=$(git -C "$WT" ls-files -u -- "$f" | awk '{print $3}' | sort -u | tr -d '\n')
      case "$stages" in *3*) ;; *) printf '   (上游已删除该文件：modify/delete，merge=ours 不适用，需决定保留或删除)' ;; esac
    fi
    printf '\n'
    TOTAL_FILES=$((TOTAL_FILES+1)); TOTAL_BLOCKS=$((TOTAL_BLOCKS+n))
    if [ "$kind" = 生成 ]; then GEN_FILES=$((GEN_FILES+1)); GEN_BLOCKS=$((GEN_BLOCKS+n))
    elif [ "$kind" = 测试 ]; then TEST_FILES=$((TEST_FILES+1)); MAN_FILES=$((MAN_FILES+1)); MAN_BLOCKS=$((MAN_BLOCKS+n))
    else MAN_FILES=$((MAN_FILES+1)); MAN_BLOCKS=$((MAN_BLOCKS+n)); [ "$sh" = shared ] && SHARED_MAN=$((SHARED_MAN+1)); fi
  done <<< "$AGG"
fi
echo
echo "== 总评（$([ "$MODE" = merge ] && echo "merge $TARGET" || echo "cherry-pick ${#PICKS[@]} 个提交")）=="
echo "冲突文件 $TOTAL_FILES 个 / 冲突块 $TOTAL_BLOCKS"
echo "  生成文件（应由 regen 重建，不算手工）：$GEN_FILES 个 / $GEN_BLOCKS 块"
echo "  需手工处理：$MAN_FILES 个文件 / $MAN_BLOCKS 块（其中测试文件 $TEST_FILES 个；在 fork-delta 共享清单内 $SHARED_MAN 个）"
rm -f "$CONFLICT_LOG"
