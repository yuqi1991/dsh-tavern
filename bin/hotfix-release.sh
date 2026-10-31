#!/usr/bin/env bash
# 就地更新生产发布树里的少数文件（相对上次部署 deploy-021-20261031 的差异），逐字节核对后重启。
# 用法（由使用者执行）： bin/hotfix-release.sh [标签]   默认标签 deploy-021-20261031b
# 步骤：备份将被覆盖的文件 → 停 3081/3082 → 覆盖 → 逐字节核对 → 语法检查 → 重启 → 报告端口。
# 任一步失败即停止；旧文件在备份目录，恢复只需把它们拷回原位后重启。
set -euo pipefail
FORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-deploy-021-20261031b}"
PROD="${PROD_HOME:-/home/claw/workspace/dsh-tarvern}"
REL="$PROD/apps/dsh-tavern"
BASE_TAG="${BASE_TAG:-deploy-021-20261031}"
BACKUP="${HOTFIX_BACKUP:-/home/claw/backups/hotfix-$TAG-$(date +%Y%m%d%H%M%S)}"
die() { echo "hotfix: $*" >&2; exit 1; }

git -C "$FORK" rev-parse --verify -q "$TAG^{commit}" >/dev/null || die "标签 $TAG 不存在"
mapfile -t FILES < <(git -C "$FORK" diff --name-only "$BASE_TAG" "$TAG" -- tavern-plugin | grep -v '/tests/' | grep -v '\.map$')
[ "${#FILES[@]}" -gt 0 ] || die "没有需要更新的文件"
echo "将更新 ${#FILES[@]} 个文件："; printf '  %s\n' "${FILES[@]}"
for f in "${FILES[@]}"; do
  case "$f" in tavern-plugin/*) ;; *) die "只允许 tavern-plugin 下的文件：$f";; esac
  [ -f "$REL/$f" ] || die "生产里没有该文件（新增文件请走完整部署）：$f"
done

mkdir -p "$BACKUP"
for f in "${FILES[@]}"; do mkdir -p "$BACKUP/$(dirname "$f")"; cp -a "$REL/$f" "$BACKUP/$f"; done
echo "已备份到 $BACKUP"

pid="$(ss -ltnp 2>/dev/null | grep '127.0.0.1:3081 ' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1 || true)"
[ -n "$pid" ] && { echo "停止生产进程 pid $pid"; kill "$pid"; }
for _ in $(seq 1 30); do ss -ltn 2>/dev/null | grep -qE "[:.](3081|3082) " || break; sleep 1; done
ss -ltn 2>/dev/null | grep -qE "[:.](3081|3082) " && die "3081/3082 仍被占用，已中止（文件尚未覆盖）"

for f in "${FILES[@]}"; do git -C "$FORK" show "$TAG:$f" > "$REL/$f.new" && mv "$REL/$f.new" "$REL/$f"; done
for f in "${FILES[@]}"; do git -C "$FORK" show "$TAG:$f" | cmp - "$REL/$f" || die "核对失败：$f"; done
for f in "${FILES[@]}"; do case "$f" in *.js) node --check "$REL/$f" >/dev/null || die "语法错误：$f";; esac; done
echo "覆盖完成，逐字节核对与语法检查通过"

cd "$PROD"
DSH_HOME="$PROD" DSH_TAVERN_CLI_HOME="$PROD" DSH_TAVERN_RUNTIME_HOST=cli DSH_TAVERN_LEGACY_DSH_HOME=/home/claw/.dsh \
  setsid nohup node runtime/bin/dsh --profile tavern --host 127.0.0.1 --port 3081 --no-open >> logs/tavern.log 2>&1 < /dev/null &
disown
for _ in $(seq 1 90); do ss -ltn 2>/dev/null | grep -q "[:.]3081 " && break; sleep 1; done
sleep 8
ss -ltnp 2>/dev/null | grep -E ":(3081|3082) " | sed -E 's/users:.*pid=([0-9]+).*/pid=\1/'
echo "HTTP 3081: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3081/)  3082: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3082/)"
echo "完成。令牌已变，请自行取新链接。"
