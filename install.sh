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

TMPDIR=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT INT TERM

BROKEN_LINK=$(find "$(npm root -g 2>/dev/null || echo '')" -maxdepth 1 -xtype l -name "$PACKAGE_NAME" 2>/dev/null || true)
if [ -n "$BROKEN_LINK" ]; then
  echo "cleaning broken global link: $BROKEN_LINK"
  rm -f "$BROKEN_LINK"
fi

echo "cloning $PACKAGE_SOURCE ..."
need_cmd git
git clone --depth 1 --branch "$PACKAGE_REF" "https://github.com/CorneliusTantius/volundr.git" "$TMPDIR/$PACKAGE_NAME"

cd "$TMPDIR/$PACKAGE_NAME"
echo "installing dependencies + building ..."
npm install
npm run build

GLOBAL_ROOT=$(npm root -g 2>/dev/null || true)
GLOBAL_PREFIX=$(npm prefix -g 2>/dev/null || true)
GLOBAL_BIN=$(dirname "$GLOBAL_ROOT")/bin
case "$(node -p 'process.platform')" in
  win32) GLOBAL_BIN="$GLOBAL_PREFIX" ;;
esac
if [ -n "$GLOBAL_BIN" ]; then
  for shim in "$GLOBAL_BIN/$PACKAGE_NAME" "$GLOBAL_BIN/$PACKAGE_NAME.cmd" "$GLOBAL_BIN/$PACKAGE_NAME.ps1"; do
    if [ -e "$shim" ] || [ -L "$shim" ]; then
      echo "cleaning existing global bin shim: $shim"
      rm -f "$shim"
    fi
  done
fi
if [ -n "$GLOBAL_ROOT" ] && { [ -e "$GLOBAL_ROOT/$PACKAGE_NAME" ] || [ -L "$GLOBAL_ROOT/$PACKAGE_NAME" ]; }; then
  echo "cleaning existing global package: $GLOBAL_ROOT/$PACKAGE_NAME"
  rm -rf "$GLOBAL_ROOT/$PACKAGE_NAME"
fi

echo "packing $PACKAGE_NAME ..."
TARBALL=$(npm pack | tail -n 1 | tr -d '\r')

echo "installing $PACKAGE_NAME globally from packed build ..."
npm install -g "./$TARBALL"

echo
echo "installed $PACKAGE_NAME ($PACKAGE_REF)."
echo "run in any project directory:"
echo "  volundr"
