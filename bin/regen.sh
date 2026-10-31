#!/usr/bin/env bash
# 重建所有“生成文件”并逐个校验；任一不一致则失败。合并上游后、测试之前运行。
#   bin/regen.sh            # 重建 + 校验
#   bin/regen.sh --check    # 只校验，不写文件（CI/提交前用）
# 不在这里重建的（需要人工）：
#   - pnpm-lock.yaml（根、tavern-plugin、packages/*）：不能在 fork 里跑 pnpm add/install；见 docs/upstream-port/SYNC-PLAYBOOK.md
#   - tavern-plugin/packages/dsh-image-gen/lib、dsh-tavern-remote/lib：各包自己的 tsdown/tsc 产物，要在包目录里用 pnpm 构建
#   - dsh-tavern-runtime.json：上游 CI 发布的清单，fork 保持我们这边
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
CHECK_ONLY=0; [ "${1:-}" = "--check" ] && CHECK_ONLY=1
FAIL=0
step() { printf '\n== %s ==\n' "$*"; }
run() { "$@" || { echo "失败：$*" >&2; FAIL=1; }; }

step "客户端 tavern-plugin/lib/client.js"
[ $CHECK_ONLY = 0 ] && run node bin/build-tavern-client.mjs
run node bin/build-tavern-client.mjs --check

step "插件包清单 plugin.patch.yml"
[ $CHECK_ONLY = 0 ] && run node bin/build-plugin-package.mjs
run node bin/build-plugin-package.mjs --check

step "MVU schema 产物"
[ $CHECK_ONLY = 0 ] && run node bin/build-mvu-schema.mjs
run node bin/build-mvu-schema.mjs --check

step "手册站点 docs/index.html（无 --check：重建后再建一次，要求逐字节不变；--check 模式下与当前文件比较）"
if [ $CHECK_ONLY = 1 ]; then
  before=$(sha256sum docs/index.html | cut -d' ' -f1)
  run node docs/manual/build.mjs
  after=$(sha256sum docs/index.html | cut -d' ' -f1)
  if [ "$before" != "$after" ]; then echo "docs/index.html 已过期（已被重建覆盖，请检查 git diff 后提交）" >&2; FAIL=1; fi
else
  run node docs/manual/build.mjs
  first=$(sha256sum docs/index.html | cut -d' ' -f1)
  run node docs/manual/build.mjs
  second=$(sha256sum docs/index.html | cut -d' ' -f1)
  [ "$first" = "$second" ] || { echo "docs/index.html 两次构建不一致（构建不确定）" >&2; FAIL=1; }
fi

step "未在此重建、需人工确认的生成文件"
git status --short -- pnpm-lock.yaml tavern-plugin/pnpm-lock.yaml 'tavern-plugin/packages/*/pnpm-lock.yaml' tavern-plugin/packages/dsh-image-gen/lib tavern-plugin/packages/dsh-tavern-remote/lib dsh-tavern-runtime.json | sed 's/^/  /'
echo "  （上面为空表示这些文件相对 HEAD 没变；有变化时按 SYNC-PLAYBOOK 人工处理）"

echo
if [ $FAIL = 0 ]; then echo "regen: 全部一致"; else echo "regen: 有不一致，见上方" >&2; exit 1; fi
