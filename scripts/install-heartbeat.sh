#!/usr/bin/env bash

# Install and verify Homer's independent fast-recovery monitor.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOMER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOMER_HOME="$HOME"
HOMER_PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"
TEMPLATE="$HOMER_DIR/config/com.homer.heartbeat.plist.template"
MONITOR="$HOMER_DIR/scripts/heartbeat-monitor.sh"
SUPERVISOR="$HOMER_DIR/scripts/heartbeat-supervisor.sh"
DEST="$HOMER_HOME/Library/LaunchAgents/com.homer.heartbeat.plist"
TARGET="gui/$(id -u)/com.homer.heartbeat"
STATE_FILE="$HOMER_HOME/Library/Application Support/Homer/heartbeat-state.json"

[[ -f "$TEMPLATE" ]] || { echo "Missing heartbeat template: $TEMPLATE" >&2; exit 1; }
[[ -f "$MONITOR" ]] || { echo "Missing heartbeat monitor: $MONITOR" >&2; exit 1; }
[[ -f "$SUPERVISOR" ]] || { echo "Missing heartbeat supervisor: $SUPERVISOR" >&2; exit 1; }

# Catch the exact historical failure mode before touching launchd.
for script in "$MONITOR" "$SUPERVISOR"; do
  if LC_ALL=C grep -q $'\r' "$script"; then
    echo "Heartbeat script contains CRLF line endings: $script" >&2
    exit 1
  fi
  /bin/bash -n "$script"
done

mkdir -p "$(dirname "$DEST")" "$HOMER_HOME/Library/Logs/homer" "$(dirname "$STATE_FILE")"
TMP="$(mktemp -t homer-heartbeat-plist-XXXXXX).plist"
trap 'rm -f "$TMP"' EXIT
sed \
  -e "s|__HOMER_DIR__|$HOMER_DIR|g" \
  -e "s|__HOMER_HOME__|$HOMER_HOME|g" \
  -e "s|__HOMER_PATH__|$HOMER_PATH|g" \
  "$TEMPLATE" > "$TMP"

if grep -q '__[A-Z_]*__' "$TMP"; then
  echo "Heartbeat plist has unresolved placeholders" >&2
  exit 1
fi
plutil -lint "$TMP" >/dev/null

launchctl bootout "$TARGET" 2>/dev/null || true
cp "$TMP" "$DEST"
chmod 644 "$DEST"
launchctl bootstrap "gui/$(id -u)" "$DEST"
launchctl enable "$TARGET"
launchctl kickstart "$TARGET"

# Verify both the resident process and a fresh monitor lease.
for _ in 1 2 3 4 5; do
  if ! launchctl print "$TARGET" 2>/dev/null | grep -q 'state = running'; then
    sleep 1
    continue
  fi
  last_check="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("last_check_epoch",0))' "$STATE_FILE" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  if [[ "$last_check" =~ ^[0-9]+$ ]] && (( now - last_check <= 30 )); then
    echo "Heartbeat installed and verified (last check ${last_check})."
    exit 0
  fi
  sleep 1
done

echo "Heartbeat supervisor failed to stay running or write a fresh lease; inspect $HOMER_HOME/Library/Logs/homer/heartbeat.err.log" >&2
exit 1
