#!/usr/bin/env bash
# Install or verify the official, Developer-ID-signed Node.js binary used by Homer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOMER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="${NODE_RUNTIME_MANIFEST:-$HOMER_DIR/config/node-runtime.env}"
NODE_DST="${HOMER_NODE_BIN:-$HOMER_DIR/bin/node}"
LOG_FILE="${NODE_RUNTIME_LOG:-$HOMER_DIR/logs/node-runtime.log}"
MODE="install"
ALLOW_MAJOR=0
LOCK_DIR="$(dirname "$NODE_DST")/.node-runtime.lock"

usage() {
  echo "Usage: $0 [--check | --rollback] [--allow-major]"
}

for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --rollback) MODE="rollback" ;;
    --allow-major) ALLOW_MAJOR=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[[ -f "$MANIFEST" ]] || { echo "Missing runtime manifest: $MANIFEST" >&2; exit 1; }
read_manifest_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$MANIFEST"
}
NODE_VERSION="$(read_manifest_value NODE_VERSION)"
NODE_DARWIN_ARM64_SHA256="$(read_manifest_value NODE_DARWIN_ARM64_SHA256)"
NODE_SIGNING_TEAM_ID="$(read_manifest_value NODE_SIGNING_TEAM_ID)"
: "${NODE_VERSION:?NODE_VERSION is required}"
: "${NODE_DARWIN_ARM64_SHA256:?NODE_DARWIN_ARM64_SHA256 is required}"
: "${NODE_SIGNING_TEAM_ID:?NODE_SIGNING_TEAM_ID is required}"

mkdir -p "$(dirname "$NODE_DST")" "$(dirname "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] node-runtime mode=$MODE target=$NODE_DST version=$NODE_VERSION"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another Node runtime operation is active: $LOCK_DIR" >&2
  exit 1
fi
tmp_dir=""
cleanup() {
  [[ -z "$tmp_dir" ]] || rm -rf "$tmp_dir"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

verify_binary() {
  local candidate="$1" actual_version signature designated linked arch
  [[ -x "$candidate" ]] || { echo "Runtime is not executable: $candidate" >&2; return 1; }
  actual_version="$($candidate --version)"
  [[ "$actual_version" == "v$NODE_VERSION" ]] || {
    echo "Version mismatch: expected v$NODE_VERSION, got $actual_version" >&2
    return 1
  }
  arch="$(file "$candidate")"
  [[ "$arch" == *"arm64"* ]] || { echo "Runtime is not arm64: $arch" >&2; return 1; }
  codesign --verify --strict "$candidate"
  signature="$(codesign -dv --verbose=4 "$candidate" 2>&1)"
  [[ "$signature" == *"TeamIdentifier=$NODE_SIGNING_TEAM_ID"* ]] || {
    echo "Unexpected signing team" >&2; return 1;
  }
  [[ "$signature" == *"Authority=Developer ID Application: Node.js Foundation"* ]] || {
    echo "Runtime is not signed by the Node.js Foundation" >&2; return 1;
  }
  designated="$(codesign -d -r- "$candidate" 2>&1)"
  [[ "$designated" != *"cdhash"* ]] || {
    echo "Designated requirement is cdhash-bound" >&2; return 1;
  }
  linked="$(otool -L "$candidate")"
  [[ "$linked" != *"/opt/homebrew"* && "$linked" != *"/usr/local/Cellar"* ]] || {
    echo "Runtime has Homebrew-linked libraries" >&2; return 1;
  }
}

verify_native_modules() {
  local runtime="$1" repo
  for repo in "$HOMER_DIR" "$HOMER_DIR/../homer-web"; do
    [[ -d "$repo/node_modules" ]] || continue
    (cd "$repo" && "$runtime" -e "require('better-sqlite3'); require('fs-ext')") || {
      echo "Native module smoke test failed in $repo" >&2
      return 1
    }
  done
}

rebuild_native_modules() {
  local runtime="$1" repo npm_bin
  npm_bin="$(command -v npm || true)"
  [[ -n "$npm_bin" ]] || { echo "npm is required to rebuild native modules" >&2; return 1; }
  for repo in "$HOMER_DIR" "$HOMER_DIR/../homer-web"; do
    [[ -f "$repo/package.json" && -d "$repo/node_modules" ]] || continue
    echo "Rebuilding native modules in $repo for $($runtime --version)"
    (cd "$repo" && PATH="$(dirname "$runtime"):$PATH" "$npm_bin" rebuild better-sqlite3 fs-ext)
  done
}

if [[ "$MODE" == "check" ]]; then
  verify_binary "$NODE_DST"
  verify_native_modules "$NODE_DST"
  echo "Managed Node runtime is valid"
  exit 0
fi

if [[ "$MODE" == "rollback" ]]; then
  [[ -x "$NODE_DST.prev" ]] || { echo "No rollback runtime at $NODE_DST.prev" >&2; exit 1; }
  verify_binary "$NODE_DST.prev"
  rollback_staged="$(dirname "$NODE_DST")/.node.rollback.$$"
  cp -p "$NODE_DST.prev" "$rollback_staged"
  mv -f "$rollback_staged" "$NODE_DST"
  verify_binary "$NODE_DST"
  verify_native_modules "$NODE_DST"
  echo "Rolled back managed Node to $($NODE_DST --version)"
  exit 0
fi

if [[ -x "$NODE_DST" && "$ALLOW_MAJOR" -ne 1 ]]; then
  current_version="$($NODE_DST --version 2>/dev/null || true)"
  current_major="${current_version#v}"; current_major="${current_major%%.*}"
  target_major="${NODE_VERSION%%.*}"
  if [[ -n "$current_major" && "$current_major" != "$target_major" ]]; then
    echo "Refusing Node major change $current_major -> $target_major without --allow-major" >&2
    exit 1
  fi
fi

tmp_dir="$(mktemp -d "$(dirname "$NODE_DST")/.node-runtime.XXXXXX")"
archive="$tmp_dir/node.tar.gz"
url="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz"
echo "Downloading $url"
curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$url"
actual_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
[[ "$actual_sha" == "$NODE_DARWIN_ARM64_SHA256" ]] || {
  echo "SHA-256 mismatch: expected $NODE_DARWIN_ARM64_SHA256, got $actual_sha" >&2
  exit 1
}
tar -xzf "$archive" -C "$tmp_dir"
candidate="$tmp_dir/node-v$NODE_VERSION-darwin-arm64/bin/node"
verify_binary "$candidate"
if ! verify_native_modules "$candidate"; then
  rebuild_native_modules "$candidate"
  verify_native_modules "$candidate"
fi

staged="$(dirname "$NODE_DST")/.node.new.$$"
cp -p "$candidate" "$staged"
verify_binary "$staged"
if [[ -e "$NODE_DST" ]]; then
  cp -p "$NODE_DST" "$NODE_DST.prev"
fi
mv -f "$staged" "$NODE_DST"
if ! verify_binary "$NODE_DST" || ! verify_native_modules "$NODE_DST"; then
  echo "Post-swap verification failed; restoring previous runtime" >&2
  if [[ -x "$NODE_DST.prev" ]]; then
    rollback_staged="$(dirname "$NODE_DST")/.node.rollback.$$"
    cp -p "$NODE_DST.prev" "$rollback_staged"
    mv -f "$rollback_staged" "$NODE_DST"
  fi
  exit 1
fi
echo "Installed official Node v$NODE_VERSION at $NODE_DST; previous runtime: $NODE_DST.prev"
