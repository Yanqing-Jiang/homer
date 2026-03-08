#!/bin/bash
# Claude Code SessionStart hook — logs session start and triggers context-bridge
# Registered in ~/.claude/settings.json hooks.SessionStart

LOG_FILE="$HOME/homer/logs/hooks.log"
MARKER_FILE="$HOME/homer/data/.claude-session-active"
BRIDGE_JS="$HOME/homer/dist/scheduler/jobs/context-bridge.js"

# Log
echo "[$(date -Iseconds)] SessionStart" >> "$LOG_FILE"

# Write session marker
echo "$(date -Iseconds)" > "$MARKER_FILE"

# Trigger context-bridge regeneration (non-blocking)
# Skip if MEMORY.md was updated in the last 5 minutes (handles rapid restarts)
MEMORY_FILE="$HOME/.claude/projects/-Users-yj/memory/MEMORY.md"
if [ -f "$MEMORY_FILE" ]; then
  AGE=$(( $(date +%s) - $(stat -f %m "$MEMORY_FILE") ))
  if [ "$AGE" -lt 300 ]; then
    echo "[$(date -Iseconds)] SessionStart: MEMORY.md fresh (${AGE}s old), skipping bridge" >> "$LOG_FILE"
    exit 0
  fi
fi

# Unset nested-session guard so context-bridge can call Claude CLI (Sonnet)
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT

# Prefers compiled JS. Falls back to API, then tsx.
if [ -f "$BRIDGE_JS" ]; then
  nohup node "$BRIDGE_JS" >> "$LOG_FILE" 2>&1 &
  echo "[$(date -Iseconds)] SessionStart: triggered context-bridge via node" >> "$LOG_FILE"
elif curl -sf -X POST "http://localhost:3000/api/jobs/context-bridge/trigger" -o /dev/null 2>/dev/null; then
  echo "[$(date -Iseconds)] SessionStart: triggered context-bridge via API" >> "$LOG_FILE"
else
  nohup npx tsx "$HOME/homer/src/scheduler/jobs/context-bridge.ts" >> "$LOG_FILE" 2>&1 &
  echo "[$(date -Iseconds)] SessionStart: triggered context-bridge via tsx (fallback)" >> "$LOG_FILE"
fi
