#!/usr/bin/env bash
#
# Pre-restart safety check — warns if active CLI runs are in progress.
# Called by `npm run deploy` before restarting the daemon.
#
# Exit codes:
#   0 — safe to restart (no active processes, or user confirmed)
#   1 — abort restart (active processes, user declined)
#

set -u

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"
DB_PATH="${HOME}/homer/data/homer.db"
MAX_WAIT="${MAX_WAIT:-300}"  # Max 5 minutes wait for drain

# Check for active CLI runs via SQLite (more reliable than health endpoint)
check_active_runs() {
  if ! command -v sqlite3 &>/dev/null; then
    echo 999  # fail closed: can't check, assume active
    return
  fi
  if [ ! -f "$DB_PATH" ]; then
    echo 999  # fail closed: DB missing
    return
  fi

  local count
  count=$(sqlite3 "$DB_PATH" \
    "SELECT COUNT(*) FROM cli_runs WHERE status = 'running' AND started_at > (CAST(strftime('%s','now','-2 hours') AS INTEGER) * 1000);" \
    2>/dev/null || echo "999")
  echo "$count"
}

active=$(check_active_runs)

if [ "$active" -eq 0 ] 2>/dev/null; then
  echo "No active CLI runs. Safe to restart."
  exit 0
fi

echo ""
echo "  WARNING: ${active} active CLI run(s) in progress."
echo ""

if [ "${HOMER_DEPLOY_POLICY:-}" = "force" ]; then
  echo "  Force deploy policy enabled. Restart will proceed despite active runs."
  exit 0
fi

# Check if running interactively
if [ -t 0 ]; then
  echo "  Options:"
  echo "    [w] Wait for them to complete (max ${MAX_WAIT}s)"
  echo "    [f] Force restart anyway (will kill active processes)"
  echo "    [a] Abort deploy"
  echo ""
  read -rp "  Choice [w/f/a]: " choice

  case "$choice" in
    w|W)
      echo "  Waiting for active runs to complete..."
      elapsed=0
      while [ "$elapsed" -lt "$MAX_WAIT" ]; do
        active=$(check_active_runs)
        if [ "$active" -eq 0 ] 2>/dev/null; then
          echo "  All runs completed. Safe to restart."
          exit 0
        fi
        sleep 5
        elapsed=$((elapsed + 5))
        printf "\r  Still waiting... %d active run(s), %ds elapsed" "$active" "$elapsed"
      done
      echo ""
      echo "  Timeout reached. ${active} run(s) still active."
      read -rp "  Force restart? [y/N]: " force
      if [ "$force" = "y" ] || [ "$force" = "Y" ]; then
        exit 0
      fi
      echo "  Deploy aborted."
      exit 1
      ;;
    f|F)
      echo "  Forcing restart (active processes will be killed)."
      exit 0
      ;;
    *)
      echo "  Deploy aborted."
      exit 1
      ;;
  esac
else
  # Non-interactive (e.g., called from scheduled job) — abort if active
  echo "  Non-interactive mode: aborting restart to protect active processes."
  exit 1
fi
