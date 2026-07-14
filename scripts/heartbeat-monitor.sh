#!/bin/bash
#
# HOMER Heartbeat Monitor -- Layer 1 (Fast Recovery)
#
# Detects daemon absence within 20s, restarts via kickstart -k.
# Pure bash, no AI. Coordinates with watchdog via shared state.
#
# launchd: com.homer.heartbeat (StartInterval=20)
#

set -u
set -o pipefail

# --- Configuration ---
HOMER_LABEL="${HOMER_LABEL:-com.homer.daemon}"
LAUNCHD_DOMAIN="${LAUNCHD_DOMAIN:-gui/$(/usr/bin/id -u)}"
LAUNCHD_TARGET="${LAUNCHD_DOMAIN}/${HOMER_LABEL}"
DAEMON_PLIST="${DAEMON_PLIST:-$HOME/Library/LaunchAgents/com.homer.daemon.plist}"
HOMER_ROOT="${HOMER_ROOT:-$HOME/homer}"
ASSERT_BUILD_FRESH="${ASSERT_BUILD_FRESH:-$HOMER_ROOT/scripts/assert-build-fresh.sh}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"
PORT="${PORT:-3000}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-2}"
VERIFY_RETRIES="${VERIFY_RETRIES:-6}"
VERIFY_SLEEP="${VERIFY_SLEEP:-2}"
MIN_RESTART_GAP="${MIN_RESTART_GAP:-45}"

# Circuit breaker: max restarts before backing off to let watchdog handle it
MAX_RESTARTS_WINDOW="${MAX_RESTARTS_WINDOW:-3}"
RESTART_WINDOW_SECS="${RESTART_WINDOW_SECS:-300}"
CIRCUIT_BREAKER_COOLDOWN="${CIRCUIT_BREAKER_COOLDOWN:-300}"

APP_SUPPORT_DIR="${APP_SUPPORT_DIR:-$HOME/Library/Application Support/Homer}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/homer}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/heartbeat.log}"
LOCK_DIR="${LOCK_DIR:-$APP_SUPPORT_DIR/heartbeat.lockdir}"
STATE_FILE="${STATE_FILE:-$APP_SUPPORT_DIR/heartbeat-state.json}"
RESTART_REQUEST="${RESTART_REQUEST:-$APP_SUPPORT_DIR/restart.request}"
DB_PATH="${DB_PATH:-$HOME/homer/data/homer.db}"

mkdir -p "$APP_SUPPORT_DIR" "$LOG_DIR"

# --- Logging ---
log() {
  local ts
  ts="$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "${ts} $*" >> "$LOG_FILE"
}

# --- Lock (mkdir-based, atomic on APFS) ---
if ! /bin/mkdir "$LOCK_DIR" 2>/dev/null; then
  # Check for stale lock (owner dead or lock older than 120s)
  if [[ -f "$LOCK_DIR/pid" ]]; then
    owner_pid=$(/bin/cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
    if [[ -n "$owner_pid" ]] && ! /bin/kill -0 "$owner_pid" 2>/dev/null; then
      /bin/rm -rf "$LOCK_DIR"
      /bin/mkdir "$LOCK_DIR" 2>/dev/null || exit 0
    else
      exit 0
    fi
  else
    exit 0
  fi
fi
echo "$$" > "$LOCK_DIR/pid"
trap '/bin/rm -rf "$LOCK_DIR"' EXIT

# --- Helpers ---
now_epoch() { /bin/date +%s; }

service_loaded() {
  /bin/launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1
}

service_pid() {
  /bin/launchctl print "$LAUNCHD_TARGET" 2>/dev/null | /usr/bin/awk '/pid =/ {print $3; exit}'
}

health_ok() {
  local payload
  payload=$(/usr/bin/curl -fsS --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" 2>/dev/null) || return 1
  [[ -n "$payload" ]] || return 1
  echo "$payload" | /usr/bin/grep -Eq '"status"[[:space:]]*:[[:space:]]*"(healthy|degraded)"'
}

active_cli_runs() {
  # Escape hatch: force-restart file bypasses safety checks (for DB corruption)
  if [[ -f "$APP_SUPPORT_DIR/force-restart" ]]; then
    log "FORCE_RESTART detected; bypassing safety checks"
    /bin/rm -f "$APP_SUPPORT_DIR/force-restart"
    echo 0
    return
  fi
  if [[ ! -f "$DB_PATH" ]]; then
    echo 999  # fail closed: assume runs exist if DB missing
    return
  fi
  /usr/bin/sqlite3 "$DB_PATH" \
    "SELECT COUNT(*) FROM cli_runs WHERE status = 'running' AND started_at > (CAST(strftime('%s','now','-2 hours') AS INTEGER) * 1000);" \
    2>/dev/null || echo 999  # fail closed on query error
}

assert_build_fresh() {
  if [[ ! -f "$ASSERT_BUILD_FRESH" ]]; then
    log "restart request deferred; freshness gate missing: $ASSERT_BUILD_FRESH"
    return 1
  fi
  if ! /bin/bash "$ASSERT_BUILD_FRESH" >> "$LOG_FILE" 2>&1; then
    log "restart request deferred; build freshness check failed"
    return 1
  fi
  return 0
}

# --- State management (atomic JSON via temp+mv) ---
read_state_field() {
  local field="$1"
  [[ -f "$STATE_FILE" ]] || { echo ""; return; }
  /usr/bin/python3 -c "
import json, sys
try:
  with open(sys.argv[1]) as f: d = json.load(f)
  v = d.get(sys.argv[2], '')
  print(v if not isinstance(v, list) else json.dumps(v))
except: print('')
" "$STATE_FILE" "$field" 2>/dev/null || echo ""
}

write_state() {
  local tmp="${STATE_FILE}.tmp.$$"
  /usr/bin/python3 -c "
import json, os, sys, time
state = {}
if os.path.exists(sys.argv[1]):
  try:
    with open(sys.argv[1]) as f: state = json.load(f)
  except: pass
# Update from env
for k in ('restart_timestamps', 'circuit_breaker_until', 'last_restart_epoch'):
  v = os.environ.get('HB_' + k.upper(), '')
  if v:
    if k == 'restart_timestamps':
      state[k] = json.loads(v)
    else:
      state[k] = int(v) if v.isdigit() else v
with open(sys.argv[2], 'w') as f:
  json.dump(state, f, indent=2)
  f.write('\n')
os.replace(sys.argv[2], sys.argv[1])
" "$STATE_FILE" "$tmp" 2>/dev/null || /bin/rm -f "$tmp"
}

# Record a lease on every invocation. This makes a missing or broken launchd
# schedule observable even when Homer itself is healthy and no restart occurs.
record_check() {
  local status="${1:-checking}"
  local tmp="${STATE_FILE}.tmp.$$"
  /usr/bin/python3 -c "
import json, os, sys, time
state = {}
if os.path.exists(sys.argv[1]):
  try:
    with open(sys.argv[1]) as f: state = json.load(f)
  except Exception: pass
state['last_check_epoch'] = int(time.time())
state['last_status'] = sys.argv[3]
with open(sys.argv[2], 'w') as f:
  json.dump(state, f, indent=2)
  f.write('\\n')
os.replace(sys.argv[2], sys.argv[1])
" "$STATE_FILE" "$tmp" "$status" 2>/dev/null || /bin/rm -f "$tmp"
}

# --- Circuit breaker ---
restart_allowed() {
  local now last_restart cb_until
  now="$(now_epoch)"

  # Check circuit breaker cooldown
  cb_until="$(read_state_field circuit_breaker_until)"
  if [[ -n "$cb_until" && "$cb_until" =~ ^[0-9]+$ ]] && (( now < cb_until )); then
    log "circuit breaker active until $(/bin/date -r "$cb_until" -u +%H:%M:%SZ 2>/dev/null || echo "$cb_until")"
    return 1
  fi

  # Check min gap between restarts
  last_restart="$(read_state_field last_restart_epoch)"
  if [[ -n "$last_restart" && "$last_restart" =~ ^[0-9]+$ ]] && (( now - last_restart < MIN_RESTART_GAP )); then
    return 1
  fi

  return 0
}

record_restart() {
  local now timestamps_json window_start count
  now="$(now_epoch)"
  window_start=$((now - RESTART_WINDOW_SECS))

  # Read existing timestamps, prune old ones, append new
  timestamps_json="$(read_state_field restart_timestamps)"
  [[ -z "$timestamps_json" || "$timestamps_json" == "[]" ]] && timestamps_json="[]"

  # Prune and count via python (reliable JSON handling)
  local result
  result=$(/usr/bin/python3 -c "
import json, sys
ts = json.loads(sys.argv[1])
now = int(sys.argv[2])
window = int(sys.argv[3])
ts = [t for t in ts if t > window]
ts.append(now)
print(json.dumps(ts))
print(len(ts))
" "$timestamps_json" "$now" "$window_start" 2>/dev/null)

  local new_timestamps new_count
  new_timestamps="$(echo "$result" | head -1)"
  new_count="$(echo "$result" | tail -1)"

  # Trip circuit breaker if too many restarts in window
  local cb_until=""
  if (( new_count >= MAX_RESTARTS_WINDOW )); then
    cb_until=$((now + CIRCUIT_BREAKER_COOLDOWN))
    log "CIRCUIT BREAKER tripped: ${new_count} restarts in ${RESTART_WINDOW_SECS}s, cooling down ${CIRCUIT_BREAKER_COOLDOWN}s"
  fi

  export HB_RESTART_TIMESTAMPS="$new_timestamps"
  export HB_LAST_RESTART_EPOCH="$now"
  [[ -n "$cb_until" ]] && export HB_CIRCUIT_BREAKER_UNTIL="$cb_until"
  write_state
}

# --- Recovery actions ---
bootstrap_if_needed() {
  if service_loaded; then
    return 0
  fi
  if [[ ! -f "$DAEMON_PLIST" ]]; then
    log "ERROR: daemon plist missing: $DAEMON_PLIST"
    return 1
  fi
  log "daemon label not loaded; bootstrapping"
  /bin/launchctl bootstrap "$LAUNCHD_DOMAIN" "$DAEMON_PLIST" >/dev/null 2>&1 || true
  service_loaded
}

verify_recovery() {
  local i
  for (( i=1; i<=VERIFY_RETRIES; i++ )); do
    if health_ok; then
      return 0
    fi
    /bin/sleep "$VERIFY_SLEEP"
  done
  return 1
}

kickstart_daemon() {
  record_restart
  log "kickstart $LAUNCHD_TARGET"
  /bin/launchctl kickstart -k "$LAUNCHD_TARGET" >/dev/null 2>&1 || \
  /bin/launchctl start "$HOMER_LABEL" >/dev/null 2>&1 || \
  return 1
  verify_recovery
}

# --- Planned restart (via restart.request file) ---
handle_planned_restart() {
  if [[ ! -f "$RESTART_REQUEST" ]]; then
    return 1
  fi

  # Healthy daemon + restart request = planned restart (the normal case)
  # Proceed with CLI safety check, then restart

  local active
  active="$(active_cli_runs)"
  [[ "$active" =~ ^[0-9]+$ ]] || active=999

  if (( active > 0 )); then
    log "restart request deferred; ${active} active cli run(s)"
    return 0
  fi

  if ! restart_allowed; then
    log "restart request deferred by cooldown/circuit-breaker"
    return 0
  fi

  if ! assert_build_fresh; then
    return 0
  fi

  bootstrap_if_needed || return 1
  if kickstart_daemon; then
    log "planned restart completed"
    /bin/rm -f "$RESTART_REQUEST"
    return 0
  fi

  log "planned restart failed; request file kept"
  return 1
}

# --- Main ---
main() {
  record_check "checking"

  # Handle planned restarts first
  if handle_planned_restart; then
    record_check "planned-restart-handled"
    exit 0
  fi

  # Health check
  if health_ok; then
    record_check "healthy"
    exit 0
  fi

  # Check if daemon is draining (graceful shutdown in progress)
  DRAIN_SENTINEL="$APP_SUPPORT_DIR/daemon.draining"
  DRAIN_MAX_AGE_SECS=360  # 6 minutes (270s drain + 90s margin)
  if [[ -f "$DRAIN_SENTINEL" ]]; then
    sentinel_age=$(($(date +%s) - $(stat -f%m "$DRAIN_SENTINEL")))
    if (( sentinel_age > DRAIN_MAX_AGE_SECS )); then
      log "stale drain sentinel detected (age=${sentinel_age}s); removing"
      /bin/rm -f "$DRAIN_SENTINEL"
    else
      log "daemon is draining (age=${sentinel_age}s); suppressing restart"
      record_check "daemon-draining"
      exit 0
    fi
  fi

  # Not healthy -- can we restart?
  if ! restart_allowed; then
    log "health failed but restart suppressed (cooldown/circuit-breaker)"
    exit 1
  fi

  local pid
  pid="$(service_pid || true)"
  log "health failed; pid=${pid:-none}; loaded=$(service_loaded && echo yes || echo no)"

  # CLI safety check before emergency restart
  local active
  active="$(active_cli_runs)"
  if [[ "$active" =~ ^[0-9]+$ ]] && (( active > 0 )); then
    log "emergency restart deferred; ${active} active cli run(s)"
    exit 1
  fi

  bootstrap_if_needed || {
    log "bootstrap failed"
    exit 1
  }

  if kickstart_daemon; then
    log "emergency restart succeeded"
    record_check "emergency-restart-succeeded"
    exit 0
  fi

  log "emergency restart failed; deferring to watchdog"
  record_check "emergency-restart-failed"
  exit 1
}

main "$@"
