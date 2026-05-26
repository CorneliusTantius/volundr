#!/usr/bin/env sh
set -eu

PACKAGE_NAME="volundr"
PACKAGE_REPO="github:CorneliusTantius/volundr"
PACKAGE_REF="${1:-${VOLUNDR_VERSION:-main}}"
PACKAGE_SOURCE="${PACKAGE_REPO}#${PACKAGE_REF}"
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

BROKEN_LINK=$(find "$(npm root -g 2>/dev/null || echo '')" -maxdepth 1 -xtype l -name "$PACKAGE_NAME" 2>/dev/null || true)
if [ -n "$BROKEN_LINK" ]; then
  echo "cleaning broken global link: $BROKEN_LINK"
  rm -f "$BROKEN_LINK"
fi

echo "installing $PACKAGE_NAME globally from $PACKAGE_SOURCE ..."
npm install -g "$PACKAGE_SOURCE"

echo
echo "installed $PACKAGE_NAME ($PACKAGE_REF)."
echo "run in any project directory:"
echo "  volundr"
