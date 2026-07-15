#!/usr/bin/env bash

# Ask the resident supervisor to restart Homer. The supervisor stays alive
# while the daemon drains and starts again, so launchd is not in the restart path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOMER_ROOT="${HOMER_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
TARGET="${LAUNCHD_TARGET:-gui/$(id -u)/com.homer.daemon}"
FORCE=0
FORCE_STALE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --force-stale) FORCE_STALE=1 ;;
    --now) ;;
  esac
done

if (( FORCE_STALE == 0 )); then
  bash "$HOMER_ROOT/scripts/assert-build-fresh.sh"
fi
if (( FORCE == 0 )); then
  bash "$HOMER_ROOT/scripts/pre-restart-check.sh"
fi

supervisor_pid="$(launchctl print "$TARGET" 2>/dev/null | awk '/pid =/ {print $3; exit}')"
if [[ ! "$supervisor_pid" =~ ^[0-9]+$ ]] || ! kill -0 "$supervisor_pid" 2>/dev/null; then
  echo "refuse: Homer supervisor is not running; install it with 'npm run supervisor:install'." >&2
  exit 1
fi

kill -HUP "$supervisor_pid"
echo "Restart requested from Homer supervisor (pid $supervisor_pid)."
