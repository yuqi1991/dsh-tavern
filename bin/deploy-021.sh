#!/usr/bin/env bash
# 生产部署：DSH 0.1.5-rc.2 → 0.2.1-rc.2（含 fork 上游移植批）。
#
#   bin/deploy-021.sh stage      在暂存区 $S 构建 runtime / apps / profile（不碰生产）
#   bin/deploy-021.sh check      在暂存区用非生产端口起一个空实例，核对启动与补丁自检
#   bin/deploy-021.sh cutover    停旧服务、换运行时与发布树、归档旧游戏数据、起新服务（需 CONFIRM=yes）
#   bin/deploy-021.sh rollback   回到部署前（需 CONFIRM=yes）；权威恢复方式见备份目录 README
#   bin/deploy-021.sh verify     逐字节核对安装树与发布提交
#
# 不读取、不拷贝任何密钥：settings.yaml、dsh-pocket 数据目录、令牌都留在原处不动。
set -euo pipefail

FORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${DEPLOY_TAG:-deploy-021-20261031}"
S="${DEPLOY_STAGE:-/home/claw/dsh-deploy-021}"
STAGE021="${STAGE021_BASE:-/home/claw/dsh-stage-021}"
PROD="${PROD_HOME:-/home/claw/workspace/dsh-tarvern}"
BACKUP="${DEPLOY_BACKUP:-/home/claw/backups/dsh-pre-deploy-20261031}"
OLD_SUFFIX="0.1.5-pre-deploy"
ARCHIVE="$PROD/profile-data/tavern/archive-0.1.5-20261031"
CHECK_PORT="${DEPLOY_CHECK_PORT:-3095}"
CHECK_POCKET_PORT="${DEPLOY_CHECK_POCKET_PORT:-3096}"

die() { echo "deploy-021: $*" >&2; exit 1; }

# 旧游戏与会话相关的数据：整体移到归档目录，不删除。人物卡、预设、世界书、资源、设置等保留。
GAME_DATA=(chats model-requests model-request-sessions diagnostics worldbook-recalls cache mvu-drafts mvu-draft-sessions
  template-work scene-images legacy-id-storage diffs card-memory index.json sessions.json card-projection-revisions.json
  background-session-retirement.json prompt-template-variables.json update-diagnostics.jsonl update-status.json)

ss_listening() { ss -ltn 2>/dev/null | grep -q "[:.]$1 "; }

stage() {
  [ -d "$STAGE021/runtime" ] && [ -d "$STAGE021/root-nm" ] && [ -d "$STAGE021/plugin/node_modules" ] || die "找不到已验证的 stage-021 运行时/依赖"
  [ ! -e "$S" ] || die "$S 已存在，先改名或删除"
  git -C "$FORK" rev-parse --verify -q "$TAG^{commit}" >/dev/null || die "标签 $TAG 不存在"
  mkdir -p "$S/apps/dsh-tavern" "$S/profiles/tavern/node_modules" "$S/profile-data/tavern/data" "$S/logs"
  echo "1/6 运行时：拷贝已验证的 0.2.1 运行时"
  cp -a "$STAGE021/runtime" "$S/runtime"
  echo "2/6 发布树：git archive $TAG（只含发布需要的路径）"
  git -C "$FORK" archive "$TAG" -- bin config presets tavern-plugin patches package.json pnpm-lock.yaml pnpm-workspace.yaml \
    cordis.patch.yml plugin.patch.yml install.sh install.ps1 LICENSE dsh-tavern-runtime.json | tar -x -C "$S/apps/dsh-tavern"
  find "$S/apps/dsh-tavern" \( -name tests -o -name upstream \) -type d -prune -exec rm -rf {} + 2>/dev/null || true
  find "$S/apps/dsh-tavern" -name '*.map' -type f -delete
  printf '{"host":"cli","dshHome":"%s"}\n' "$PROD" > "$S/apps/dsh-tavern/.dsh-tavern-local.json"
  printf '{"commit":"%s","installedAt":"%s"}\n' "$(git -C "$FORK" rev-parse "$TAG^{commit}")" "$(date -u +%FT%TZ)" > "$S/apps/dsh-tavern/.dsh-tavern-release.json"
  echo "3/6 依赖：插件依赖与根依赖（拷贝已验证的那套）"
  cp -a "$STAGE021/plugin/node_modules" "$S/apps/dsh-tavern/tavern-plugin/node_modules"
  cp -a "$STAGE021/root-nm" "$S/apps/dsh-tavern/node_modules"
  # 指向运行时的包用相对链接，随目录整体移动仍然成立。
  for pkg in "$S/apps/dsh-tavern/tavern-plugin/node_modules/@deepseek-ai"/*; do
    [ -L "$pkg" ] || continue
    ln -sfn "../../../../../runtime/lib/node_modules/@deepseek-ai/$(basename "$pkg")" "$pkg"
  done
  echo "4/6 profile：链接发布树、拷贝侧栏与 Pocket（含两个补丁）"
  local P="$S/profiles/tavern" R="$S/apps/dsh-tavern/node_modules"
  ln -s ../../../apps/dsh-tavern/tavern-plugin "$P/node_modules/dsh-tavern-plugin"
  ln -s ../../../apps/dsh-tavern/tavern-plugin/packages/dsh-tavern-remote "$P/node_modules/dsh-tavern-remote"
  ln -s ../../../runtime/lib/node_modules/@deepseek-ai "$P/node_modules/@deepseek-ai"
  cp -a "$R/dsh-better-sidebar" "$P/node_modules/dsh-better-sidebar"
  cp -a "$R/dsh-pocket" "$P/node_modules/dsh-pocket"
  local entry name
  for entry in "$R"/*; do
    name="$(basename "$entry")"
    case "$name" in .*|@deepseek-ai|dsh-tavern-plugin|dsh-tavern-remote|dsh-better-sidebar|dsh-pocket|dsh-dream-skin) continue;; esac
    [ -e "$P/node_modules/$name" ] || ln -s "../../../apps/dsh-tavern/node_modules/$name" "$P/node_modules/$name"
  done
  patch_pocket "$P/node_modules/dsh-pocket"
  [ -e "$P/node_modules/dsh-web-mobile" ] || die "profile 里缺 dsh-web-mobile"
  [ -e "$P/node_modules/qrcode" ] || die "profile 里缺 qrcode（Pocket 二维码依赖）"
  printf '%s\n' '{ "name": "tavern-production", "private": true, "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-better-sidebar", "dsh-tavern-plugin", "dsh-tavern-remote", "dsh-web-mobile", "dsh-pocket"] } } }' > "$P/package.json"
  cp "$STAGE021/home/profiles/tavern/cordis.yml" "$P/cordis.yml"
  printf '[]\n' > "$P/cordis.patch.yml"
  echo "5/6 自检：暂存区文件与标签提交逐字节一致"
  verify_tree "$S"
  echo "6/6 完成：$S"
}

patch_pocket() {
  local dest="$1" marker='PocketSettingsWithServiceControl'
  grep -q "$marker" "$dest/client/client.js" || patch -p1 -d "$dest" < "$FORK/patches/dsh-pocket@2.12.0.patch" >/dev/null || die "dsh-pocket 补丁应用失败"
  grep -q "$marker" "$dest/client/client.js" || die "dsh-pocket 补丁未生效"
  grep -q '^  mobileApply(ctx);' "$dest/client/client.js" && { patch -p1 -d "$dest" < "$FORK/patches/dsh-pocket@2.12.0-no-mobile.patch" >/dev/null || die "dsh-pocket 去重补丁应用失败"; }
  grep -q '^  mobileApply(ctx);' "$dest/client/client.js" && die "dsh-pocket 去重补丁未生效"
  return 0
}

# 发布树里每个来自 git 的文件，都必须与标签提交里的内容逐字节一致。
verify_tree() {
  local root="$1" bad=0 f
  local tmp; tmp="$(mktemp -d)"
  git -C "$FORK" archive "$TAG" -- bin config presets tavern-plugin patches package.json pnpm-lock.yaml pnpm-workspace.yaml \
    cordis.patch.yml plugin.patch.yml install.sh install.ps1 LICENSE dsh-tavern-runtime.json | tar -x -C "$tmp"
  while IFS= read -r -d '' f; do
    f="${f#./}"
    case "$f" in */tests/*|*/upstream/*|*.map) continue;; esac
    if ! cmp -s "$tmp/$f" "$root/apps/dsh-tavern/$f"; then echo "不一致：$f" >&2; bad=1; fi
  done < <(cd "$tmp" && find . -type f -print0)
  rm -rf "$tmp"
  [ "$bad" = 0 ] || die "安装树与标签提交 $TAG 不一致"
  echo "  逐字节核对通过（标签 $TAG）"
}

check() {
  [ -d "$S/runtime" ] || die "先运行 stage"
  ss_listening "$CHECK_PORT" && die "端口 $CHECK_PORT 已被占用"
  ss_listening "$CHECK_POCKET_PORT" && die "端口 $CHECK_POCKET_PORT 已被占用"
  mkdir -p "$S/dsh-pocket"
  printf '{"proxyPort": %s}\n' "$CHECK_POCKET_PORT" > "$S/dsh-pocket/settings.json"; chmod 600 "$S/dsh-pocket/settings.json"
  : > "$S/logs/check.log"
  (cd "$S" && env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C.UTF-8}" DSH_HOME="$S" DSH_CWD="$S" \
    setsid nohup node "$S/runtime/bin/dsh" --profile tavern --host 127.0.0.1 --port "$CHECK_PORT" --no-open < /dev/null >> "$S/logs/check.log" 2>&1 &
    echo $! > "$S/check.pid")
  local pid; pid="$(cat "$S/check.pid")"
  for _ in $(seq 1 90); do grep -q "127.0.0.1:$CHECK_PORT" "$S/logs/check.log" && break; kill -0 "$pid" 2>/dev/null || { sed -E 's/token=[A-Za-z0-9_-]+/token=REDACTED/g' "$S/logs/check.log" | tail -20; die "暂存实例启动失败"; }; sleep 1; done
  sleep 6
  local code; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$CHECK_PORT/")"
  echo "暂存实例 HTTP $code（401 = 未带令牌，正常）"
  ss -ltnp 2>/dev/null | grep -E ":($CHECK_PORT|$CHECK_POCKET_PORT) " | sed -E 's/users:.*pid=([0-9]+).*/pid=\1/'
  echo "--- 日志中的错误/警告（令牌已脱敏）："
  sed -E 's/token=[A-Za-z0-9_-]+/token=REDACTED/g' "$S/logs/check.log" | grep -iE "error|fail|incompatible|already has|patch|self-?test|自检" | cut -c1-240 | head -20 || true
  kill "$pid" 2>/dev/null || true; sleep 2; kill -9 "$pid" 2>/dev/null || true
  rm -f "$S/check.pid"
  [ "$code" = 401 ] || die "暂存实例未按预期响应"
}

start_prod() {
  cd "$PROD"
  DSH_HOME="$PROD" DSH_TAVERN_CLI_HOME="$PROD" DSH_TAVERN_RUNTIME_HOST=cli DSH_TAVERN_LEGACY_DSH_HOME=/home/claw/.dsh \
    setsid nohup node runtime/bin/dsh --profile tavern --host 127.0.0.1 --port 3081 --no-open >> logs/tavern.log 2>&1 < /dev/null &
  disown
  for _ in $(seq 1 90); do ss_listening 3081 && break; sleep 1; done
  sleep 8
}

prod_pid() { ss -ltnp 2>/dev/null | grep '127.0.0.1:3081 ' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1; }

stop_prod() {
  local pid; pid="$(prod_pid || true)"
  [ -n "$pid" ] && { echo "停止生产进程 pid $pid"; kill "$pid"; }
  for _ in $(seq 1 30); do ss_listening 3081 || ss_listening 3082 || break; sleep 1; done
  ss_listening 3081 && die "3081 仍被占用"
  ss_listening 3082 && die "3082 仍被占用（可能是别的进程，请人工确认）"
  return 0
}

cutover() {
  [ "${CONFIRM:-}" = yes ] || die "这会停止并替换生产。确认后以 CONFIRM=yes 重新运行"
  [ -d "$S/runtime" ] && [ -d "$S/apps/dsh-tavern" ] && [ -d "$S/profiles/tavern" ] || die "暂存区不完整，先 stage"
  [ -f "$BACKUP/sha256-runtime-apps-profiles.txt" ] && [ -d "$BACKUP/home" ] || die "找不到部署前备份 $BACKUP"
  [ ! -e "$PROD/runtime-$OLD_SUFFIX" ] || die "已经切换过（$PROD/runtime-$OLD_SUFFIX 存在）"
  verify_tree "$S"
  echo "[1] 停旧服务"; stop_prod
  echo "[2] 旧目录改名保留"
  mv "$PROD/runtime" "$PROD/runtime-$OLD_SUFFIX"
  mv "$PROD/apps/dsh-tavern" "$PROD/apps/dsh-tavern-$OLD_SUFFIX"
  mv "$PROD/profiles/tavern" "$PROD/profiles/tavern-$OLD_SUFFIX"
  echo "[3] 新目录就位"
  mv "$S/runtime" "$PROD/runtime"
  mv "$S/apps/dsh-tavern" "$PROD/apps/dsh-tavern"
  mv "$S/profiles/tavern" "$PROD/profiles/tavern"
  echo "[4] 旧游戏数据归档到 $ARCHIVE（不删除）"
  mkdir -p "$ARCHIVE/data"
  local item
  for item in "${GAME_DATA[@]}"; do
    [ -e "$PROD/profile-data/tavern/data/$item" ] && mv "$PROD/profile-data/tavern/data/$item" "$ARCHIVE/data/$item"
  done
  for item in sessions storages; do
    [ -e "$PROD/profile-data/tavern/$item" ] && mv "$PROD/profile-data/tavern/$item" "$ARCHIVE/$item"
  done
  mkdir -p "$PROD/profile-data/tavern/sessions" "$PROD/profile-data/tavern/storages" "$PROD/profile-data/tavern/data"
  echo "[5] 启动新生产实例"; start_prod
  ss -ltnp 2>/dev/null | grep -E ":(3081|3082) " | sed -E 's/users:.*pid=([0-9]+).*/pid=\1/'
  echo "HTTP 3081: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3081/)  3082: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3082/)"
}

rollback() {
  [ "${CONFIRM:-}" = yes ] || die "这会停止并替换生产。确认后以 CONFIRM=yes 重新运行"
  [ -e "$PROD/runtime-$OLD_SUFFIX" ] || die "没有可回退的旧目录"
  stop_prod
  mv "$PROD/runtime" "$S/runtime.failed"  2>/dev/null || { mkdir -p "$S"; mv "$PROD/runtime" "$S/runtime.failed"; }
  mkdir -p "$S"
  mv "$PROD/apps/dsh-tavern" "$S/apps-dsh-tavern.failed"
  mv "$PROD/profiles/tavern" "$S/profiles-tavern.failed"
  mv "$PROD/runtime-$OLD_SUFFIX" "$PROD/runtime"
  mv "$PROD/apps/dsh-tavern-$OLD_SUFFIX" "$PROD/apps/dsh-tavern"
  mv "$PROD/profiles/tavern-$OLD_SUFFIX" "$PROD/profiles/tavern"
  # 新实例产生的数据放到 failed 旁边保存，旧数据归位。
  if [ -d "$ARCHIVE" ]; then
    mkdir -p "$S/profile-data-new"
    mv "$PROD/profile-data/tavern/sessions" "$S/profile-data-new/sessions" 2>/dev/null || true
    mv "$PROD/profile-data/tavern/storages" "$S/profile-data-new/storages" 2>/dev/null || true
    for item in sessions storages; do [ -e "$ARCHIVE/$item" ] && mv "$ARCHIVE/$item" "$PROD/profile-data/tavern/$item"; done
    for item in "${GAME_DATA[@]}"; do
      [ -e "$PROD/profile-data/tavern/data/$item" ] && mv "$PROD/profile-data/tavern/data/$item" "$S/profile-data-new/$item"
      [ -e "$ARCHIVE/data/$item" ] && mv "$ARCHIVE/data/$item" "$PROD/profile-data/tavern/data/$item"
    done
  fi
  echo "已回到旧目录。若 settings.yaml 被 0.2.1 改名导入，请从 $BACKUP/home/settings.yaml 恢复（见备份 README）。"
  start_prod
  ss -ltnp 2>/dev/null | grep -E ":(3081|3082) " | sed -E 's/users:.*pid=([0-9]+).*/pid=\1/'
}

verify() {
  local root="${1:-$PROD}"
  verify_tree "$root"
}

case "${1:-}" in
  stage) stage ;;
  check) check ;;
  cutover) cutover ;;
  rollback) rollback ;;
  verify) verify "${2:-}" ;;
  *) sed -n 2,10p "${BASH_SOURCE[0]}"; exit 2 ;;
esac
