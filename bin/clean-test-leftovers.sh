#!/usr/bin/env bash
# 开发测试收尾：清掉 e2e / 测试跑完遗留的进程与临时文件。只动测试产物，不碰生产（3081/3082）与验收实例（3092/3093）。
# 用法： bin/clean-test-leftovers.sh        （每次跑完 bin/test-all.sh 或 tests/e2e 之后执行）
set -uo pipefail
n=0
for p in $(pgrep -f 'bin.js --profile tavern.*--port 0' 2>/dev/null); do
  home="$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -E '^DSH_HOME=' | cut -d= -f2)"
  case "$home" in /tmp/tavern-e2e-*) kill "$p" 2>/dev/null && n=$((n+1));; esac
done
sleep 3
for p in $(pgrep -f 'bin.js --profile tavern.*--port 0' 2>/dev/null); do
  home="$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -E '^DSH_HOME=' | cut -d= -f2)"
  case "$home" in /tmp/tavern-e2e-*) kill -9 "$p" 2>/dev/null;; esac
done
echo "已结束遗留的 e2e DSH 进程：$n 个"
rm -rf /tmp/tavern-e2e-* /tmp/dsh-mobile-card-* /tmp/test-all.* /tmp/cjs-dsh-tavern-fork-021.tap /tmp/.org.chromium.Chromium.* /tmp/pw-browsers /tmp/e2e-* 2>/dev/null
echo "已清理 /tmp 下的测试临时文件"
left="$(ps -eo pid,rss,args | grep -E 'tavern-e2e|--port 0' | grep -v grep | wc -l)"
echo "剩余可疑测试进程：$left 个"
