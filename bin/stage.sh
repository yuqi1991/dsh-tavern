#!/usr/bin/env bash
# Stage 实例：直接从 fork 源码目录运行 dsh-tavern，数据、端口与生产完全隔离。
#
#   bin/stage.sh start [--mock]   构建客户端后启动（--mock：用 e2e 的固定回复模型，不需要模型密钥）
#   bin/stage.sh stop | status | logs
#   bin/stage.sh seed [--full]    从生产复制数据到 stage（默认只复制人物卡/资源/设置；--full 连会话一起复制）
#   bin/stage.sh reset            清空 stage 数据（不动生产）
#
# 隔离保证：stage 有自己的 DSH_HOME、profile、数据根、端口；它只“读”生产的运行时与依赖包，从不写生产。
# 插件三个包直接链接到 fork 目录，改完代码后 `stage.sh start` 重启即可，无需备份/复制。
set -euo pipefail

FORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_HOME="${STAGE_HOME:-/home/claw/dsh-stage}"
PROD_HOME="${PROD_HOME:-/home/claw/workspace/dsh-tarvern}"
STAGE_PORT="${STAGE_PORT:-3091}"
RUNTIME="${STAGE_RUNTIME:-$PROD_HOME/runtime}"
PROFILE="$STAGE_HOME/profiles/tavern"
DATA="$STAGE_HOME/profile-data/tavern/data"
PIDFILE="$STAGE_HOME/stage.pid"
LOG="$STAGE_HOME/logs/stage.log"
# 只按名字转发调用者 shell 里已有的模型密钥变量；脚本不读取、不保存它们的值。
PASS_ENV="${STAGE_PASS_ENV:-CPA_API_KEY DEEPSEEK_API_KEY}"

die() { echo "stage: $*" >&2; exit 1; }

guard() {
  [ "$(realpath -m "$STAGE_HOME")" != "$(realpath -m "$PROD_HOME")" ] || die "STAGE_HOME 不能等于生产目录"
  case "$(realpath -m "$STAGE_HOME")/" in "$(realpath -m "$PROD_HOME")"/*) die "STAGE_HOME 不能放在生产目录里面";; esac
  [ "$STAGE_PORT" != 3081 ] && [ "$STAGE_PORT" != 3082 ] || die "端口 $STAGE_PORT 属于生产实例"
  [ -f "$RUNTIME/bin/dsh" ] || die "找不到 DSH runtime: $RUNTIME/bin/dsh"
}

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }
port_busy() { ss -ltn 2>/dev/null | grep -q "[:.]$1 "; }

setup() {
  guard
  mkdir -p "$PROFILE/node_modules" "$DATA" "$STAGE_HOME/logs" "$STAGE_HOME/profile-data/tavern/sessions"
  local nm="$PROFILE/node_modules" prod_nm="$PROD_HOME/profiles/tavern/node_modules"
  # 依赖包：除下面几个要指向 fork 的，其余全部链接到生产已安装的同名包（只读共享，含已打补丁的侧栏/Pocket）。
  local own="dsh-tavern-plugin dsh-tavern-remote dsh-dream-skin dsh-tavern-enter-swap"
  for entry in "$prod_nm"/* "$prod_nm"/.bin; do
    local name; name="$(basename "$entry")"
    case " $own " in *" $name "*) continue;; esac
    ln -sfn "$(realpath "$entry")" "$nm/$name"
  done
  ln -sfn "$FORK/tavern-plugin" "$nm/dsh-tavern-plugin"
  ln -sfn "$FORK/tavern-plugin/packages/dsh-tavern-remote" "$nm/dsh-tavern-remote"
  ln -sfn "$FORK/tavern-plugin/packages/dsh-dream-skin" "$nm/dsh-dream-skin"
  # enter-swap 小插件：复制一份进 stage 自己的数据目录，不去引用生产数据。
  if [ ! -d "$DATA/tools/enter-swap" ] && [ -d "$PROD_HOME/profile-data/tavern/data/tools/enter-swap" ]; then
    mkdir -p "$DATA/tools"; cp -a "$PROD_HOME/profile-data/tavern/data/tools/enter-swap" "$DATA/tools/enter-swap"
  fi
  [ -d "$DATA/tools/enter-swap" ] && ln -sfn "$DATA/tools/enter-swap" "$nm/dsh-tavern-enter-swap"
  cp "$PROD_HOME/profiles/tavern/cordis.yml" "$PROFILE/cordis.yml"
  node - "$PROD_HOME/profiles/tavern/package.json" "$PROFILE/package.json" "$FORK" "$DATA" "$STAGE_HOME" <<'EOF'
const fs = require('node:fs')
const [src, dst, fork, data, home] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(src, 'utf8'))
for (const key of ['dsh-tavern-plugin', 'dsh-tavern-remote', 'dsh-dream-skin']) delete pkg.dependencies[key]
// Pocket 是对外隧道/代理插件，默认盯着生产端口 3081；stage 不需要它，去掉以免误连生产。
delete pkg.dependencies['dsh-pocket']
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(name => name !== 'dsh-pocket')
pkg.name = 'dsh-profile-tavern-stage'
pkg.dependencies['dsh-tavern-plugin'] = `link:${fork}/tavern-plugin`
pkg.dependencies['dsh-tavern-remote'] = `link:${fork}/tavern-plugin/packages/dsh-tavern-remote`
pkg.dependencies['dsh-dream-skin'] = `link:${fork}/tavern-plugin/packages/dsh-dream-skin`
pkg.dshTavern = { ...pkg.dshTavern, source: fork, dataRoot: data }
fs.writeFileSync(dst, JSON.stringify(pkg, null, 2) + '\n')
EOF
}

write_patch() {
  if [ "$1" = mock ]; then
    printf -- '- id: agent-default-model\n  config:\n    provider: tavern-e2e\n    model: fixed\n- insert:\n    - id: tavern-e2e-model\n      name: %s\n' "\"$FORK/tests/e2e/model.mjs\"" > "$PROFILE/cordis.patch.yml"
  else
    cp "$PROD_HOME/profiles/tavern/cordis.patch.yml" "$PROFILE/cordis.patch.yml"
  fi
}

start() {
  local mode=real; [ "${1:-}" = "--mock" ] && mode=mock
  setup
  running && die "stage 已在运行（pid $(cat "$PIDFILE")），先 stop"
  port_busy "$STAGE_PORT" && die "端口 $STAGE_PORT 已被占用"
  (cd "$FORK" && node bin/build-tavern-client.mjs >/dev/null && node bin/build-tavern-client.mjs --check >/dev/null)
  write_patch "$mode"
  local envs=(DSH_HOME="$STAGE_HOME" DSH_TAVERN_CLI_HOME="$STAGE_HOME" DSH_TAVERN_RUNTIME_HOST=cli PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}")
  [ "$mode" = mock ] && envs+=(TAVERN_E2E_LLM_MODULE="$RUNTIME/lib/node_modules/@deepseek-ai/dsh-llm/lib/index.js" TAVERN_E2E_REQUEST_AUDIT="$STAGE_HOME/logs/model-requests.jsonl")
  for name in $PASS_ENV; do [ -n "${!name:-}" ] && envs+=("$name=${!name}"); done
  : > "$LOG"
  cd "$STAGE_HOME"
  setsid nohup env -i "${envs[@]}" node "$RUNTIME/bin/dsh" --profile tavern --host 127.0.0.1 --port "$STAGE_PORT" --no-open >> "$LOG" 2>&1 < /dev/null &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 90); do
    port_busy "$STAGE_PORT" && break
    running || { tail -20 "$LOG" >&2; die "启动失败，见 $LOG"; }
    sleep 1
  done
  port_busy "$STAGE_PORT" || die "等待端口超时，见 $LOG"
  sleep 3
  echo "stage 已启动（$mode 模型）：$(grep -o "http://127.0.0.1:$STAGE_PORT[^ ]*" "$LOG" | head -1)"
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

seed() {
  guard
  running && die "先 stop 再 seed"
  local src="$PROD_HOME/profile-data/tavern"
  mkdir -p "$DATA"
  if [ "${1:-}" = "--full" ]; then
    echo "完整复制生产数据（含会话），只读取生产，按生产当前快照复制……"
    for part in data sessions storages; do
      mkdir -p "$STAGE_HOME/profile-data/tavern/$part"
      cp -a --reflink=auto "$src/$part/." "$STAGE_HOME/profile-data/tavern/$part/"
    done
  else
    for part in cards resources scripts tools; do
      [ -d "$src/data/$part" ] && { mkdir -p "$DATA/$part"; cp -a --reflink=auto "$src/data/$part/." "$DATA/$part/"; }
    done
    for file in "$src"/data/*settings*.json; do [ -f "$file" ] && cp -a "$file" "$DATA/"; done
  fi
  echo "已复制到 $STAGE_HOME/profile-data/tavern"
}

reset() {
  guard
  running && stop
  rm -rf "$STAGE_HOME/profile-data"
  echo "stage 数据已清空（生产未动）"
}

case "${1:-}" in
  start) shift; start "$@" ;;
  stop) stop ;;
  status) status ;;
  logs) tail -n "${2:-80}" -f "$LOG" ;;
  seed) shift; seed "$@" ;;
  reset) reset ;;
  setup) setup; echo "stage 目录已就绪：$STAGE_HOME" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
