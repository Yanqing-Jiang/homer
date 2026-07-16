#!/usr/bin/env bash
#
# Install Homer's single user-level supervisor. The supervisor owns the daemon;
# launchd only needs to keep that one stable process alive.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOMER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOMER_USER="$(id -un)"
HOMER_GROUP="$(id -gn)"
HOMER_HOME="$HOME"
NODE_BIN="$(command -v node || true)"
HOMER_PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"
HOMER_APP_BIN="${HOMER_APP_BIN:-$HOMER_HOME/Applications/Homer.app/Contents/MacOS/Homer}"
TEMPLATE_SRC="$HOMER_DIR/config/com.homer.daemon.plist.template"
LOGS_DIR="$HOMER_DIR/logs"
PLIST_DST="$HOMER_HOME/Library/LaunchAgents/com.homer.daemon.plist"
DOMAIN="gui/$(id -u)"
TARGET="$DOMAIN/com.homer.daemon"

[[ -n "$NODE_BIN" ]] || { echo "node not found" >&2; exit 1; }
[[ -f "$TEMPLATE_SRC" ]] || { echo "missing $TEMPLATE_SRC" >&2; exit 1; }
[[ -f "$HOMER_DIR/dist/index.js" ]] || { echo "run npm run build first" >&2; exit 1; }
"$NODE_BIN" --check "$HOMER_DIR/scripts/daemon-supervisor.mjs"
mkdir -p "$LOGS_DIR"
GENERATED_PLIST="$(mktemp -t homer-plist-XXXXXX).plist"
trap 'rm -f "$GENERATED_PLIST"' EXIT
sed \
  -e "s|__HOMER_DIR__|$HOMER_DIR|g" \
  -e "s|__HOMER_USER__|$HOMER_USER|g" \
  -e "s|__HOMER_GROUP__|$HOMER_GROUP|g" \
  -e "s|__HOMER_HOME__|$HOMER_HOME|g" \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__HOMER_PATH__|$HOMER_PATH|g" \
  "$TEMPLATE_SRC" > "$GENERATED_PLIST"
grep -q '__[A-Z_]*__' "$GENERATED_PLIST" && { echo "unresolved plist placeholder" >&2; exit 1; }
plutil -lint "$GENERATED_PLIST" >/dev/null

# Retire the separate monitor first so it cannot race the migration.
launchctl bootout "$DOMAIN/com.homer.heartbeat" 2>/dev/null || true
rm -f "$HOMER_HOME/Library/LaunchAgents/com.homer.heartbeat.plist"

# Older installs used SMAppService. Unregister it before installing the direct agent.
if [[ -x "$HOMER_APP_BIN" ]] && "$HOMER_APP_BIN" --agent-status 2>/dev/null | grep -q enabled; then
  "$HOMER_APP_BIN" --unregister-agent >/dev/null
  for _ in {1..20}; do
    "$HOMER_APP_BIN" --agent-status 2>/dev/null | grep -q enabled || break
    sleep 0.25
  done
fi
launchctl bootout "$TARGET" 2>/dev/null || true
mkdir -p "$(dirname "$PLIST_DST")"
cp "$GENERATED_PLIST" "$PLIST_DST"
launchctl bootstrap "$DOMAIN" "$PLIST_DST"
launchctl enable "$TARGET"
launchctl kickstart "$TARGET"

for _ in {1..45}; do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null; then
    echo "Homer supervisor installed and healthy"
    launchctl print "$TARGET" | grep -E 'state =|pid ='
    exit 0
  fi
  sleep 1
done

echo "Homer failed to become healthy; see $LOGS_DIR/stderr.log" >&2
exit 1
