#!/bin/sh
# business-agent 安装入口(POSIX wrapper):
# 校验 Node.js >= 18 后,把参数转发给 bin/init-workspace.cjs。
# 首个非 "-" 开头的参数被视为目标工作区(等价于 --target),两种写法都支持:
#   ./install.sh . --tools claude
#   ./install.sh --target /path/to/workspace --tools claude,cursor --yes
set -e

case "${1:-}" in
  ''|-*) ;;
  *) BA_TARGET="$1"; shift; set -- --target "$BA_TARGET" "$@" ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "错误:未找到 node。business-agent 需要 Node.js >= 18,请先安装。" >&2
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) NODE_MAJOR=0 ;;
esac
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误:Node.js 版本过低($(node -v 2>/dev/null || echo unknown)),business-agent 需要 >= 18。" >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/bin/init-workspace.cjs" "$@"
