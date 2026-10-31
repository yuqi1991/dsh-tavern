#!/usr/bin/env bash
# 兼容入口：转发到通用的 bin/deploy.sh（保持旧文档里的命令可用）。
exec "$(dirname "${BASH_SOURCE[0]}")/deploy.sh" "$@"
