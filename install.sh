#!/usr/bin/env sh
set -eu

PACKAGE_NAME="volundr"
PACKAGE_SOURCE="github:CorneliusTantius/volundr"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=19

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: missing required command: $1" >&2
    exit 1
  }
}

need_cmd node
need_cmd npm

NODE_VERSION=$(node -p 'process.versions.node')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  echo "error: node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 required (found $NODE_VERSION)" >&2
  exit 1
fi

echo "installing $PACKAGE_NAME globally from $PACKAGE_SOURCE ..."
npm install -g "$PACKAGE_SOURCE"

echo
echo "installed."
echo "run in any project directory:"
echo "  volundr"
