#!/usr/bin/env bash
# 在 DSH 0.2.1 运行时 + 会话补丁预加载下运行指定测试（tests/*.test.mjs 与 testsets/tests/*.test.mjs 要用这个跑）。
#   bin/test-some.sh tests/round-history.test.mjs [更多测试…] [-- node --test 的额外参数]
# tests/algebra/* 不要用它：algebra 套件必须不带预加载单独跑（见 bin/test-all.sh 第一段）。
# 环境变量：
#   STAGE021_BASE     0.2.1 暂存目录（默认 /home/claw/dsh-stage-021），运行时在 $STAGE021_BASE/runtime
#   STAGE021_RUNTIME  直接指定运行时目录（覆盖上面的推导）
#   DSH_BOOT_MODULE   直接指定宿主启动模块（覆盖一切）
set -euo pipefail
FORK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${STAGE021_BASE:-/home/claw/dsh-stage-021}"
RUNTIME="${STAGE021_RUNTIME:-$BASE/runtime}"
BOOT="${DSH_BOOT_MODULE:-$RUNTIME/lib/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js}"
if [ ! -f "$BOOT" ]; then
  echo "找不到 DSH 0.2.1 运行时的启动模块：$BOOT" >&2
  echo "设置 STAGE021_BASE（其下应有 runtime/）、STAGE021_RUNTIME 或 DSH_BOOT_MODULE。运行时由 bin/stage-021.sh setup 准备。" >&2
  exit 2
fi
[ $# -gt 0 ] || { echo "用法：bin/test-some.sh <测试文件…> [-- node --test 参数]" >&2; exit 2; }
for a in "$@"; do
  case "$a" in tests/algebra/*|*/tests/algebra/*) echo "algebra 套件请直接 node --test tests/algebra/*.test.mjs（不带预加载）" >&2; exit 2 ;; esac
done
cd "$FORK"
export DSH_BOOT_MODULE="$BOOT"
exec node --import ./tests/fixtures/host-session-patch-preload.mjs --test --test-timeout="${TEST_TIMEOUT_MS:-60000}" "$@"
