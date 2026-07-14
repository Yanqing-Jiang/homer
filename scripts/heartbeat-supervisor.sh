#!/bin/bash

# Resident wrapper for heartbeat-monitor.sh. The GUI launchd domain can enter
# on-demand-only mode and suppress StartInterval jobs, so the timing loop must
# live outside launchd once the supervisor has been started.
set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR="$SCRIPT_DIR/heartbeat-monitor.sh"
INTERVAL="${HEARTBEAT_INTERVAL:-20}"

case "$INTERVAL" in
  ''|*[!0-9]*) INTERVAL=20 ;;
esac
(( INTERVAL >= 5 )) || INTERVAL=5

stopping=0
trap 'stopping=1' TERM INT HUP

while (( stopping == 0 )); do
  /bin/bash "$MONITOR" || true
  (( stopping == 0 )) || break
  /bin/sleep "$INTERVAL" &
  sleep_pid=$!
  wait "$sleep_pid" 2>/dev/null || true
done
