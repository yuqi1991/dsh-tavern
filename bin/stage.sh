#!/usr/bin/env bash
# Stage 实例：克隆生产 DSH_HOME 的“配置与资源”（不含聊天记录），再让其中的 dsh-tavern 插件直接链接到 fork 源码运行。
#
#   bin/stage.sh clone [--force]   克隆配置与资源到 stage；--force 会把已有 stage 改名留底后重做
#   bin/stage.sh start [--mock]    重建客户端并启动；--mock 换成 e2e 的固定回复模型（不调用真实模型）
#   bin/stage.sh stop | status | logs
#
# 克隆内容：profile（含 settings.yaml）、运行时与依赖包、人物卡/资源/预设/世界书/技能/工具、各项设置。
# 不克隆：聊天与会话、模型请求日志、诊断、召回记录、草稿与索引、备份、日志、dsh-pocket（对外隧道，默认盯生产端口）。
# 隔离保证：stage 有自己的家目录、数据、运行时副本和端口(3091)；克隆只读生产，之后从不写生产。
# 克隆里指回生产路径的符号链接和配置会改写成 stage 路径。改完 fork 代码后 `stop` 再 `start` 即可，无需备份/复制。
set -euo pipefail

FORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_HOME="${STAGE_HOME:-/home/claw/dsh-stage}"
PROD_HOME="${PROD_HOME:-/home/claw/workspace/dsh-tarvern}"
STAGE_PORT="${STAGE_PORT:-3091}"
STAGE_HOST="${STAGE_HOST:-127.0.0.1}"   # DSH 内核不允许 0.0.0.0；需要对外访问时用 dsh-pocket
STAGE_POCKET="${STAGE_POCKET:-1}"       # 1=加载 dsh-pocket（默认）；0=不加载
RUNTIME="${STAGE_RUNTIME:-$STAGE_HOME/runtime}"
PROFILE="$STAGE_HOME/profiles/tavern"
DATA="$STAGE_HOME/profile-data/tavern/data"
PIDFILE="$STAGE_HOME/stage.pid"
LOG="$STAGE_HOME/logs/stage.log"
# 只按名字转发调用者 shell 里已有的模型密钥变量；脚本不读取、不保存它们的值。
PASS_ENV="${STAGE_PASS_ENV:-CPA_API_KEY DEEPSEEK_API_KEY}"

# 聊天与运行产生的内容，不进 stage。
EXCLUDES=(
  /logs/'*' /dsh-pocket /attachments
  /profile-data/tavern/sessions /profile-data/tavern/storages '/profile-data/tavern/backups*'
  /profile-data/tavern/data/chats /profile-data/tavern/data/model-requests /profile-data/tavern/data/model-request-sessions
  /profile-data/tavern/data/diagnostics /profile-data/tavern/data/worldbook-recalls /profile-data/tavern/data/cache
  /profile-data/tavern/data/mvu-drafts /profile-data/tavern/data/mvu-draft-sessions /profile-data/tavern/data/template-work
  /profile-data/tavern/data/scene-images /profile-data/tavern/data/legacy-id-storage /profile-data/tavern/data/diffs
  /profile-data/tavern/data/card-memory
  /profile-data/tavern/data/index.json /profile-data/tavern/data/sessions.json /profile-data/tavern/data/card-projection-revisions.json
  /profile-data/tavern/data/background-session-retirement.json /profile-data/tavern/data/prompt-template-variables.json
  '/profile-data/tavern/data/update-*'
)

die() { echo "stage: $*" >&2; exit 1; }

guard() {
  local stage prod; stage="$(realpath -m "$STAGE_HOME")"; prod="$(realpath -m "$PROD_HOME")"
  [ "$stage" != "$prod" ] || die "STAGE_HOME 不能等于生产目录"
  case "$stage/" in "$prod"/*) die "STAGE_HOME 不能放在生产目录里面";; esac
  case "$prod/" in "$stage"/*) die "生产目录不能在 STAGE_HOME 里面";; esac
  [ "$STAGE_PORT" != 3081 ] && [ "$STAGE_PORT" != 3082 ] || die "端口 $STAGE_PORT 属于生产实例"
}

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
port_busy() { ss -ltn 2>/dev/null | grep -q "[:.]$1 "; }

clone() {
  guard
  [ -d "$PROD_HOME/profiles/tavern" ] || die "生产家目录不对：$PROD_HOME"
  running && die "stage 正在运行，先 stop"
  if [ -e "$STAGE_HOME" ]; then
    [ "${1:-}" = "--force" ] || die "$STAGE_HOME 已存在；确要重做请加 --force（旧的会改名留底）"
    mv "$STAGE_HOME" "$STAGE_HOME.old-$(date +%Y%m%d-%H%M%S)"
  fi
  echo "克隆配置与资源 $PROD_HOME → $STAGE_HOME （只读生产，不含聊天记录）……"
  mkdir -p "$STAGE_HOME"
  local args=(); for pattern in "${EXCLUDES[@]}"; do args+=(--exclude="$pattern"); done
  rsync -a "${args[@]}" "$PROD_HOME/" "$STAGE_HOME/"
  mkdir -p "$STAGE_HOME/logs" "$DATA" "$STAGE_HOME/profile-data/tavern/sessions" "$STAGE_HOME/profile-data/tavern/storages"
  python3 - "$PROD_HOME" "$STAGE_HOME" <<'EOF'
import os, sys
prod, stage = sys.argv[1].rstrip('/'), sys.argv[2].rstrip('/')
relinked = 0
for root, dirs, files in os.walk(stage, followlinks=False):
    for name in dirs + files:
        path = os.path.join(root, name)
        if os.path.islink(path):
            target = os.readlink(path)
            if target == prod or target.startswith(prod + '/'):
                os.unlink(path); os.symlink(stage + target[len(prod):], path); relinked += 1
texts = ['profiles/tavern/package.json', 'profiles/tavern/pnpm-lock.yaml', '.dsh-tavern-install-root', 'apps/dsh-tavern/.dsh-tavern-local.json']
changed = 0
for rel in texts:
    path = os.path.join(stage, rel)
    if os.path.isfile(path):
        text = open(path, encoding='utf-8').read()
        if prod in text:
            open(path, 'w', encoding='utf-8').write(text.replace(prod, stage)); changed += 1
print(f'改写符号链接 {relinked} 个、配置文件 {changed} 个')
EOF
  cp "$PROFILE/cordis.patch.yml" "$PROFILE/cordis.patch.yml.real"
  echo "克隆完成，大小：$(du -sh "$STAGE_HOME" | cut -f1)。仍引用生产路径的文本文件（应只剩文档类）："
  grep -rIl --exclude-dir=node_modules --exclude-dir=docs --exclude='*.md' --exclude='*.backup.*' "$PROD_HOME" "$STAGE_HOME" 2>/dev/null | head -10 || true
}

# 每次启动前重新确认：插件三个包指向 fork、不加载 pocket、数据根在 stage 内。
prepare() {
  guard
  [ -d "$PROFILE" ] || die "stage 还没克隆，先运行 clone"
  [ -f "$RUNTIME/bin/dsh" ] || die "找不到 stage 的 DSH runtime：$RUNTIME/bin/dsh"
  local nm="$PROFILE/node_modules"
  ln -sfn "$FORK/tavern-plugin" "$nm/dsh-tavern-plugin"
  ln -sfn "$FORK/tavern-plugin/packages/dsh-tavern-remote" "$nm/dsh-tavern-remote"
  ln -sfn "$FORK/tavern-plugin/packages/dsh-dream-skin" "$nm/dsh-dream-skin"
  STAGE_POCKET="$STAGE_POCKET" node - "$PROFILE/package.json" "$FORK" "$DATA" <<'EOF'
const fs = require('node:fs')
const [file, fork, data] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies['dsh-tavern-plugin'] = `link:${fork}/tavern-plugin`
pkg.dependencies['dsh-tavern-remote'] = `link:${fork}/tavern-plugin/packages/dsh-tavern-remote`
pkg.dependencies['dsh-dream-skin'] = `link:${fork}/tavern-plugin/packages/dsh-dream-skin`
const bundles = pkg.dsh.profile.bundles.filter(name => name !== 'dsh-pocket')
if (process.env.STAGE_POCKET === '0') delete pkg.dependencies['dsh-pocket']
else {
  pkg.dependencies['dsh-pocket'] = pkg.dependencies['dsh-pocket'] || '2.10.6'
  bundles.splice(bundles.indexOf('dsh-tavern-plugin'), 0, 'dsh-pocket')
}
pkg.dsh.profile.bundles = bundles
pkg.dshTavern = { ...pkg.dshTavern, source: fork, dataRoot: data }
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
EOF
  if [ "$1" = mock ]; then
    printf -- '- id: agent-default-model\n  config:\n    provider: tavern-e2e\n    model: fixed\n- insert:\n    - id: tavern-e2e-model\n      name: %s\n' "\"$FORK/tests/e2e/model.mjs\"" > "$PROFILE/cordis.patch.yml"
  else
    cp "$PROFILE/cordis.patch.yml.real" "$PROFILE/cordis.patch.yml"
  fi
}

start() {
  local mode=real; [ "${1:-}" = "--mock" ] && mode=mock
  running && die "stage 已在运行（pid $(cat "$PIDFILE")），先 stop"
  prepare "$mode"
  port_busy "$STAGE_PORT" && die "端口 $STAGE_PORT 已被占用"
  (cd "$FORK" && node bin/build-tavern-client.mjs >/dev/null && node bin/build-tavern-client.mjs --check >/dev/null)
  local envs=(DSH_HOME="$STAGE_HOME" DSH_TAVERN_CLI_HOME="$STAGE_HOME" DSH_TAVERN_RUNTIME_HOST=cli PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}")
  [ "$mode" = mock ] && envs+=(TAVERN_E2E_LLM_MODULE="$RUNTIME/lib/node_modules/@deepseek-ai/dsh-llm/lib/index.js" TAVERN_E2E_REQUEST_AUDIT="$STAGE_HOME/logs/model-requests.jsonl")
  for name in $PASS_ENV; do [ -n "${!name:-}" ] && envs+=("$name=${!name}"); done
  mkdir -p "$STAGE_HOME/logs"; : > "$LOG"
  cd "$STAGE_HOME"
  setsid nohup env -i "${envs[@]}" node "$RUNTIME/bin/dsh" --profile tavern --host "$STAGE_HOST" --port "$STAGE_PORT" --no-open >> "$LOG" 2>&1 < /dev/null &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 90); do
    port_busy "$STAGE_PORT" && break
    running || { tail -20 "$LOG" >&2; die "启动失败，见 $LOG"; }
    sleep 1
  done
  port_busy "$STAGE_PORT" || die "等待端口超时，见 $LOG"
  sleep 3
  echo "stage 已启动（$mode 模型）：$(grep -o "http://[^ ]*:$STAGE_PORT/[^ ]*" "$LOG" | head -1)"
  echo "数据目录：$DATA    日志：$LOG"
}

stop() {
  if running; then kill "$(cat "$PIDFILE")"; for _ in $(seq 1 30); do running || break; sleep 1; done; running && kill -9 "$(cat "$PIDFILE")" || true; fi
  rm -f "$PIDFILE"; echo "stage 已停止"
}

status() {
  if running; then echo "运行中 pid $(cat "$PIDFILE") 端口 $STAGE_PORT"; port_busy "$STAGE_PORT" && echo "端口已监听"; else echo "未运行"; fi
  echo "代码：$FORK @ $(git -C "$FORK" rev-parse --short HEAD)$(git -C "$FORK" diff --quiet HEAD -- tavern-plugin || echo ' (有未提交改动)')"
}

case "${1:-}" in
  clone) shift; clone "$@" ;;
  start) shift; start "$@" ;;
  stop) stop ;;
  status) status ;;
  logs) tail -n "${2:-80}" -f "$LOG" ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
