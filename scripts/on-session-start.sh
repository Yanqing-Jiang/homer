#!/bin/bash
# Claude Code SessionStart hook — logs session start and triggers context-bridge
# Registered in ~/.claude/settings.json hooks.SessionStart

LOG_FILE="$HOME/homer/logs/hooks.log"
MARKER_FILE="$HOME/homer/data/.claude-session-active"

# Log
echo "[$(date -Iseconds)] SessionStart" >> "$LOG_FILE"

# Write session marker
echo "$(date -Iseconds)" > "$MARKER_FILE"

# Trigger context-bridge regeneration (non-blocking)
# Uses Homer's web API if available, falls back to direct tsx execution
if curl -sf -X POST "http://localhost:3000/api/jobs/context-bridge/trigger" -o /dev/null 2>/dev/null; then
  echo "[$(date -Iseconds)] SessionStart: triggered context-bridge via API" >> "$LOG_FILE"
else
  # Direct execution as fallback (still non-blocking)
  nohup npx tsx "$HOME/homer/src/scheduler/jobs/context-bridge.ts" >> "$LOG_FILE" 2>&1 &
  echo "[$(date -Iseconds)] SessionStart: triggered context-bridge via tsx (fallback)" >> "$LOG_FILE"
fi
