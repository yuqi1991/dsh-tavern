#!/usr/bin/env bash
# 完整测试套件，分两段，任一段失败则整体失败（不需要基线名单）：
#   1) tests/algebra/*.test.mjs   不带预加载、不设 DSH_BOOT_MODULE，单独跑
#   2) tests/*.test.mjs + testsets/tests/*.test.mjs   DSH 0.2.1 运行时 + 会话补丁预加载（同 bin/test-some.sh）
# 用法：bin/test-all.sh            # 完整
#       TAP_DIR=/tmp/x bin/test-all.sh   # TAP 原文保存位置（默认 mktemp -d）
# 环境变量：STAGE021_BASE / STAGE021_RUNTIME / DSH_BOOT_MODULE（同 test-some.sh）、TOTAL_TIMEOUT（秒，默认 1200）、TEST_TIMEOUT_MS（单测，默认 60000）。
# 已知问题与偶发项见 tests/KNOWN-FAILURES.md；被删除的过期测试见 tests/OBSOLETE.md。
set -uo pipefail
FORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${STAGE021_BASE:-/home/claw/dsh-stage-021}"
RUNTIME="${STAGE021_RUNTIME:-$BASE/runtime}"
BOOT="${DSH_BOOT_MODULE:-$RUNTIME/lib/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js}"
if [ ! -f "$BOOT" ]; then
  echo "找不到 DSH 0.2.1 运行时的启动模块：$BOOT" >&2
  echo "设置 STAGE021_BASE（其下应有 runtime/）、STAGE021_RUNTIME 或 DSH_BOOT_MODULE。运行时由 bin/stage-021.sh setup 准备。" >&2
  exit 2
fi
TAP_DIR="${TAP_DIR:-$(mktemp -d /tmp/test-all.XXXXXX)}"
mkdir -p "$TAP_DIR"
cd "$FORK"
RC=0
summary() { grep -E '^# (tests|suites|pass|fail|cancelled|skipped|todo)' "$1" | tr '\n' ' '; echo; }

echo "== 第 1 段：algebra（无预加载）=="
env -u DSH_BOOT_MODULE timeout "${TOTAL_TIMEOUT:-1200}" node --test --test-timeout="${TEST_TIMEOUT_MS:-60000}" tests/algebra/*.test.mjs > "$TAP_DIR/algebra.tap" 2>&1
A=$?
summary "$TAP_DIR/algebra.tap"
[ $A -eq 0 ] || { RC=1; grep '^not ok' "$TAP_DIR/algebra.tap" | head -20; }

echo "== 第 2 段：主套件（DSH 0.2.1 运行时 + 预加载）=="
DSH_BOOT_MODULE="$BOOT" timeout "${TOTAL_TIMEOUT:-1200}" node --import ./tests/fixtures/host-session-patch-preload.mjs --test --test-timeout="${TEST_TIMEOUT_MS:-60000}" tests/*.test.mjs testsets/tests/*.test.mjs > "$TAP_DIR/main.tap" 2>&1
B=$?
summary "$TAP_DIR/main.tap"
[ $B -eq 0 ] || { RC=1; grep -E '^not ok' "$TAP_DIR/main.tap" | head -30; }
SKIPPED=$(grep -cE '^\s*(ok|not ok) [0-9]+ - .*# SKIP' "$TAP_DIR/main.tap" || true)
echo "跳过（带原因的 skip）：$SKIPPED 个；TAP 原文：$TAP_DIR"

if [ $RC -eq 0 ]; then echo "test-all: 通过"; else echo "test-all: 失败（algebra=$A main=$B）" >&2; fi
exit $RC
