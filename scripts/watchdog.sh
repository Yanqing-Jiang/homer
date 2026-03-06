#!/usr/bin/env bash
#
# HOMER Watchdog Script v2
#
# Monitors daemon health and delegates ALL restart/kill decisions to Claude Code.
# The watchdog itself NEVER kills or restarts — it only observes and triages.
#
# Changes from v1:
# - Health probe timeout: 5s → 15s
# - Check interval: 15s → 60s
# - Consecutive failures required before action: 1 → 3
# - No blind restart_homer() — Claude Code decides: restart / force_kill / fix / escalate
# - Double-kill capability preserved but only executed when CC explicitly requests it
#

set -u
set -o pipefail

# ============================================
# Configuration
# ============================================

HOMER_LABEL="${HOMER_LABEL:-com.homer.daemon}"
LAUNCHD_DOMAIN="${LAUNCHD_DOMAIN:-gui/$(/usr/bin/id -u)}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"
PORT="${PORT:-3000}"
LOCK_FILE="${LOCK_FILE:-$HOME/Library/Application Support/Homer/homer.lock}"
LOCK_OWNER_PATTERN="${LOCK_OWNER_PATTERN:-homer|claude|node}"

# Timing — 30min interval to avoid wasteful polling (resource-aware)
INTERVAL="${INTERVAL:-1800}"                    # Check every 30min (was 60s)
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-15}"          # Probe timeout 15s
FAILURES_BEFORE_ACTION="${FAILURES_BEFORE_ACTION:-2}"  # 2 consecutive failures = ~30min observed before action
TRIAGE_COOLDOWN="${TRIAGE_COOLDOWN:-300}"       # Wait 5min after triage action before next check

# Resource checks
DISK_SPACE_MIN="${DISK_SPACE_MIN:-10}"
MEMORY_LIMIT_MB="${MEMORY_LIMIT_MB:-1024}"
DISK_CHECK_INTERVAL="${DISK_CHECK_INTERVAL:-1}"   # Every check (~30 min at 1800s)
DISK_EMERGENCY_THRESHOLD="${DISK_EMERGENCY_THRESHOLD:-5}"

# Claude Code triage
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || echo "$HOME/.claude/local/claude")}"
TRIAGE_TIMEOUT="${TRIAGE_TIMEOUT:-120}"         # Max 2 min for triage analysis
FIX_TIMEOUT="${FIX_TIMEOUT:-180}"               # Max 3 min for code fix
DAILY_FIX_LIMIT="${DAILY_FIX_LIMIT:-5}"

# State
STATE_DIR="$HOME/Library/Logs/homer"
LOG_FILE="$STATE_DIR/watchdog.log"
STATE_FILE="$STATE_DIR/watchdog.state"
CRASH_REPORTS_DIR="$STATE_DIR/crash-reports"
HOMER_DIR="$HOME/homer"

mkdir -p "$STATE_DIR" "$CRASH_REPORTS_DIR"

# macOS doesn't have `timeout` — use background + kill pattern
run_with_timeout() {
  local secs="$1"; shift
  "$@" &
  local pid=$!
  ( /bin/sleep "$secs"; /bin/kill "$pid" 2>/dev/null ) &
  local timer=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  /bin/kill "$timer" 2>/dev/null
  wait "$timer" 2>/dev/null
  return "$rc"
}

# ============================================
# Logging & State
# ============================================

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

# ============================================
# Daily fix limit (circuit breaker)
# ============================================

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

# ============================================
# Diagnostics
# ============================================

dump_diagnostics() {
  local dump_file="$CRASH_REPORTS_DIR/crash-$(/bin/date +%Y%m%d_%H%M%S).txt"

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
    echo "=== Port ${PORT} ==="
    /usr/sbin/lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null || echo "Port free"
    echo ""
    echo "=== Health Endpoint ==="
    /usr/bin/curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null | /usr/bin/python3 -m json.tool 2>/dev/null || echo "Health unavailable"
    echo ""
    echo "=== Recent stdout (last 80 lines) ==="
    tail -80 "$HOMER_DIR/logs/stdout.log" 2>/dev/null || echo "No stdout log"
    echo ""
    echo "=== Recent stderr (last 40 lines) ==="
    tail -40 "$HOMER_DIR/logs/stderr.log" 2>/dev/null || echo "No stderr log"
    echo ""
    echo "=== Fatal Log (last 30 lines) ==="
    tail -30 "$STATE_DIR/fatal.log" 2>/dev/null || echo "No fatal log"
    echo ""
    echo "=== Watchdog State ==="
    cat "$STATE_FILE" 2>/dev/null || echo "No state file"
    echo ""
    echo "=== Fix Attempts Today ==="
    echo "$(get_fix_count) / $DAILY_FIX_LIMIT"
  } > "$dump_file"

  log "Diagnostic dump saved to $dump_file"
  echo "$dump_file"
}

emergency_disk_cleanup() {
  log "EMERGENCY: Running disk cleanup"
  rm -f "$HOMER_DIR/logs/"*.log.[0-9]* 2>/dev/null || true
  rm -f "$HOMER_DIR/logs/"*.log.*.bz2 2>/dev/null || true
  find /tmp -name "claude-*" -mtime +1 -delete 2>/dev/null || true
  ls -t "$CRASH_REPORTS_DIR/"*.txt 2>/dev/null | tail -n +20 | xargs rm -f 2>/dev/null || true
  log "Emergency cleanup complete"
}

# ============================================
# Health checks
# ============================================

check_health() {
  /usr/bin/curl -fsS --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" >/dev/null
}

check_disk_space() {
  local free
  free=$(df -P "$HOME" 2>/dev/null | /usr/bin/awk 'NR==2 {print 100-$5}' | tr -d '%')
  if [[ -z "$free" ]]; then
    log "WARN: could not determine disk space"
    return 1
  fi
  if (( free < DISK_EMERGENCY_THRESHOLD )); then
    log "CRITICAL: disk space critically low (${free}% free)"
    emergency_disk_cleanup
  fi
  if (( free < DISK_SPACE_MIN )); then
    log "CRITICAL: disk space low (${free}% free)"
    return 1
  fi
  return 0
}

check_memory() {
  local health_json heap_used heap_mb
  health_json=$(/usr/bin/curl -fsS --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" 2>/dev/null || echo '{}')
  heap_used=$(echo "$health_json" | /usr/bin/python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('memory',{}).get('heapUsed',0))" 2>/dev/null || echo 0)
  [[ "$heap_used" == "0" ]] && return 0
  heap_mb=$((heap_used / 1024 / 1024))
  if (( heap_mb > MEMORY_LIMIT_MB )); then
    log "WARN: heap usage high (${heap_mb}MB, limit: ${MEMORY_LIMIT_MB}MB)"
    return 1
  fi
  return 0
}

# ============================================
# Process inspection (read-only)
# ============================================

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

# ============================================
# Action executors (called ONLY by CC decision)
# ============================================

# Check if active CLI runs are in progress (protect user requests)
has_active_runs() {
  local db="$HOME/homer/data/homer.db"
  if ! command -v sqlite3 &>/dev/null || [ ! -f "$db" ]; then
    return 1  # Can't check, assume no active runs
  fi
  local count
  count=$(sqlite3 "$db" "SELECT COUNT(*) FROM cli_runs WHERE status = 'running'" 2>/dev/null || echo "0")
  [ "$count" -gt 0 ]
}

# Gentle restart: launchctl kickstart (no kill)
action_restart() {
  if has_active_runs; then
    log "ACTION: restart deferred — active CLI runs in progress, will retry next cycle"
    return 0  # Return success to avoid escalation, watchdog will re-check next cycle
  fi
  log "ACTION: gentle restart via launchctl"
  /bin/launchctl kickstart -k "${LAUNCHD_DOMAIN}/${HOMER_LABEL}" >/dev/null 2>&1 && return 0
  /bin/launchctl start "${HOMER_LABEL}" >/dev/null 2>&1 && return 0
  return 1
}

# Force kill: pkill -9 + port cleanup + restart (the old double-kill)
action_force_kill() {
  log "ACTION: force kill all homer processes + restart"
  /usr/bin/pkill -9 -f "homer/dist/index.js" 2>/dev/null || true
  /bin/sleep 2

  # Free port if stuck
  local port_pid
  port_pid=$(/usr/sbin/lsof -ti:${PORT} 2>/dev/null || true)
  if [[ -n "$port_pid" ]]; then
    log "ACTION: killing port holder ${port_pid}"
    kill -9 $port_pid 2>/dev/null || true
    /bin/sleep 1
  fi

  # Clean stale lock holders
  local holders
  holders=$(lock_holder_pids || true)
  if [[ -n "$holders" ]]; then
    for p in $holders; do
      local cmd
      cmd=$(pid_cmdline "$p")
      if echo "$cmd" | /usr/bin/grep -Eq "$LOCK_OWNER_PATTERN"; then
        log "ACTION: killing stale lock holder ${p}: ${cmd}"
        /bin/kill -9 "$p" 2>/dev/null || true
      fi
    done
    /bin/sleep 1
  fi

  /bin/launchctl kickstart -k "${LAUNCHD_DOMAIN}/${HOMER_LABEL}" >/dev/null 2>&1 && return 0
  /bin/launchctl start "${HOMER_LABEL}" >/dev/null 2>&1 && return 0
  return 1
}

# Escalate: dump diagnostics, macOS notification, sleep long
action_escalate() {
  local reason="${1:-unknown}"
  log "ACTION: escalate — ${reason}"
  local dump_file
  dump_file=$(dump_diagnostics)
  osascript -e "display notification \"${reason}\" with title \"Homer Escalation\"" 2>/dev/null || true
}

# ============================================
# Claude Code triage
# ============================================

gather_crash_context() {
  local failure_count="$1"
  local context=""

  context+="=== WATCHDOG TRIAGE REQUEST ==="$'\n'
  context+="Consecutive health failures: ${failure_count}"$'\n'
  context+="Timestamp: $(/bin/date '+%Y-%m-%d %H:%M:%S %Z')"$'\n'
  context+="Health URL: ${HEALTH_URL}"$'\n'
  context+="Port: ${PORT}"$'\n'
  context+="Fix attempts today: $(get_fix_count)/${DAILY_FIX_LIMIT}"$'\n'
  context+=$'\n'

  # launchd state
  local lpid
  lpid=$(get_launchd_pid || echo "none")
  context+="=== LAUNCHD ==="$'\n'
  context+="launchd PID: ${lpid}"$'\n'
  if [[ "$lpid" != "none" ]]; then
    context+="Running: $(pid_running "$lpid" && echo yes || echo no)"$'\n'
  fi
  context+=$'\n'

  # Port state
  local ppid
  ppid=$(port_owner_pid || echo "none")
  context+="=== PORT ${PORT} ==="$'\n'
  context+="Port owner PID: ${ppid}"$'\n'
  if [[ "$ppid" != "none" ]]; then
    context+="Port owner cmd: $(pid_cmdline "$ppid" 2>/dev/null || echo unknown)"$'\n'
  fi
  context+=$'\n'

  # Lock state
  local holders
  holders=$(lock_holder_pids || echo "none")
  context+="=== LOCK ==="$'\n'
  context+="Lock holders: ${holders}"$'\n'
  context+=$'\n'

  # Recent logs
  context+="=== LAST 60 LINES STDOUT ==="$'\n'
  context+="$(tail -60 "$HOMER_DIR/logs/stdout.log" 2>/dev/null || echo '(empty)')"$'\n'
  context+=$'\n'

  context+="=== LAST 30 LINES STDERR ==="$'\n'
  context+="$(tail -30 "$HOMER_DIR/logs/stderr.log" 2>/dev/null || echo '(empty)')"$'\n'
  context+=$'\n'

  context+="=== FATAL LOG (last 20 lines) ==="$'\n'
  context+="$(tail -20 "$STATE_DIR/fatal.log" 2>/dev/null || echo '(empty)')"$'\n'
  context+=$'\n'

  context+="=== PROCESSES ==="$'\n'
  context+="$(ps aux | grep -E "homer|node" | grep -v grep | head -15)"$'\n'

  echo "$context"
}

run_cc_triage() {
  local crash_context="$1"
  local failure_count="$2"

  local prompt
  prompt="You are triaging a Homer daemon health failure. The watchdog detected ${failure_count} consecutive health check failures.

CONTEXT:
${crash_context}

You must decide ONE action. Return ONLY a raw JSON object (no markdown fences, no explanation):

{\"action\": \"restart\", \"reason\": \"1-2 sentence explanation\", \"wait_seconds\": 5}

Valid actions:
- \"restart\" — Gentle restart via launchctl kickstart. Use when daemon is likely hung or crashed cleanly.
- \"force_kill\" — Kill ALL homer/node processes (SIGKILL), free port, clean locks, then restart. Use when processes are stuck, port is held by stale process, or gentle restart already failed.
- \"fix\" — You identified a clear code bug. You will get a follow-up call with edit permissions to fix it. Only use if the logs show a repeating code-level error (not transient).
- \"escalate\" — Cannot determine root cause or not confident. Dumps diagnostics for human review.

Rules:
- If launchd PID is \"none\" and port is free → prefer \"restart\" (daemon just died)
- If port is held by a stale process → prefer \"force_kill\"
- If lock holders exist but daemon PID is gone → prefer \"force_kill\"
- If ${failure_count} >= 5 → prefer \"escalate\" unless fix is obvious
- If same error pattern appeared in previous crashes → prefer \"fix\" or \"escalate\"
- wait_seconds: 0-60, how long to wait before executing the action"

  local result
  result=$(run_with_timeout "$TRIAGE_TIMEOUT" "$CLAUDE_BIN" -p "$prompt" --output-format text 2>/dev/null) || true
  echo "$result"
}

parse_json_field() {
  local json="$1"
  local field="$2"
  echo "$json" | /usr/bin/python3 -c "
import sys, json, re
raw = sys.stdin.read()
# Try to extract JSON object from response
m = re.search(r'\{[^{}]*\}', raw, re.DOTALL)
if m:
    try:
        d = json.loads(m.group())
        print(d.get('$field', ''))
    except: pass
" 2>/dev/null || true
}

execute_triage() {
  local failure_count="$1"

  if ! command -v "$CLAUDE_BIN" &>/dev/null; then
    log "TRIAGE: claude binary not found at ${CLAUDE_BIN}, defaulting to gentle restart"
    action_restart
    return
  fi

  if ! can_attempt_fix; then
    log "QUARANTINE: daily fix limit reached (${DAILY_FIX_LIMIT}), escalating"
    action_escalate "Daily fix limit reached (${DAILY_FIX_LIMIT} attempts)"
    /bin/sleep 300
    return
  fi

  # Gather context
  local context
  context=$(gather_crash_context "$failure_count")

  # Save crash report
  local report_file="$CRASH_REPORTS_DIR/$(/bin/date +%Y%m%d-%H%M%S).txt"
  echo "$context" > "$report_file"
  log "TRIAGE: crash context saved to ${report_file}"

  # Call Claude Code
  log "TRIAGE: calling Claude Code for decision..."
  local cc_output
  cc_output=$(run_cc_triage "$context" "$failure_count")

  # Parse response
  local action reason wait_s
  action=$(parse_json_field "$cc_output" "action")
  reason=$(parse_json_field "$cc_output" "reason")
  wait_s=$(parse_json_field "$cc_output" "wait_seconds")

  # Validate
  case "$action" in
    restart|force_kill|fix|escalate) ;;
    *)
      log "TRIAGE: invalid action '${action}' from CC, defaulting to restart"
      action="restart"
      reason="CC returned unparseable response"
      ;;
  esac

  # Clamp wait
  if [[ -z "$wait_s" ]] || ! [[ "$wait_s" =~ ^[0-9]+$ ]] || (( wait_s > 60 )); then
    wait_s=5
  fi

  # Save CC decision
  {
    echo ""
    echo "=== CC TRIAGE DECISION ==="
    echo "Action: ${action}"
    echo "Reason: ${reason}"
    echo "Wait: ${wait_s}s"
    echo "Raw output:"
    echo "$cc_output"
  } >> "$report_file"

  log "TRIAGE: action=${action} reason='${reason}' wait=${wait_s}s"
  increment_fix_count

  # Execute decision
  if (( wait_s > 0 )); then
    log "TRIAGE: waiting ${wait_s}s before action..."
    /bin/sleep "$wait_s"
  fi

  case "$action" in
    restart)
      action_restart || log "TRIAGE: gentle restart failed"
      ;;
    force_kill)
      action_force_kill || log "TRIAGE: force kill + restart failed"
      ;;
    fix)
      log "TRIAGE: running CC fix with edit permissions..."
      local fix_output
      fix_output=$(run_with_timeout "$FIX_TIMEOUT" "$CLAUDE_BIN" -p \
        "Fix the following issue in the Homer daemon at ~/homer/. After fixing, run 'cd ~/homer && npm run build' to verify compilation.

${context}

CC triage reason: ${reason}

Only edit files in ~/homer/src/. Do NOT restart the daemon — the watchdog will handle that." \
        --allowedTools 'Edit,Read,Glob,Grep,Bash(npm run build)' 2>&1) || true

      echo "$fix_output" >> "$report_file"
      log "TRIAGE: fix attempt completed, restarting daemon..."
      action_restart || action_force_kill || log "TRIAGE: restart after fix failed"
      ;;
    escalate)
      action_escalate "$reason"
      /bin/sleep 120  # Long cooldown on escalation
      ;;
  esac
}

# ============================================
# Main loop
# ============================================

log "watchdog v2 started — interval=${INTERVAL}s, health_timeout=${HEALTH_TIMEOUT}s, failures_before_action=${FAILURES_BEFORE_ACTION}"

CONSECUTIVE_FAILURES=0
DISK_CHECK_COUNTER=0

while true; do
  if check_health; then
    # Health check passed
    if (( CONSECUTIVE_FAILURES > 0 )); then
      log "health recovered after ${CONSECUTIVE_FAILURES} failures"
      CONSECUTIVE_FAILURES=0
    fi

    # Periodic resource checks
    DISK_CHECK_COUNTER=$((DISK_CHECK_COUNTER + 1))
    if (( DISK_CHECK_COUNTER >= DISK_CHECK_INTERVAL )); then
      DISK_CHECK_COUNTER=0
      check_disk_space || true
      check_memory || true
    fi

    # Periodic OK log (every 2 checks = ~1h at 30min interval)
    COUNT=$(state_get "health_ok_count" || echo 0)
    COUNT=$((COUNT + 1))
    if (( COUNT >= 2 )); then
      log "health ok (2 consecutive checks)"
      COUNT=0
    fi
    state_set "health_ok_count" "$COUNT"
    /bin/sleep "$INTERVAL"
    continue
  fi

  # Health check failed
  CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
  state_set "health_ok_count" "0"

  log "health failed (failure #${CONSECUTIVE_FAILURES}/${FAILURES_BEFORE_ACTION})"

  # Wait for consecutive failures before taking action
  if (( CONSECUTIVE_FAILURES < FAILURES_BEFORE_ACTION )); then
    /bin/sleep "$INTERVAL"
    continue
  fi

  # Threshold reached — triage via Claude Code
  log "threshold reached (${CONSECUTIVE_FAILURES} failures), starting triage"
  execute_triage "$CONSECUTIVE_FAILURES"

  /bin/sleep "$TRIAGE_COOLDOWN"
done
