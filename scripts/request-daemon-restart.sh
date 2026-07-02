#!/usr/bin/env bash
#
# Request a daemon restart via the heartbeat monitor.
# Writes a restart.request file; heartbeat picks it up on next cycle (<=20s).
# Safe: heartbeat defers if active CLI runs exist.
#
# Usage: request-daemon-restart.sh [reason] [--now] [--force] [--force-stale]
#   --now          If no active CLI runs, restart immediately via kickstart (skip heartbeat wait)
#   --force        Bypass CLI safety check entirely
#   --force-stale  Skip the build-freshness gate (intentional stale restart / crash recovery)
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_SUPPORT_DIR="${HOME}/Library/Application Support/Homer"
REQUEST_FILE="${APP_SUPPORT_DIR}/restart.request"
DB_PATH="${HOME}/homer/data/homer.db"
HOMER_LABEL="com.homer.daemon"
LAUNCHD_DOMAIN="gui/$(/usr/bin/id -u)"
LAUNCHD_TARGET="${LAUNCHD_DOMAIN}/${HOMER_LABEL}"

REASON=""
NOW_MODE=0
FORCE_MODE=0
FORCE_STALE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --now)         NOW_MODE=1 ;;
    --force)       FORCE_MODE=1 ;;
    --force-stale) FORCE_STALE=1 ;;
    *)             [ -z "$REASON" ] && REASON="$1" ;;
  esac
  shift
done

# Build-freshness gate: refuse to restart stale dist (would "ship" un-built src).
# Skipped for intentional stale restarts (--force-stale / HOMER_ALLOW_STALE_RESTART=1).
if (( FORCE_STALE == 0 )); then
  bash "${SCRIPT_DIR}/assert-build-fresh.sh"
fi

REASON="${REASON:-scheduled-maintenance}"
mkdir -p "$APP_SUPPORT_DIR"

active_cli_runs() {
  if [[ ! -f "$DB_PATH" ]]; then
    echo 999
    return
  fi
  /usr/bin/sqlite3 "$DB_PATH" \
    "SELECT COUNT(*) FROM cli_runs WHERE status = 'running' AND started_at > (CAST(strftime('%s','now','-2 hours') AS INTEGER) * 1000);" \
    2>/dev/null || echo 999
}

if (( FORCE_MODE == 1 )); then
  echo "Force restart requested: bypassing CLI safety check"
  /bin/launchctl kickstart -k "$LAUNCHD_TARGET" >/dev/null 2>&1 || \
    /bin/launchctl start "$HOMER_LABEL" >/dev/null 2>&1 || true
  echo "Restart executed (force mode)"
  exit 0
fi

if (( NOW_MODE == 1 )); then
  active=$(active_cli_runs)
  if [[ "$active" =~ ^[0-9]+$ ]] && (( active == 0 )); then
    echo "No active CLI runs — restarting immediately"
    /bin/launchctl kickstart -k "$LAUNCHD_TARGET" >/dev/null 2>&1 || \
      /bin/launchctl start "$HOMER_LABEL" >/dev/null 2>&1 || true
    echo "Restart executed (immediate mode)"
    exit 0
  fi
  echo "Active CLI runs detected (${active}) — falling back to request file"
fi

# Write request file for heartbeat to pick up
printf 'requested_at=%s\nreason=%s\npid=%s\n' \
  "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$REASON" \
  "$$" > "$REQUEST_FILE"

echo "Restart requested: ${REASON} (heartbeat will execute within 20s)"
