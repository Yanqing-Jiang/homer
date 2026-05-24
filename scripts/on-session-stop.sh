#!/bin/bash
# Claude Code Stop hook — logs session end and triggers session harvest only
# Registered in ~/.claude/settings.json hooks.Stop

LOG_FILE="$HOME/homer/logs/hooks.log"
MARKER_FILE="$HOME/homer/data/.claude-session-active"

# Log
echo "[$(date -Iseconds)] SessionStop" >> "$LOG_FILE"

# Remove session marker
rm -f "$MARKER_FILE"

# Immediate session-harvest trigger used to POST to /api/jobs/session-harvester/trigger
# on the old web server. After the web split, the daemon only serves /health and
# telephony webhooks — there is no /api endpoint to call. The scheduler's
# "session-harvester" cron picks up the ended session at the next tick instead.
# Re-enable here only if/when an internal-API surface is added to the daemon.

# Regenerate session-bootstrap.md so the next session boots with fresh focus state.
# Non-blocking — failures are logged and don't impact session shutdown.
(cd "$HOME/homer" && npm run -s memory:generate-bootstrap >> "$LOG_FILE" 2>&1) &
