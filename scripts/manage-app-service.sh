#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/Users/yj/Applications/Homer.app}"
HOMER_BIN="$APP_DIR/Contents/MacOS/Homer"
SERVICE_LABEL="${SERVICE_LABEL:-com.homer.daemon}"
LEGACY_PLIST="${LEGACY_PLIST:-$HOME/Library/LaunchAgents/com.homer.daemon.plist}"

ensure_app() {
  bash "$SCRIPT_DIR/build-homer-app.sh" "$APP_DIR" >/dev/null
}

show_status() {
  ensure_app
  "$HOMER_BIN" --agent-status
  if launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1; then
    echo "launchctl label $SERVICE_LABEL: loaded"
  else
    echo "launchctl label $SERVICE_LABEL: not loaded"
  fi
  if [[ -f "$LEGACY_PLIST" ]]; then
    echo "legacy plist: $LEGACY_PLIST"
  fi
}

case "${1:-status}" in
  build)
    bash "$SCRIPT_DIR/build-homer-app.sh" "$APP_DIR"
    ;;
  register)
    ensure_app
    exec "$HOMER_BIN" --register-agent
    ;;
  unregister)
    ensure_app
    exec "$HOMER_BIN" --unregister-agent
    ;;
  status)
    show_status
    ;;
  *)
    echo "Usage: $0 [build|register|unregister|status]" >&2
    exit 64
    ;;
esac
