#!/usr/bin/env bash
#
# kickstart-daemon.sh — Minimal daemon restart trigger.
#
# Activated by:
#   - launchd WatchPaths (kickstart.request file appears)
#   - Telegram /kickstart (writes kickstart.request)
#   - Web UI /api/kickstart (writes kickstart.request)
#   - CLI: bash scripts/kickstart-daemon.sh [--force]
#
# Safety: checks for active CLI runs unless --force is passed.
# Checks for drain sentinel to avoid interrupting graceful shutdown.
#

set -eo pipefail

HOMER_LABEL="com.homer.daemon"
LAUNCHD_DOMAIN="gui/$(/usr/bin/id -u)"
LAUNCHD_TARGET="${LAUNCHD_DOMAIN}/${HOMER_LABEL}"

APP_SUPPORT_DIR="${HOME}/Library/Application Support/Homer"
TRIGGER_FILE="${APP_SUPPORT_DIR}/kickstart.request"
DRAIN_SENTINEL="${APP_SUPPORT_DIR}/daemon.draining"
FORCE_RESTART_FILE="${APP_SUPPORT_DIR}/force-restart"
DB_PATH="${HOME}/homer/data/homer.db"
LOG_DIR="${HOME}/Library/Logs/homer"
LOG_FILE="${LOG_DIR}/kickstart.log"

DRAIN_MAX_AGE_SECS=360  # 6 minutes

mkdir -p "$APP_SUPPORT_DIR" "$LOG_DIR"

log() {
  local ts
  ts="$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "${ts} $*" >> "$LOG_FILE"
  echo "$*"
}

# Clean up trigger file (consumed on read)
if [ -f "$TRIGGER_FILE" ]; then
  log "trigger file consumed: $(cat "$TRIGGER_FILE" 2>/dev/null | head -3 | tr '\n' ' ')"
  /bin/rm -f "$TRIGGER_FILE"
fi

# Parse args
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
  esac
done

# Check drain sentinel (skip if --force)
if [ "$FORCE" -eq 0 ] && [ -f "$DRAIN_SENTINEL" ]; then
  sentinel_age=$(($(date +%s) - $(stat -f%m "$DRAIN_SENTINEL")))
  if [ "$sentinel_age" -gt "$DRAIN_MAX_AGE_SECS" ]; then
    log "stale drain sentinel (age=${sentinel_age}s); removing and proceeding"
    /bin/rm -f "$DRAIN_SENTINEL"
  else
    log "daemon is draining (age=${sentinel_age}s); kickstart suppressed"
    exit 0
  fi
fi

# Check force-restart escape hatch
if [ -f "$FORCE_RESTART_FILE" ]; then
  log "force-restart file detected; bypassing safety checks"
  /bin/rm -f "$FORCE_RESTART_FILE"
  FORCE=1
fi

# Check active CLI runs (skip if --force)
if [ "$FORCE" -eq 0 ]; then
  active=0
  if [ -f "$DB_PATH" ]; then
    active=$(/usr/bin/sqlite3 "$DB_PATH" \
      "SELECT COUNT(*) FROM cli_runs WHERE status = 'running' AND started_at > (CAST(strftime('%s','now','-2 hours') AS INTEGER) * 1000);" \
      2>/dev/null || echo "999")
  fi
  if [ "$active" -gt 0 ] 2>/dev/null; then
    log "kickstart deferred: ${active} active CLI run(s)"
    exit 1
  fi
fi

# Do the kickstart
log "kickstarting ${LAUNCHD_TARGET}"
/bin/launchctl kickstart -k "$LAUNCHD_TARGET" >/dev/null 2>&1 || \
  /bin/launchctl start "$HOMER_LABEL" >/dev/null 2>&1 || {
    log "kickstart failed"
    exit 1
  }

log "kickstart sent"
