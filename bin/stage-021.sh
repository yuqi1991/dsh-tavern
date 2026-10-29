#!/usr/bin/env bash
# DSH 0.2.1 验收实例：用独立的 0.2.1 运行时和全新的家目录跑 fork 里的代码，不碰生产（3081/3082）。
#
#   bin/stage-021.sh setup    建家目录（profile、插件链接、人物卡/资源等配置的只读拷贝；没有聊天记录、没有模型密钥）
#   bin/stage-021.sh start    重建客户端并启动（后台，端口 3092）
#   bin/stage-021.sh stop | status | logs
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
  for name in dsh-web-mobile dsh-dream-skin; do
    if [ -e "$ROOT_NM/$name" ]; then ln -s "$ROOT_NM/$name" "$PROFILE/node_modules/$name"; bundles="$bundles, \"$name\""; fi
  done
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
  echo "已建好 $HOME_DIR"
  echo "模型：脚本没有拷贝密钥。需要真实模型时，请自己把 settings.yaml 放到 $HOME_DIR/settings.yaml。"
}

start() {
  guard
  [ -d "$PROFILE" ] || die "还没 setup"
  running && die "已在运行（pid $(cat "$PIDFILE")）"
  ss -ltn 2>/dev/null | grep -q "[:.]$PORT " && die "端口 $PORT 已被占用"
  (cd "$FORK" && node bin/build-tavern-client.mjs >/dev/null)
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
  start) start ;;
  stop) stop ;;
  status) running && echo "运行中 pid $(cat "$PIDFILE")，端口 $PORT" || echo "未运行" ;;
  logs) tail -n "${2:-80}" "$LOG" | sed -E 's/token=[A-Za-z0-9_-]+/token=REDACTED/g' ;;
  *) sed -n 2,11p "${BASH_SOURCE[0]}"; exit 2 ;;
esac
