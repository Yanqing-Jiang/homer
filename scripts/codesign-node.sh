#!/bin/bash
# Re-sign Node.js binary to suppress macOS firewall "accept incoming connections" prompt.
# Triggered by launchd WatchPaths when Homebrew updates node.

NODE_BIN="/opt/homebrew/bin/node"
REAL_BIN="$(readlink -f "$NODE_BIN" 2>/dev/null)"

if [ -z "$REAL_BIN" ] || [ ! -f "$REAL_BIN" ]; then
  echo "$(date): node binary not found at $NODE_BIN" >> /tmp/codesign-node.log
  exit 0
fi

# Check if already ad-hoc signed by us (avoid redundant signing)
if codesign -dv "$REAL_BIN" 2>&1 | grep -q "Signature=adhoc"; then
  exit 0
fi

codesign --force --sign - "$REAL_BIN" 2>&1
echo "$(date): signed $REAL_BIN" >> /tmp/codesign-node.log
