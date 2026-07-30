#!/usr/bin/env bash
set -euo pipefail

# prepare_python_runtime_macos.sh <arch>
#   Builds relocatable macOS Python runtime under build/python-runtime
#   for electron-builder extraResource bundling.
# Prerequisites: uv (astral-sh/setup-uv in CI), requirements.lock.txt

ARCH="${1:-}"
if [ -z "$ARCH" ] || { [ "$ARCH" != "arm64" ] && [ "$ARCH" != "x64" ]; }; then
  echo "usage: $0 <arm64|x64>" >&2; exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/build"
RUNTIME_DIR="$BUILD_DIR/python-runtime"
LOCK_FILE="$PROJECT_ROOT/requirements.lock.txt"
PYTHON_VERSION="3.12"

if [ ! -f "$LOCK_FILE" ]; then
  echo "requirements.lock.txt missing: $LOCK_FILE" >&2; exit 1
fi

echo "=== Magic Pointer macOS Python runtime ($ARCH) ==="
echo "  uv    : $(uv --version 2>/dev/null || echo 'NOT FOUND')"
echo "  dest  : $RUNTIME_DIR"

rm -rf "$RUNTIME_DIR"
mkdir -p "$BUILD_DIR"

uv python install "$PYTHON_VERSION" --install-dir "$BUILD_DIR/python-staging"

PYTHON_BIN=""
for candidate in \
  "$BUILD_DIR"/python-staging/cpython-"$PYTHON_VERSION"-*/bin/python3 \
  "$BUILD_DIR"/python-staging/cpython-"$PYTHON_VERSION"-*/install/bin/python3 \
  "$BUILD_DIR"/python-staging/bin/python3; do
  if [ -x "$candidate" ]; then PYTHON_BIN="$candidate"; break; fi
done

if [ -z "$PYTHON_BIN" ]; then
  echo "FATAL: cannot find uv-managed Python binary" >&2
  find "$BUILD_DIR/python-staging" -name 'python3' -type f 2>/dev/null || true
  exit 1
fi
echo "  python: $PYTHON_BIN ($("$PYTHON_BIN" --version 2>&1))"

mkdir -p "$RUNTIME_DIR/lib/python$PYTHON_VERSION/site-packages"
"$PYTHON_BIN" -m pip install \
  --disable-pip-version-check --no-input --progress-bar off \
  --require-hashes -r "$LOCK_FILE" \
  --target "$RUNTIME_DIR/lib/python$PYTHON_VERSION/site-packages"

PYTHON_PREFIX="$(dirname "$(dirname "$PYTHON_BIN")")"
cp -R "$PYTHON_PREFIX/lib/" "$RUNTIME_DIR/lib/" 2>/dev/null || true
if [ -d "$PYTHON_PREFIX/lib/python$PYTHON_VERSION" ] && [ ! -f "$RUNTIME_DIR/lib/python$PYTHON_VERSION/os.py" ]; then
  cp -R "$PYTHON_PREFIX/lib/python$PYTHON_VERSION/" "$RUNTIME_DIR/lib/python$PYTHON_VERSION/" 2>/dev/null || true
fi

mkdir -p "$RUNTIME_DIR/bin"
cp "$PYTHON_BIN" "$RUNTIME_DIR/bin/python3"
chmod +x "$RUNTIME_DIR/bin/python3"
ln -sf python3 "$RUNTIME_DIR/bin/python"

REQ_SHA256="$(shasum -a 256 "$LOCK_FILE" | awk '{print $1}')"
cat > "$RUNTIME_DIR/manifest.json" <<MANIFEST
{
  "schemaVersion": 1,
  "pythonVersion": "$("$PYTHON_BIN" -c 'import sys; print(sys.version)')",
  "requirementsSha256": "$REQ_SHA256",
  "builtAtUtc": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "arch": "$ARCH",
  "runtime": "uv-cpython-relocatable"
}
MANIFEST

echo "=== macOS Python runtime ready: $RUNTIME_DIR ==="
echo "  size: $(du -sh "$RUNTIME_DIR" 2>/dev/null | awk '{print $1}')"
