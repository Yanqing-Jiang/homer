#!/usr/bin/env bash
#
# HOMER Watchdog Script
# Monitors HOMER daemon health and restarts if unresponsive
# Provides second-layer protection beyond launchd KeepAlive
# Triggers Claude Code investigation after consecutive failures
#

set -u
set -o pipefail

# Configuration (can be overridden via environment variables)
HOMER_LABEL="${HOMER_LABEL:-com.homer.daemon}"
LAUNCHD_DOMAIN="${LAUNCHD_DOMAIN:-gui/$(/usr/bin/id -u)}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"
PORT="${PORT:-3000}"
LOCK_FILE="${LOCK_FILE:-$HOME/Library/Application Support/Homer/homer.lock}"
LOCK_OWNER_PATTERN="${LOCK_OWNER_PATTERN:-homer|claude|node}"
INTERVAL="${INTERVAL:-15}"
RESTART_BACKOFF="${RESTART_BACKOFF:-30}"
PORT_CONFLICT_COOLDOWN="${PORT_CONFLICT_COOLDOWN:-300}"
MAX_NOTIFY_FAILURES="${MAX_NOTIFY_FAILURES:-3}"
INVESTIGATE_AFTER="${INVESTIGATE_AFTER:-2}"  # Trigger Claude investigation after this many failures
DISK_SPACE_MIN="${DISK_SPACE_MIN:-10}"      # Minimum disk space percentage before alerting
MEMORY_LIMIT_MB="${MEMORY_LIMIT_MB:-1024}"   # Memory limit in MB before alerting (1GB)
DISK_CHECK_INTERVAL="${DISK_CHECK_INTERVAL:-20}"  # Check disk every N health checks (~5 min at 15s interval)
DAILY_FIX_LIMIT="${DAILY_FIX_LIMIT:-5}"     # Max fix attempts per day before quarantine
DISK_EMERGENCY_THRESHOLD="${DISK_EMERGENCY_THRESHOLD:-5}"  # Trigger emergency cleanup below this %

STATE_DIR="$HOME/Library/Logs/homer"
LOG_FILE="$STATE_DIR/watchdog.log"
STATE_FILE="$STATE_DIR/watchdog.state"
HOMER_DIR="$HOME/homer"

mkdir -p "$STATE_DIR"

log() {
  local ts
  ts=$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "${ts} $*" | tee -a "$LOG_FILE"
}

state_get() {
  local key="$1"
  [[ -f "$STATE_FILE" ]] || return 1
  /usr/bin/awk -F= -v k="$key" '$1==k {print $2; exit}' "$STATE_FILE"
}

state_set() {
  local key="$1"
  local value="$2"
  if [[ -f "$STATE_FILE" ]]; then
    /usr/bin/awk -F= -v k="$key" -v v="$value" '
      BEGIN{found=0}
      $1==k {print k"="v; found=1; next}
      {print}
      END{if(!found) print k"="v}
    ' "$STATE_FILE" > "${STATE_FILE}.tmp" && /bin/mv "${STATE_FILE}.tmp" "$STATE_FILE"
  else
    echo "${key}=${value}" > "$STATE_FILE"
  fi
}

should_notify() {
  local key="$1"
  local cooldown="$2"
  local now
  now=$(/bin/date +%s)
  local last
  last=$(state_get "notify_${key}" || echo 0)
  if (( now - last >= cooldown )); then
    state_set "notify_${key}" "$now"
    return 0
  fi
  return 1
}

# Daily fix limit functions - prevent Claude Code fix loops
get_fix_count() {
  local count_file="$STATE_DIR/fix-count-$(/bin/date +%Y%m%d)"
  [[ -f "$count_file" ]] && cat "$count_file" || echo 0
}

increment_fix_count() {
  local count_file="$STATE_DIR/fix-count-$(/bin/date +%Y%m%d)"
  echo $(($(get_fix_count) + 1)) > "$count_file"
}

can_attempt_fix() {
  (( $(get_fix_count) < DAILY_FIX_LIMIT ))
}

# Diagnostic dump for human escalation
dump_diagnostics() {
  local dump_dir="$HOME/Desktop/homer-dumps"
  local dump_file="$dump_dir/crash-$(/bin/date +%Y%m%d_%H%M%S).txt"
  mkdir -p "$dump_dir"

  {
    echo "=== Homer Crash Dump $(/bin/date) ==="
    echo ""
    echo "=== System ==="
    uptime
    df -h "$HOME"
    vm_stat 2>/dev/null | head -10 || true
    echo ""
    echo "=== Processes ==="
    ps aux | grep -E "homer|claude|node" | grep -v grep
    echo ""
    echo "=== Lock Status ==="
    /usr/sbin/lsof -n -- "$LOCK_FILE" 2>/dev/null || echo "No lock holders"
    echo ""
    echo "=== Health Endpoint ==="
    /usr/bin/curl -s "$HEALTH_URL" 2>/dev/null | /usr/bin/python3 -m json.tool 2>/dev/null || echo "Health unavailable"
    echo ""
    echo "=== Recent Logs (last 100 lines) ==="
    tail -100 "$HOMER_DIR/logs/stdout.log" 2>/dev/null || echo "No stdout log"
    echo ""
    echo "=== Fatal Log ==="
    tail -50 "$STATE_DIR/fatal.log" 2>/dev/null || echo "No fatal log"
    echo ""
    echo "=== Watchdog State ==="
    cat "$STATE_FILE" 2>/dev/null || echo "No state file"
    echo ""
    echo "=== Fix Attempts Today ==="
    echo "$(get_fix_count) / $DAILY_FIX_LIMIT"
  } > "$dump_file"

  # macOS notification as backup if Telegram fails
  osascript -e "display notification \"Dump: $dump_file\" with title \"Homer Failed\"" 2>/dev/null || true

  log "Diagnostic dump saved to $dump_file"
}

# Emergency disk cleanup when critically low
emergency_disk_cleanup() {
  log "EMERGENCY: Running disk cleanup"
  # Remove rotated logs
  rm -f "$HOMER_DIR/logs/"*.log.[0-9]* 2>/dev/null || true
  rm -f "$HOMER_DIR/logs/"*.log.*.bz2 2>/dev/null || true
  # Remove old claude temp files
  find /tmp -name "claude-*" -mtime +1 -delete 2>/dev/null || true
  # Remove old crash dumps (keep last 5)
  ls -t "$HOME/Desktop/homer-dumps/"*.txt 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true
  log "Emergency cleanup complete"
}

send_telegram() {
  # Notifications disabled
  return 0
}

check_health() {
  /usr/bin/curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null
}

# Check disk space - returns 0 if OK, 1 if low
check_disk_space() {
  local free
  free=$(df -P "$HOME" 2>/dev/null | /usr/bin/awk 'NR==2 {print 100-$5}' | tr -d '%')
  if [[ -z "$free" ]]; then
    log "WARN: could not determine disk space"
    return 1
  fi
  # Emergency cleanup if critically low
  if (( free < DISK_EMERGENCY_THRESHOLD )); then
    log "CRITICAL: disk space critically low (${free}% free), triggering emergency cleanup"
    emergency_disk_cleanup
  fi
  if (( free < DISK_SPACE_MIN )); then
    log "CRITICAL: disk space low (${free}% free, threshold: ${DISK_SPACE_MIN}%)"
    if should_notify "disk_space" 3600; then  # Notify at most once per hour
      send_telegram "Homer: CRITICAL - disk space low (${free}% free)"
    fi
    return 1
  fi
  return 0
}

# Check memory usage from /health endpoint - returns 0 if OK, 1 if high
check_memory() {
  local health_json heap_used heap_mb
  health_json=$(/usr/bin/curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || echo '{}')
  heap_used=$(echo "$health_json" | /usr/bin/python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('memory',{}).get('heapUsed',0))" 2>/dev/null || echo 0)

  if [[ "$heap_used" == "0" ]]; then
    return 0  # Can't determine, assume OK
  fi

  heap_mb=$((heap_used / 1024 / 1024))
  if (( heap_mb > MEMORY_LIMIT_MB )); then
    log "WARN: heap usage high (${heap_mb}MB, limit: ${MEMORY_LIMIT_MB}MB)"
    if should_notify "memory_high" 1800; then  # Notify at most once per 30 min
      send_telegram "Homer: WARN - memory usage high (${heap_mb}MB)"
    fi
    return 1
  fi
  return 0
}

get_launchd_pid() {
  /bin/launchctl print "${LAUNCHD_DOMAIN}/${HOMER_LABEL}" 2>/dev/null | /usr/bin/awk '/pid =/ {print $3; exit}'
}

port_owner_pid() {
  /usr/sbin/lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null | /usr/bin/awk 'NR==2 {print $2; exit}'
}

pid_running() {
  /bin/ps -p "$1" >/dev/null 2>&1
}

pid_cmdline() {
  /bin/ps -o command= -p "$1" 2>/dev/null
}

lock_holder_pids() {
  /usr/sbin/lsof -n -t -- "$LOCK_FILE" 2>/dev/null | /usr/bin/sort -u
}

# Cleanup stale lock holders (orphaned child processes)
# This is the ROOT CAUSE fix: kill processes holding the lock when daemon is dead
cleanup_stale_lock() {
  local launchd_pid="$1"
  [[ -f "$LOCK_FILE" ]] || return 0

  local holders
  holders=$(lock_holder_pids || true)
  [[ -n "$holders" ]] || return 0

  # If launchd daemon is not running, all lock holders are stale
  if [[ -z "$launchd_pid" ]] || ! pid_running "$launchd_pid"; then
    log "stale lock detected; daemon not running but lock held by: $holders"
    for p in $holders; do
      local cmd
      cmd=$(pid_cmdline "$p")
      if echo "$cmd" | /usr/bin/grep -Eq "$LOCK_OWNER_PATTERN"; then
        log "killing stale lock holder ${p}: ${cmd}"
        /bin/kill -9 "$p" 2>/dev/null || true
      else
        log "lock holder ${p} did not match pattern; skipping (${cmd})"
      fi
    done
    /bin/sleep 1
  else
    # Daemon running but other processes also holding lock (shouldn't happen with O_CLOEXEC)
    for p in $holders; do
      if [[ "$p" != "$launchd_pid" ]]; then
        log "warning: lock also held by pid ${p} while daemon ${launchd_pid} is running"
      fi
    done
  fi
}

restart_homer() {
  # Kill any stale processes first
  /usr/bin/pkill -9 -f "homer/dist/index.js" 2>/dev/null || true
  /bin/sleep 2

  # Free up the port if stuck
  local port_pid
  port_pid=$(/usr/sbin/lsof -ti:${PORT} 2>/dev/null || true)
  if [[ -n "$port_pid" ]]; then
    kill -9 $port_pid 2>/dev/null || true
    /bin/sleep 1
  fi

  /bin/launchctl kickstart -k "${LAUNCHD_DOMAIN}/${HOMER_LABEL}" >/dev/null 2>&1 && return 0
  /bin/launchctl start "${HOMER_LABEL}" >/dev/null 2>&1 && return 0
  return 1
}

trigger_investigation() {
  local failure_count="$1"
  log "triggering Claude Code investigation after ${failure_count} consecutive failures"

  # Collect diagnostic info
  local stdout_tail stderr_tail fatal_tail ps_info
  stdout_tail=$(tail -50 "$HOMER_DIR/logs/stdout.log" 2>/dev/null | head -30)
  stderr_tail=$(tail -30 "$HOMER_DIR/logs/stderr.log" 2>/dev/null)
  fatal_tail=$(tail -20 "$STATE_DIR/fatal.log" 2>/dev/null)
  ps_info=$(ps aux | grep -E "homer|node" | grep -v grep | head -10)

  # Build investigation prompt
  local prompt="HOMER daemon failsafe triggered after ${failure_count} consecutive health check failures.

Use the codex subagent to root cause this issue. Analyze:

1. Recent stdout logs:
\`\`\`
${stdout_tail}
\`\`\`

2. Recent stderr logs:
\`\`\`
${stderr_tail}
\`\`\`

3. Fatal error logs:
\`\`\`
${fatal_tail}
\`\`\`

4. Current processes:
\`\`\`
${ps_info}
\`\`\`

5. Health endpoint: ${HEALTH_URL}
6. Port: ${PORT}

Root cause the failure and fix it if possible. Check for:
- Uncaught exceptions or unhandled rejections
- Port binding issues (EADDRINUSE)
- Telegram bot conflicts (multiple instances)
- Memory issues
- Database connection problems

After analysis, restart the daemon properly and verify it's healthy."

  # Run Claude Code in background
  (
    cd "$HOMER_DIR"
    /Users/yj/.claude/local/claude --dangerously-skip-permissions -p "$prompt" >> "$STATE_DIR/investigation.log" 2>&1
  ) &

  log "investigation started in background (PID: $!)"
}

log "watchdog started for ${HOMER_LABEL} in ${LAUNCHD_DOMAIN}"

# Initialize failure count
CONSECUTIVE_FAILURES=0
INVESTIGATION_TRIGGERED=false
DISK_CHECK_COUNTER=0

while true; do
  if check_health; then
    # Health check passed
    if (( CONSECUTIVE_FAILURES > 0 )); then
      log "health recovered after ${CONSECUTIVE_FAILURES} failures"
      if (( CONSECUTIVE_FAILURES >= MAX_NOTIFY_FAILURES )); then
        send_telegram "Homer daemon recovered after ${CONSECUTIVE_FAILURES} failures"
      fi
      CONSECUTIVE_FAILURES=0
      INVESTIGATION_TRIGGERED=false
    fi

    # Periodic disk and memory checks (every DISK_CHECK_INTERVAL iterations)
    DISK_CHECK_COUNTER=$((DISK_CHECK_COUNTER + 1))
    if (( DISK_CHECK_COUNTER >= DISK_CHECK_INTERVAL )); then
      DISK_CHECK_COUNTER=0
      check_disk_space || true  # Log but don't fail health check
      check_memory || true       # Log but don't fail health check
    fi

    # Only log every 40th successful check (~10 min at 15s interval)
    COUNT=$(state_get "health_ok_count" || echo 0)
    COUNT=$((COUNT + 1))
    if (( COUNT >= 40 )); then
      log "health ok (40 consecutive checks)"
      COUNT=0
    fi
    state_set "health_ok_count" "$COUNT"
    /bin/sleep "$INTERVAL"
    continue
  fi

  # Health check failed
  CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
  state_set "health_ok_count" "0"

  log "health failed (failure #${CONSECUTIVE_FAILURES})"

  PID=$(get_launchd_pid || true)
  PORT_PID=$(port_owner_pid || true)

  # CRITICAL: Cleanup stale lock holders before attempting restart
  # This prevents the crash loop caused by orphaned child processes holding flock()
  cleanup_stale_lock "$PID"

  # Check for port conflict (another non-homer process owns the port)
  if [[ -n "$PORT_PID" && "$PORT_PID" != "$PID" ]]; then
    # Check if it's another homer process (stale)
    if ps -p "$PORT_PID" -o args= 2>/dev/null | grep -q "homer/dist/index.js"; then
      log "stale homer process ${PORT_PID} holding port; killing it"
      kill -9 "$PORT_PID" 2>/dev/null || true
      /bin/sleep 2
    else
      log "port ${PORT} in use by non-homer pid ${PORT_PID}; skipping restart"
      if should_notify "port_conflict" "$PORT_CONFLICT_COOLDOWN"; then
        send_telegram "Homer watchdog: port ${PORT} in use by pid ${PORT_PID}; restart skipped"
      fi
      /bin/sleep "$INTERVAL"
      continue
    fi
  fi

  # Trigger Claude Code investigation after INVESTIGATE_AFTER failures (only once per failure cycle)
  if (( CONSECUTIVE_FAILURES == INVESTIGATE_AFTER )) && [[ "$INVESTIGATION_TRIGGERED" != "true" ]]; then
    if can_attempt_fix; then
      increment_fix_count
      INVESTIGATION_TRIGGERED=true
      trigger_investigation "$CONSECUTIVE_FAILURES"
      send_telegram "Homer watchdog: ${CONSECUTIVE_FAILURES} consecutive failures - triggered Claude Code investigation (fix $(get_fix_count)/${DAILY_FIX_LIMIT} today)"
      /bin/sleep "$RESTART_BACKOFF"
      continue
    else
      log "QUARANTINE: daily fix limit reached (${DAILY_FIX_LIMIT} attempts), alerting human"
      send_telegram "Homer QUARANTINED: ${DAILY_FIX_LIMIT} fix attempts exhausted today. Manual intervention required."
      dump_diagnostics
      # Sleep longer when quarantined to avoid log spam
      /bin/sleep 300
      continue
    fi
  fi

  # Attempt restart
  if restart_homer; then
    log "restart triggered"
    # Only send notification for first 3 failures, then go silent
    if (( CONSECUTIVE_FAILURES <= MAX_NOTIFY_FAILURES )); then
      send_telegram "Homer watchdog restarted daemon (failure #${CONSECUTIVE_FAILURES})"
    elif (( CONSECUTIVE_FAILURES == MAX_NOTIFY_FAILURES + 1 )); then
      send_telegram "Homer watchdog: silencing notifications after ${MAX_NOTIFY_FAILURES} consecutive failures. Will notify when recovered."
    fi
    /bin/sleep "$RESTART_BACKOFF"
  else
    log "restart failed"
    if (( CONSECUTIVE_FAILURES <= MAX_NOTIFY_FAILURES )); then
      send_telegram "Homer watchdog failed to restart daemon (failure #${CONSECUTIVE_FAILURES})"
    fi
    /bin/sleep "$RESTART_BACKOFF"
  fi
done
