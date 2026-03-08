#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-$HOME/Applications/Homer.app}"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
LAUNCH_AGENTS_DIR="$CONTENTS_DIR/Library/LaunchAgents"
LAUNCHER_SRC="$SCRIPT_DIR/macos/HomerLauncher.m"
INFO_PLIST_SRC="$SCRIPT_DIR/macos/Homer.Info.plist"
EMBEDDED_AGENT_SRC="$SCRIPT_DIR/macos/com.homer.daemon.plist"
LAUNCHER_DST="$MACOS_DIR/Homer"
INFO_PLIST_DST="$CONTENTS_DIR/Info.plist"
EMBEDDED_AGENT_DST="$LAUNCH_AGENTS_DIR/com.homer.daemon.plist"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

mkdir -p "$MACOS_DIR" "$LAUNCH_AGENTS_DIR"

/usr/bin/clang -fobjc-arc -O2 -Wall -Wextra \
  -framework Foundation \
  -framework ServiceManagement \
  "$LAUNCHER_SRC" \
  -o "$LAUNCHER_DST"
/bin/chmod 755 "$LAUNCHER_DST"
/bin/cp "$INFO_PLIST_SRC" "$INFO_PLIST_DST"
/bin/cp "$EMBEDDED_AGENT_SRC" "$EMBEDDED_AGENT_DST"

/usr/bin/codesign --force --deep --sign - "$APP_DIR" >/dev/null

if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$APP_DIR" >/dev/null 2>&1 || true
fi

echo "Built Homer app bundle at $APP_DIR"
