#!/bin/bash
# Maintain a stable, codesigned copy of `node` at ~/homer/bin/node.
#
# Why: TCC permissions ("node would like to access data from other apps", firewall
# accept-connections, etc.) are bound to the binary's path + signature. If the daemon
# launches /opt/homebrew/Cellar/node/<version>/bin/node directly, every Homebrew node
# upgrade changes the path and re-triggers every TCC + firewall prompt.
#
# Strategy: copy the real node binary into ~/homer/bin/node (a path Homebrew never
# touches), rewrite its @rpath libnode reference to a stable /opt/homebrew/lib path,
# and ad-hoc sign it. The daemon plist points at this stable path. TCC re-prompts
# only when the binary contents actually change (i.e., brew upgrade node), not on
# every Homer code update.
#
# Triggered by launchd WatchPaths on /opt/homebrew/Cellar/node — so this re-runs
# automatically after `brew upgrade node`.

set -euo pipefail

SRC_LINK="/opt/homebrew/bin/node"
DEST="$HOME/homer/bin/node"
LOG="/tmp/codesign-node.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

REAL_SRC="$(readlink -f "$SRC_LINK" 2>/dev/null || true)"
if [ -z "$REAL_SRC" ] || [ ! -f "$REAL_SRC" ]; then
  log "source node not found at $SRC_LINK"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"

# Skip if dest already matches source (compare by content hash)
if [ -f "$DEST" ]; then
  SRC_HASH=$(shasum -a 256 "$REAL_SRC" | awk '{print $1}')
  # Hash the destination's *original* content by stripping the signature first.
  # Simpler proxy: compare file sizes — install_name_tool changes only a few bytes
  # so size match + identical mtime suggests no work needed. Fall back to always
  # re-doing if in doubt.
  SRC_SIZE=$(stat -f%z "$REAL_SRC")
  DEST_SIZE=$(stat -f%z "$DEST")
  if [ "$SRC_SIZE" = "$DEST_SIZE" ] && [ "$REAL_SRC" -ot "$DEST" ]; then
    # Dest is newer than source AND same size → already current
    exit 0
  fi
fi

log "refreshing $DEST from $REAL_SRC"

# Copy
cp "$REAL_SRC" "$DEST"
chmod +x "$DEST"

# Rewrite @rpath libnode reference to stable Homebrew path so the binary is
# loadable without inheriting the Cellar-versioned rpath.
LIBNODE_REF=$(otool -L "$DEST" 2>/dev/null | awk '/@rpath\/libnode/ {print $1; exit}')
if [ -n "$LIBNODE_REF" ]; then
  SONAME="${LIBNODE_REF##*/}"   # e.g. libnode.147.dylib
  STABLE="/opt/homebrew/lib/$SONAME"
  if [ -e "$STABLE" ]; then
    install_name_tool -change "$LIBNODE_REF" "$STABLE" "$DEST" 2>/dev/null || true
    log "rewrote $LIBNODE_REF -> $STABLE"
  else
    log "WARN: stable libnode not found at $STABLE — leaving @rpath as-is"
  fi
fi

# Ad-hoc sign (install_name_tool invalidates any prior signature)
codesign --force --sign - "$DEST"
log "signed $DEST"

# Sanity check
if ! "$DEST" --version >> "$LOG" 2>&1; then
  log "ERROR: pinned node failed --version smoke test"
  exit 1
fi

log "done"
