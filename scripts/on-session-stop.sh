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
# Catches the just-ended session before the next scheduled harvest.
# Hard timeouts so a stuck localhost socket can't block the Stop hook.
if curl -sf --connect-timeout 1 --max-time 3 -X POST "http://localhost:3000/api/jobs/session-harvester/trigger" -o /dev/null 2>/dev/null; then
  echo "[$(date -Iseconds)] SessionStop: triggered session-harvester via API" >> "$LOG_FILE"
fi

# Regenerate session-bootstrap.md so the next session boots with fresh focus state.
# Non-blocking — failures are logged and don't impact session shutdown.
(cd "$HOME/homer" && npm run -s memory:generate-bootstrap >> "$LOG_FILE" 2>&1) &
