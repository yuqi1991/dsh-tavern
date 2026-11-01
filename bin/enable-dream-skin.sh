#!/usr/bin/env bash
# 在生产 profile 里启用 dsh-dream-skin（0.2.1 部署时漏掉的，0.1.5 里原本有）。
# 用法（由使用者执行）： bin/enable-dream-skin.sh
# 步骤：备份 profile 的 package.json → 建软链 → bundles 里加 dsh-dream-skin → 停 3081/3082 → 重启 → 报告日志。
# 恢复：把备份里的 package.json 拷回、删掉 node_modules/dsh-dream-skin 软链，再重启。
set -euo pipefail
PROD="${PROD_HOME:-/home/claw/workspace/dsh-tarvern}"
PROFILE="$PROD/profiles/tavern"
BACKUP="${SKIN_BACKUP:-/home/claw/backups/enable-dream-skin-$(date +%Y%m%d%H%M%S)}"
die() { echo "enable-dream-skin: $*" >&2; exit 1; }

[ -f "$PROFILE/package.json" ] || die "找不到 $PROFILE/package.json"
[ -f "$PROD/apps/dsh-tavern/tavern-plugin/packages/dsh-dream-skin/lib/index.js" ] || die "发布树里没有 dsh-dream-skin"
grep -q '"@deepseek-ai/dsh-client-ui-theme": ">=0.1.0-rc.6 <0.3.0"' "$PROD/apps/dsh-tavern/tavern-plugin/packages/dsh-dream-skin/package.json" \
  || die "发布树里的 dsh-dream-skin 还不是适配 0.2.1 的版本，请先部署 deploy-021-20261101"
grep -q '"dsh-dream-skin"' "$PROFILE/package.json" && die "bundles 里已经有 dsh-dream-skin，无需重复操作"
[ -e "$PROFILE/node_modules/dsh-dream-skin" ] && die "node_modules 里已经有 dsh-dream-skin"

mkdir -p "$BACKUP"; cp -a "$PROFILE/package.json" "$BACKUP/package.json"; echo "已备份到 $BACKUP"

pid="$(ss -ltnp 2>/dev/null | grep '127.0.0.1:3081 ' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1 || true)"
[ -n "$pid" ] && { echo "停止生产进程 pid $pid"; kill "$pid"; }
for _ in $(seq 1 30); do ss -ltn 2>/dev/null | grep -qE "[:.](3081|3082) " || break; sleep 1; done
ss -ltn 2>/dev/null | grep -qE "[:.](3081|3082) " && die "3081/3082 仍被占用，已中止（profile 尚未修改）"

ln -s ../../../apps/dsh-tavern/tavern-plugin/packages/dsh-dream-skin "$PROFILE/node_modules/dsh-dream-skin"
node -e '
const fs=require("fs"),p=process.argv[1],d=JSON.parse(fs.readFileSync(p,"utf8"));
const b=d.dsh.profile.bundles; b.splice(b.indexOf("dsh-better-sidebar")+1,0,"dsh-dream-skin");
fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' "$PROFILE/package.json"
[ -f "$PROFILE/node_modules/dsh-dream-skin/lib/index.js" ] || die "软链不可用"
grep -q '"dsh-dream-skin"' "$PROFILE/package.json" || die "bundles 修改失败"
echo "profile 已修改"

cd "$PROD"
DSH_HOME="$PROD" DSH_TAVERN_CLI_HOME="$PROD" DSH_TAVERN_RUNTIME_HOST=cli DSH_TAVERN_LEGACY_DSH_HOME=/home/claw/.dsh \
  setsid nohup node runtime/bin/dsh --profile tavern --host 127.0.0.1 --port 3081 --no-open >> logs/tavern.log 2>&1 < /dev/null &
disown
for _ in $(seq 1 90); do ss -ltn 2>/dev/null | grep -q "[:.]3081 " && break; sleep 1; done
sleep 10
ss -ltnp 2>/dev/null | grep -E ":(3081|3082) " | sed -E 's/users:.*pid=([0-9]+).*/pid=\1/'
echo "HTTP 3081: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3081/)  3082: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3082/)"
echo "--- 日志中与皮肤/未激活相关的行："
tail -n 60 logs/tavern.log | grep -iE "dream|did not activate|skipping" | cut -c1-200 || echo "（无）"
echo "完成。令牌已变，请自行取新链接。"
