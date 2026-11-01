#!/usr/bin/env bash
# DSH 0.2.1 验收实例：用独立的 0.2.1 运行时和全新的家目录跑 fork 里的代码，不碰生产（3081/3082）。
#
#   bin/stage-021.sh setup    建家目录（profile、插件链接、人物卡/资源等配置的只读拷贝；没有聊天记录、没有模型密钥）
#   bin/stage-021.sh start    重建客户端并启动（后台，端口 3092）
#   bin/stage-021.sh enable-pocket   给已存在的家目录加上 Pocket（只改 profile，不动数据；下次 start 生效）
#   bin/stage-021.sh stop | status | logs
#
# 手机入口 Pocket（可选，STAGE021_POCKET=1，默认 0）：dsh-pocket 2.12.0 + patches/dsh-pocket@2.12.0.patch，
# 监听 0.0.0.0:$POCKET_PORT（默认 3093），只代理本实例的 $PORT（上游由宿主 ctx.webServer.port 给定，没有自动发现）。
# 端口写在 $HOME_DIR/dsh-pocket/settings.json 的 proxyPort（插件模式唯一可靠的指定方式），脚本不读取、不打印该文件的其他内容。
#
# 模型密钥：本脚本不读取、不拷贝任何密钥。要用真实模型，请自己把配置放进 $HOME_DIR/settings.yaml
# （例如在对话里用 `! cp <生产家目录>/settings.yaml $HOME_DIR/settings.yaml`），或用 PASS_ENV 里列出的环境变量名传递。
set -euo pipefail

FORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${STAGE021_BASE:-/home/claw/dsh-stage-021}"
HOME_DIR="${STAGE021_HOME:-$BASE/home}"
RUNTIME="${STAGE021_RUNTIME:-$BASE/runtime}"
ROOT_NM="${STAGE021_ROOT_NM:-$BASE/root-nm}"
PROD_HOME="${PROD_HOME:-/home/claw/workspace/dsh-tarvern}"
PORT="${STAGE021_PORT:-3092}"
POCKET="${STAGE021_POCKET:-0}"
POCKET_PORT="${STAGE021_POCKET_PORT:-3093}"
PASS_ENV="${STAGE021_PASS_ENV:-CPA_API_KEY DEEPSEEK_API_KEY}"
PROFILE="$HOME_DIR/profiles/tavern"
DATA="$HOME_DIR/profile-data/tavern/data"
PIDFILE="$HOME_DIR/stage.pid"
LOG="$HOME_DIR/logs/stage.log"

die() { echo "stage-021: $*" >&2; exit 1; }
guard() {
  local home prod; home="$(realpath -m "$HOME_DIR")"; prod="$(realpath -m "$PROD_HOME")"
  [ "$home" != "$prod" ] || die "家目录不能等于生产目录"
  case "$home/" in "$prod"/*) die "家目录不能放在生产目录里面";; esac
  [ "$PORT" != 3081 ] && [ "$PORT" != 3082 ] || die "端口 $PORT 属于生产实例"
  if [ "$POCKET" = 1 ]; then
    case "$POCKET_PORT" in ''|*[!0-9]*) die "STAGE021_POCKET_PORT 必须是数字";; esac
    case "$POCKET_PORT" in 3080|3081|3082|3091|3092) die "Pocket 端口 $POCKET_PORT 属于生产或其他实例";; esac
    [ "$POCKET_PORT" != "$PORT" ] || die "Pocket 端口不能等于实例端口"
  fi
}
# 把 dsh-pocket 拷进 profile（拷贝而不是链接：它要在自己目录里解析 qrcode），确认补丁已应用，并强制代理端口。
install_pocket() {
  [ -d "$ROOT_NM/dsh-pocket" ] || die "找不到 $ROOT_NM/dsh-pocket"
  local dest="$PROFILE/node_modules/dsh-pocket" marker='PocketSettingsWithServiceControl'
  rm -rf "$dest"; cp -a "$ROOT_NM/dsh-pocket" "$dest"
  if ! grep -q "$marker" "$dest/client/client.js"; then
    patch -p1 -d "$dest" < "$FORK/patches/dsh-pocket@2.12.0.patch" >/dev/null || die "dsh-pocket 补丁应用失败"
  fi
  grep -q "$marker" "$dest/client/client.js" || die "dsh-pocket 补丁未生效"
  # Pocket 2.12.0 内置了一份 dsh-web-mobile 的移植（mobileApply），与 profile 里的 dsh-web-mobile 3.x 注册同样的
  # mobile-nav-* 槽位 id，0.2.1 的列表槽位拒绝重复 id 而抛错（页面卡在 Loading plugins、右侧栏入口缺失）。去掉 Pocket 那份。
  if grep -q '^  mobileApply(ctx);' "$dest/client/client.js"; then
    patch -p1 -d "$dest" < "$FORK/patches/dsh-pocket@2.12.0-no-mobile.patch" >/dev/null || die "dsh-pocket 去重补丁应用失败"
  fi
  grep -q '^  mobileApply(ctx);' "$dest/client/client.js" && die "dsh-pocket 去重补丁未生效"
  [ -e "$PROFILE/node_modules/qrcode" ] || die "profile 里缺 qrcode（Pocket 二维码依赖）"
  # 强制代理端口；已有的 settings.json（可能含自定义 PIN）只合并 proxyPort，不覆盖其他字段。
  mkdir -p "$HOME_DIR/dsh-pocket"
  POCKET_SETTINGS="$HOME_DIR/dsh-pocket/settings.json" POCKET_PORT="$POCKET_PORT" node -e '
    const fs = require("fs"); const f = process.env.POCKET_SETTINGS; let s = {};
    try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    s.proxyPort = Number(process.env.POCKET_PORT);
    fs.writeFileSync(f, JSON.stringify(s, null, 2), { mode: 0o600 });'
  chmod 600 "$HOME_DIR/dsh-pocket/settings.json"
}
# 只改 package.json 的 bundles，加入 dsh-pocket（幂等）。
add_pocket_bundle() {
  PKG="$PROFILE/package.json" node -e '
    const fs = require("fs"); const p = JSON.parse(fs.readFileSync(process.env.PKG, "utf8"));
    const b = p.dsh.profile.bundles; if (!b.includes("dsh-pocket")) b.push("dsh-pocket");
    fs.writeFileSync(process.env.PKG, JSON.stringify(p) + "\n");'
}
enable_pocket() {
  POCKET=1; guard
  [ -d "$PROFILE" ] || die "还没 setup"
  install_pocket; add_pocket_bundle
  echo "已给 $HOME_DIR 加上 Pocket（端口 $POCKET_PORT，只代理 $PORT）。数据未动。"
  if running; then echo "实例正在运行：重启后才加载 Pocket（先 stop 再 start）。"; fi
}
running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

setup() {
  guard
  [ -f "$RUNTIME/bin/dsh" ] || die "找不到 0.2.1 运行时：$RUNTIME"
  [ -d "$ROOT_NM/dsh-better-sidebar" ] || die "找不到依赖目录：$ROOT_NM"
  running && die "已在运行，先 stop"
  [ ! -e "$HOME_DIR" ] || die "$HOME_DIR 已存在；要重做请先把它改名或删除（里面有这个实例自己的聊天）"
  mkdir -p "$PROFILE/node_modules" "$DATA" "$HOME_DIR/logs" "$HOME_DIR/profile-data/tavern/sessions" "$HOME_DIR/profile-data/tavern/storages"
  local modules="$RUNTIME/lib/node_modules"
  ln -s "$FORK/tavern-plugin" "$PROFILE/node_modules/dsh-tavern-plugin"
  ln -s "$FORK/tavern-plugin/packages/dsh-tavern-remote" "$PROFILE/node_modules/dsh-tavern-remote"
  ln -s "$modules/@deepseek-ai" "$PROFILE/node_modules/@deepseek-ai"
  # 侧栏要在自己的目录里按 0.2.1 的包解析，所以拷贝而不是链接。
  cp -a "$ROOT_NM/dsh-better-sidebar" "$PROFILE/node_modules/dsh-better-sidebar"
  local bundles='"@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-better-sidebar", "dsh-tavern-plugin", "dsh-tavern-remote"'
  # dream-skin 用 fork 里改过的那份（放开 peer 范围、适配 0.2.1 去掉的 webRuntime），不用 npm 原版。
  ln -s "$FORK/tavern-plugin/packages/dsh-dream-skin" "$PROFILE/node_modules/dsh-dream-skin"; bundles="$bundles, \"dsh-dream-skin\""
  if [ -e "$ROOT_NM/dsh-web-mobile" ]; then ln -s "$ROOT_NM/dsh-web-mobile" "$PROFILE/node_modules/dsh-web-mobile"; bundles="$bundles, \"dsh-web-mobile\""; fi
  for entry in "$ROOT_NM"/*; do
    name="$(basename "$entry")"
    case "$name" in .*|@deepseek-ai|dsh-tavern-plugin|dsh-tavern-remote|dsh-better-sidebar|dsh-web-mobile|dsh-dream-skin|dsh-pocket) continue;; esac
    [ -e "$PROFILE/node_modules/$name" ] || ln -s "$entry" "$PROFILE/node_modules/$name"
  done
  printf '{ "name": "tavern-stage-021", "private": true, "dsh": { "profile": { "bundles": [%s] } } }\n' "$bundles" > "$PROFILE/package.json"
  # 人物卡、预设、世界书等资源的只读拷贝；不含聊天、会话、诊断、请求日志、场景图、记忆，
  # 也不含可能带密钥的设置文件（tavern-settings.json、tools.cordis.yml、扩展设置），这些由使用者自己决定要不要放进来。
  if [ -d "$PROD_HOME/profile-data/tavern/data" ]; then
    rsync -a \
      --exclude=/chats --exclude=/model-requests --exclude=/model-request-sessions --exclude=/diagnostics \
      --exclude=/worldbook-recalls --exclude=/cache --exclude=/mvu-drafts --exclude=/mvu-draft-sessions \
      --exclude=/template-work --exclude=/scene-images --exclude=/legacy-id-storage --exclude=/diffs \
      --exclude=/card-memory --exclude=/index.json --exclude=/sessions.json --exclude=/card-projection-revisions.json \
      --exclude=/background-session-retirement.json --exclude=/prompt-template-variables.json --exclude='/update-*' \
      --exclude=/tavern-settings.json --exclude=/tools.cordis.yml --exclude=/tavern-extension-settings.json \
      "$PROD_HOME/profile-data/tavern/data/" "$DATA/"
  fi
  if [ "$POCKET" = 1 ]; then install_pocket; add_pocket_bundle; echo "已加入 Pocket：端口 $POCKET_PORT，只代理 $PORT"; fi
  echo "已建好 $HOME_DIR"
  echo "模型：脚本没有拷贝密钥。需要真实模型时，请自己把 settings.yaml 放到 $HOME_DIR/settings.yaml。"
}

start() {
  # profile 里已经启用了 Pocket 就一律按启用处理，端口/目标检查不能因为忘了设环境变量而被跳过。
  grep -q '"dsh-pocket"' "$PROFILE/package.json" 2>/dev/null && POCKET=1
  guard
  [ -d "$PROFILE" ] || die "还没 setup"
  running && die "已在运行（pid $(cat "$PIDFILE")）"
  ss -ltn 2>/dev/null | grep -q "[:.]$PORT " && die "端口 $PORT 已被占用"
  if [ "$POCKET" = 1 ]; then
    grep -q '"dsh-pocket"' "$PROFILE/package.json" || die "STAGE021_POCKET=1 但 profile 未启用 Pocket，先运行 enable-pocket"
    ss -ltn 2>/dev/null | grep -q "[:.]$POCKET_PORT " && die "Pocket 端口 $POCKET_PORT 已被占用（Pocket 会自动顺延到下一个端口，所以这里直接拒绝）"
    # 端口必须已写入 settings.json，否则 Pocket 默认 3081 并向后顺延，会靠近生产端口。
    grep -q "\"proxyPort\": *$POCKET_PORT" "$HOME_DIR/dsh-pocket/settings.json" 2>/dev/null || die "Pocket 的 proxyPort 不是 $POCKET_PORT，先运行 enable-pocket"
  fi
  [ "${STAGE021_SKIP_BUILD:-0}" = 1 ] || (cd "$FORK" && node bin/build-tavern-client.mjs >/dev/null)
  local env=(PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C.UTF-8}" DSH_HOME="$HOME_DIR" DSH_CWD="$HOME_DIR")
  for name in $PASS_ENV; do [ -n "${!name:-}" ] && env+=("$name=${!name}"); done
  cd "$FORK"
  env -i "${env[@]}" setsid nohup node "$RUNTIME/bin/dsh" --profile tavern --host 127.0.0.1 --port "$PORT" --no-open \
    < /dev/null >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 60); do
    grep -q "127.0.0.1:$PORT" "$LOG" 2>/dev/null && break
    running || die "启动失败，看 $LOG"
    sleep 1
  done
  echo "已启动：pid $(cat "$PIDFILE")，端口 $PORT，日志 $LOG"
  [ "$POCKET" = 1 ] && echo "Pocket：手机访问 http://<本机局域网IP>:$POCKET_PORT ，需要 8 位 PIN（见 docs/stage-021.md）"
  echo "进入链接带一次性令牌，脚本不打印它。取链接请运行："
  echo "  grep -o \"http://127.0.0.1:$PORT/?token=[A-Za-z0-9_-]*\" $LOG | tail -1"
}

stop() {
  running || { echo "未运行"; rm -f "$PIDFILE"; return; }
  kill "$(cat "$PIDFILE")"; sleep 2
  running && kill -9 "$(cat "$PIDFILE")" || true
  rm -f "$PIDFILE"; echo "已停止"
}

case "${1:-}" in
  setup) setup ;;
  enable-pocket) enable_pocket ;;
  start) start ;;
  stop) stop ;;
  status) running && echo "运行中 pid $(cat "$PIDFILE")，端口 $PORT" || echo "未运行" ;;
  logs) tail -n "${2:-80}" "$LOG" | sed -E 's/token=[A-Za-z0-9_-]+/token=REDACTED/g' ;;
  *) sed -n 2,14p "${BASH_SOURCE[0]}"; exit 2 ;;
esac
