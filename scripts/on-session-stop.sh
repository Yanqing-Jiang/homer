#!/bin/bash
# Claude Code Stop hook — logs session end and triggers session harvest only
# Registered in ~/.claude/settings.json hooks.Stop

LOG_FILE="$HOME/homer/logs/hooks.log"
MARKER_FILE="$HOME/homer/data/.claude-session-active"

# Log
echo "[$(date -Iseconds)] SessionStop" >> "$LOG_FILE"

# Remove session marker
rm -f "$MARKER_FILE"

# Trigger immediate session harvest (non-blocking)
# Catches the just-ended session before the next scheduled harvest
if curl -sf -X POST "http://localhost:3000/api/jobs/session-harvester/trigger" -o /dev/null 2>/dev/null; then
  echo "[$(date -Iseconds)] SessionStop: triggered session-harvester via API" >> "$LOG_FILE"
fi
