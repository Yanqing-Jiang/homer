#!/bin/bash
# Claude Code SessionStart hook — logs session start only
# SessionStart no longer triggers context-bridge due to abnormal usage churn.

LOG_FILE="$HOME/homer/logs/hooks.log"
MARKER_FILE="$HOME/homer/data/.claude-session-active"

log() {
  echo "[$(date -Iseconds)] $1" >> "$LOG_FILE"
}

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$MARKER_FILE")"

# Log
log "SessionStart"

# Write session marker
echo "$(date -Iseconds)" > "$MARKER_FILE"
