#!/usr/bin/env bash
#
# HOMER Watchdog Script v3
#
# Outer supervisor only:
# - polls health
# - gathers process and log context
# - executes launchd and shell repairs
# - delegates classification and budget policy to dist/watchdog/policy.js
#

set -u
set -o pipefail

HOMER_LABEL="${HOMER_LABEL:-com.homer.daemon}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/health}"
PORT="${PORT:-3000}"
LOCK_FILE="${LOCK_FILE:-$HOME/Library/Application Support/Homer/homer.lock}"
LOCK_OWNER_PATTERN="${LOCK_OWNER_PATTERN:-homer|claude|node}"
EXPECTED_NODE_PATH="${EXPECTED_NODE_PATH:-/opt/homebrew/bin/node}"
WATCHDOG_NODE_BIN="${WATCHDOG_NODE_BIN:-$EXPECTED_NODE_PATH}"

INTERVAL="${INTERVAL:-1800}"
MIN_DAEMON_AGE_SECS="${MIN_DAEMON_AGE_SECS:-7200}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-15}"
FAILURES_BEFORE_ACTION="${FAILURES_BEFORE_ACTION:-2}"
TRIAGE_COOLDOWN="${TRIAGE_COOLDOWN:-300}"
HEALTH_RETRY_DELAY="${HEALTH_RETRY_DELAY:-10}"
POST_ACTION_WAIT="${POST_ACTION_WAIT:-10}"

DISK_SPACE_MIN="${DISK_SPACE_MIN:-10}"
MEMORY_LIMIT_MB="${MEMORY_LIMIT_MB:-1024}"
DISK_CHECK_INTERVAL="${DISK_CHECK_INTERVAL:-1}"
DISK_EMERGENCY_THRESHOLD="${DISK_EMERGENCY_THRESHOLD:-5}"

CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null || echo "$HOME/.claude/local/claude")}"
CODEX_BIN="${CODEX_BIN:-$(command -v codex 2>/dev/null || echo "/opt/homebrew/bin/codex")}"
RECOVERY_AGENT="${RECOVERY_AGENT:-claude}"
TRIAGE_TIMEOUT="${TRIAGE_TIMEOUT:-120}"
FIX_TIMEOUT="${FIX_TIMEOUT:-180}"
DB_PATH="${DB_PATH:-$HOME/homer/data/homer.db}"

HOMER_DIR="${HOMER_DIR:-$HOME/homer}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/homer}"
APP_SUPPORT_DIR="${APP_SUPPORT_DIR:-$HOME/Library/Application Support/Homer}"
STATE_FILE="${STATE_FILE:-$APP_SUPPORT_DIR/watchdog-state.json}"
CRASH_REPORTS_DIR="${CRASH_REPORTS_DIR:-$LOG_DIR/crash-reports}"
EVENT_LOG="${EVENT_LOG:-$LOG_DIR/watchdog-events.jsonl}"
EVENT_LOG_MAX_BYTES="${EVENT_LOG_MAX_BYTES:-1048576}"
WATCHDOG_POLICY_JS="${WATCHDOG_POLICY_JS:-$HOMER_DIR/dist/watchdog/policy.js}"
FATAL_LOG="${FATAL_LOG:-$LOG_DIR/fatal.log}"

DOCKER_COMPOSE_DIR="${DOCKER_COMPOSE_DIR:-$HOME/ai-portfolio}"
DOCKER_HEALTH_URL="${DOCKER_HEALTH_URL:-http://localhost:8100/health}"
DOCKER_HEALTH_TIMEOUT=10
DOCKER_POST_RESTART_WAIT=15
DOCKER_POST_DAEMON_WAIT=40

mkdir -p "$LOG_DIR" "$APP_SUPPORT_DIR" "$CRASH_REPORTS_DIR"

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

log() {
  local ts
  ts=$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "${ts} $*" | tee -a "$LOG_DIR/watchdog.log"
}

send_telegram() {
  local message="$1"
  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
    log "TELEGRAM: no credentials, skipping notification"
    return 0
  fi
  /usr/bin/curl -fsS --max-time 10 \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT_ID}" \
    -d parse_mode="Markdown" \
    --data-urlencode "text=${message}" >/dev/null 2>&1 || \
    log "TELEGRAM: failed to send notification"
}

rotate_event_log() {
  if [[ -f "$EVENT_LOG" ]]; then
    local size
    size=$(stat -f%z "$EVENT_LOG" 2>/dev/null || echo 0)
    if (( size >= EVENT_LOG_MAX_BYTES )); then
      /bin/mv -f "$EVENT_LOG" "${EVENT_LOG}.1"
    fi
  fi
}

json_field() {
  local file="$1"
  local field="$2"
  /usr/bin/python3 - "$file" "$field" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    value = json.load(handle)

for part in sys.argv[2].split("."):
    if isinstance(value, dict):
        value = value.get(part)
    else:
        value = None
        break

if value is None:
    print("")
elif isinstance(value, bool):
    print("true" if value else "false")
elif isinstance(value, (dict, list)):
    print(json.dumps(value, separators=(",", ":")))
else:
    print(value)
PY
}

detect_launchd_domain() {
  if [[ -n "${LAUNCHD_DOMAIN:-}" ]]; then
    echo "$LAUNCHD_DOMAIN"
    return
  fi
  if /bin/launchctl print "system/${HOMER_LABEL}" >/dev/null 2>&1; then
    echo "system"
    return
  fi
  local gui_domain="gui/$(/usr/bin/id -u)"
  if /bin/launchctl print "${gui_domain}/${HOMER_LABEL}" >/dev/null 2>&1; then
    echo "$gui_domain"
    return
  fi
  echo "$gui_domain"
}

LAUNCHD_DOMAIN="$(detect_launchd_domain)"
LAUNCHD_TARGET="${LAUNCHD_DOMAIN}/${HOMER_LABEL}"

installed_plist_path() {
  if [[ "$LAUNCHD_DOMAIN" == system ]]; then
    echo "/Library/LaunchDaemons/${HOMER_LABEL}.plist"
    return
  fi
  echo "$HOME/Library/LaunchAgents/${HOMER_LABEL}.plist"
}

canonical_plist_source() {
  if [[ "$LAUNCHD_DOMAIN" == system ]]; then
    echo "$HOMER_DIR/config/${HOMER_LABEL}.plist"
    return
  fi
  echo "$HOMER_DIR/scripts/macos/${HOMER_LABEL}.plist"
}

check_health() {
  local payload status
  payload=$(/usr/bin/curl -fsS --max-time "$HEALTH_TIMEOUT" "$HEALTH_URL" 2>/dev/null) || return 1
  [[ -n "$payload" ]] || return 1
  status=$(echo "$payload" | /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null) || return 1
  [[ "$status" =~ ^(healthy|degraded)$ ]]
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
    rm -f "$HOMER_DIR/logs/"*.log.[0-9]* 2>/dev/null || true
    rm -f "$HOMER_DIR/logs/"*.log.*.bz2 2>/dev/null || true
    ls -t "$CRASH_REPORTS_DIR/"*.txt 2>/dev/null | tail -n +20 | xargs rm -f 2>/dev/null || true
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

get_launchd_pid() {
  /bin/launchctl print "$LAUNCHD_TARGET" 2>/dev/null | /usr/bin/awk '/pid =/ {print $3; exit}'
}

get_launchd_print() {
  /bin/launchctl print "$LAUNCHD_TARGET" 2>/dev/null || true
}

port_owner_pid() {
  /usr/sbin/lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null | /usr/bin/awk 'NR==2 {print $2; exit}'
}

pid_cmdline() {
  /bin/ps -o command= -p "$1" 2>/dev/null
}

daemon_too_young() {
  # Returns 0 (true) if the daemon process has been running for less than MIN_DAEMON_AGE_SECS
  local pid
  pid=$(get_launchd_pid || true)
  if [[ -z "$pid" ]]; then
    return 1  # no daemon running — not "too young"
  fi
  # Get process start time (epoch) via ps -o lstart=, then compute age
  local start_epoch now_epoch age_secs
  start_epoch=$(/bin/ps -o lstart= -p "$pid" 2>/dev/null | xargs -I{} /bin/date -jf "%c" "{}" +%s 2>/dev/null) || return 1
  now_epoch=$(/bin/date +%s)
  age_secs=$(( now_epoch - start_epoch ))
  if (( age_secs < MIN_DAEMON_AGE_SECS )); then
    log "SAFETY: daemon pid=$pid is only ${age_secs}s old (min ${MIN_DAEMON_AGE_SECS}s); skipping destructive action"
    return 0  # too young
  fi
  return 1  # old enough
}

lock_holder_pids() {
  /usr/sbin/lsof -n -t -- "$LOCK_FILE" 2>/dev/null | /usr/bin/sort -u
}

lock_holder_rows() {
  local holders holder cmdline
  holders=$(lock_holder_pids || true)
  if [[ -z "$holders" ]]; then
    return
  fi
  for holder in $holders; do
    cmdline=$(pid_cmdline "$holder")
    printf '%s\t%s\n' "$holder" "$cmdline"
  done
}

has_active_runs() {
  # Escape hatch: force-restart file bypasses safety checks
  if [[ -f "$APP_SUPPORT_DIR/force-restart" ]]; then
    log "FORCE_RESTART detected; bypassing active-run safety check"
    /bin/rm -f "$APP_SUPPORT_DIR/force-restart"
    return 1  # false = no active runs
  fi
  local db="$HOME/homer/data/homer.db"
  if ! command -v sqlite3 >/dev/null 2>&1 || [[ ! -f "$db" ]]; then
    return 0  # fail closed: assume runs exist if can't check
  fi
  local count
  count=$(sqlite3 "$db" \
    "SELECT COUNT(*) FROM cli_runs WHERE status = 'running' AND started_at > (CAST(strftime('%s','now','-2 hours') AS INTEGER) * 1000);" \
    2>/dev/null || echo "999")
  [[ "$count" =~ ^[0-9]+$ ]] || count=999
  (( count > 0 ))
}

write_context_json() {
  local output_file="$1"
  local failure_count="$2"
  local health_timed_out="$3"
  local launchd_pid port_pid port_cmd stdout_tail stderr_tail fatal_tail launchd_print process_snapshot lock_rows ts

  ts=$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")
  launchd_pid=$(get_launchd_pid || true)
  port_pid=$(port_owner_pid || true)
  port_cmd=""
  if [[ -n "$port_pid" ]]; then
    port_cmd=$(pid_cmdline "$port_pid")
  fi
  stdout_tail=$(tail -80 "$HOMER_DIR/logs/stdout.log" 2>/dev/null || true)
  stderr_tail=$(tail -40 "$HOMER_DIR/logs/stderr.log" 2>/dev/null || true)
  fatal_tail=$(tail -30 "$FATAL_LOG" 2>/dev/null || true)
  launchd_print=$(get_launchd_print)
  process_snapshot=$(ps aux | grep -E "homer|claude|node" | grep -v grep | head -20 || true)
  lock_rows=$(lock_holder_rows || true)

  WD_TIMESTAMP="$ts" \
  WD_FAILURE_COUNT="$failure_count" \
  WD_HEALTH_URL="$HEALTH_URL" \
  WD_PORT="$PORT" \
  WD_EXPECTED_NODE_PATH="$EXPECTED_NODE_PATH" \
  WD_LAUNCHD_DOMAIN="$LAUNCHD_DOMAIN" \
  WD_HOMER_LABEL="$HOMER_LABEL" \
  WD_LAUNCHD_PID="${launchd_pid:-}" \
  WD_PORT_OWNER_PID="${port_pid:-}" \
  WD_PORT_OWNER_COMMAND="$port_cmd" \
  WD_LOCK_FILE="$LOCK_FILE" \
  WD_LOCK_ROWS="$lock_rows" \
  WD_LAUNCHD_PRINT="$launchd_print" \
  WD_RECENT_STDOUT="$stdout_tail" \
  WD_RECENT_STDERR="$stderr_tail" \
  WD_RECENT_FATAL="$fatal_tail" \
  WD_PROCESS_SNAPSHOT="$process_snapshot" \
  WD_HEALTH_TIMED_OUT="$health_timed_out" \
  /usr/bin/python3 - "$output_file" <<'PY'
import json
import os
import sys

def parse_int(name):
    value = os.environ.get(name, "").strip()
    return int(value) if value else None

lock_holders = []
for row in os.environ.get("WD_LOCK_ROWS", "").splitlines():
    if not row.strip():
      continue
    pid, _, command = row.partition("\t")
    try:
      lock_holders.append({"pid": int(pid), "command": command})
    except ValueError:
      continue

payload = {
    "timestamp": os.environ["WD_TIMESTAMP"],
    "failureCount": int(os.environ["WD_FAILURE_COUNT"]),
    "healthUrl": os.environ["WD_HEALTH_URL"],
    "port": int(os.environ["WD_PORT"]),
    "expectedNodePath": os.environ["WD_EXPECTED_NODE_PATH"],
    "launchdDomain": os.environ["WD_LAUNCHD_DOMAIN"],
    "homerLabel": os.environ["WD_HOMER_LABEL"],
    "launchdPid": parse_int("WD_LAUNCHD_PID"),
    "portOwnerPid": parse_int("WD_PORT_OWNER_PID"),
    "portOwnerCommand": os.environ.get("WD_PORT_OWNER_COMMAND") or None,
    "lockFile": os.environ["WD_LOCK_FILE"],
    "lockHolders": lock_holders,
    "launchdPrint": os.environ.get("WD_LAUNCHD_PRINT", ""),
    "recentStdout": os.environ.get("WD_RECENT_STDOUT", ""),
    "recentStderr": os.environ.get("WD_RECENT_STDERR", ""),
    "recentFatalLog": os.environ.get("WD_RECENT_FATAL", ""),
    "processSnapshot": os.environ.get("WD_PROCESS_SNAPSHOT", ""),
    "healthTimedOut": os.environ.get("WD_HEALTH_TIMED_OUT") == "1",
}

with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
PY
}

run_policy_decide() {
  local context_file="$1"
  local decision_file="$2"
  local llm_output_file="${3:-}"

  if [[ ! -x "$WATCHDOG_NODE_BIN" ]] && ! command -v "$WATCHDOG_NODE_BIN" >/dev/null 2>&1; then
    log "POLICY: node binary not available at $WATCHDOG_NODE_BIN"
    return 1
  fi
  if [[ ! -f "$WATCHDOG_POLICY_JS" ]]; then
    log "POLICY: missing helper at $WATCHDOG_POLICY_JS"
    return 1
  fi

  if [[ -n "$llm_output_file" ]]; then
    "$WATCHDOG_NODE_BIN" "$WATCHDOG_POLICY_JS" decide \
      --context-file "$context_file" \
      --state-file "$STATE_FILE" \
      --llm-output-file "$llm_output_file" > "$decision_file"
    return
  fi

  "$WATCHDOG_NODE_BIN" "$WATCHDOG_POLICY_JS" decide \
    --context-file "$context_file" \
    --state-file "$STATE_FILE" > "$decision_file"
}

run_policy_classify() {
  local context_file="$1"
  local output_file="$2"
  "$WATCHDOG_NODE_BIN" "$WATCHDOG_POLICY_JS" classify \
    --context-file "$context_file" > "$output_file"
}

record_policy_outcome() {
  local decision_file="$1"
  local outcome="$2"
  local executed="$3"
  local result_signature="${4:-}"
  local occurred_at
  occurred_at=$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")

  if [[ -n "$result_signature" ]]; then
    "$WATCHDOG_NODE_BIN" "$WATCHDOG_POLICY_JS" record-outcome \
      --state-file "$STATE_FILE" \
      --decision-file "$decision_file" \
      --outcome "$outcome" \
      --executed "$executed" \
      --occurred-at "$occurred_at" \
      --result-signature "$result_signature" >/dev/null
    return
  fi

  "$WATCHDOG_NODE_BIN" "$WATCHDOG_POLICY_JS" record-outcome \
    --state-file "$STATE_FILE" \
    --decision-file "$decision_file" \
    --outcome "$outcome" \
    --executed "$executed" \
    --occurred-at "$occurred_at" >/dev/null
}

dump_diagnostics() {
  local report_file="$CRASH_REPORTS_DIR/crash-$(/bin/date +%Y%m%d_%H%M%S).txt"
  {
    echo "=== Homer Watchdog Diagnostics $(/bin/date) ==="
    echo
    echo "Launchd target: $LAUNCHD_TARGET"
    echo "State file: $STATE_FILE"
    echo
    echo "=== launchctl ==="
    get_launchd_print
    echo
    echo "=== Port ${PORT} ==="
    /usr/sbin/lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null || echo "Port free"
    echo
    echo "=== Lock File ==="
    /usr/sbin/lsof -n -- "$LOCK_FILE" 2>/dev/null || echo "No lock holders"
    echo
    echo "=== Health Endpoint ==="
    /usr/bin/curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null | /usr/bin/python3 -m json.tool 2>/dev/null || echo "Health unavailable"
    echo
    echo "=== Recent stdout ==="
    tail -80 "$HOMER_DIR/logs/stdout.log" 2>/dev/null || true
    echo
    echo "=== Recent stderr ==="
    tail -40 "$HOMER_DIR/logs/stderr.log" 2>/dev/null || true
    echo
    echo "=== Fatal log ==="
    tail -30 "$FATAL_LOG" 2>/dev/null || true
    echo
    echo "=== Watchdog state ==="
    cat "$STATE_FILE" 2>/dev/null || echo "No state file"
  } > "$report_file"

  echo "$report_file"
}

ensure_launchd_loaded() {
  local plist_path
  plist_path="$(installed_plist_path)"
  if /bin/launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1; then
    return 0
  fi
  if [[ ! -f "$plist_path" ]]; then
    return 1
  fi
  /bin/launchctl bootstrap "$LAUNCHD_DOMAIN" "$plist_path" >/dev/null 2>&1
}

action_restart() {
  if daemon_too_young; then
    log "ACTION: restart skipped because daemon process is younger than ${MIN_DAEMON_AGE_SECS}s"
    return 10
  fi
  if has_active_runs; then
    log "ACTION: restart skipped because active CLI runs are still in progress"
    return 10
  fi
  log "ACTION: restart via launchctl for $LAUNCHD_TARGET"
  /bin/launchctl kickstart -k "$LAUNCHD_TARGET" >/dev/null 2>&1 && return 0
  ensure_launchd_loaded && /bin/launchctl kickstart -k "$LAUNCHD_TARGET" >/dev/null 2>&1 && return 0
  /bin/launchctl start "$HOMER_LABEL" >/dev/null 2>&1 && return 0
  return 1
}

action_force_kill() {
  if daemon_too_young; then
    log "ACTION: force-kill skipped because daemon process is younger than ${MIN_DAEMON_AGE_SECS}s"
    return 10
  fi
  if has_active_runs; then
    log "ACTION: force-kill skipped because active CLI runs are still in progress"
    return 10
  fi
  log "ACTION: force-kill Homer processes and restart"

  # Prefer targeted kill via launchd PID over broad pattern matching
  local launchd_pid
  launchd_pid=$(get_launchd_pid || true)
  if [[ -n "$launchd_pid" ]]; then
    log "ACTION: killing launchd-managed process pid=$launchd_pid"
    /bin/kill -9 "$launchd_pid" 2>/dev/null || true
  else
    # Fallback: pattern match only if launchd PID unavailable
    /usr/bin/pkill -9 -f "homer/dist/index.js" 2>/dev/null || true
  fi
  /bin/sleep 2

  # Clean up port holder if still bound
  local port_pid
  port_pid=$(/usr/sbin/lsof -ti:${PORT} 2>/dev/null || true)
  if [[ -n "$port_pid" ]]; then
    kill -9 "$port_pid" 2>/dev/null || true
  fi

  # Clean up stale lock holders (only if they match the daemon PID or homer pattern)
  local holders holder cmdline
  holders=$(lock_holder_pids || true)
  if [[ -n "$holders" ]]; then
    for holder in $holders; do
      cmdline=$(pid_cmdline "$holder")
      if echo "$cmdline" | /usr/bin/grep -Fq "homer/dist/index.js"; then
        /bin/kill -9 "$holder" 2>/dev/null || true
      fi
    done
  fi

  /bin/sleep 1
  /bin/launchctl kickstart -k "$LAUNCHD_TARGET" >/dev/null 2>&1 && return 0
  ensure_launchd_loaded && /bin/launchctl kickstart -k "$LAUNCHD_TARGET" >/dev/null 2>&1 && return 0
  return 1
}

repair_native_modules() {
  log "REPAIR: rebuilding native modules against $EXPECTED_NODE_PATH"
  local npm_bin
  npm_bin="$(dirname "$EXPECTED_NODE_PATH")/npm"
  [[ -x "$npm_bin" ]] || npm_bin="$(command -v npm 2>/dev/null || true)"
  [[ -n "$npm_bin" ]] || return 1

  (
    cd "$HOMER_DIR" &&
    "$npm_bin" rebuild fs-ext better-sqlite3
  ) || return 1

  "$EXPECTED_NODE_PATH" -e "require('fs-ext'); require('better-sqlite3');" >/dev/null 2>&1 || return 1
  action_restart
}

repair_launchd_runtime() {
  log "REPAIR: reinstalling launchd plist for $LAUNCHD_DOMAIN"
  local source_plist dest_plist
  source_plist="$(canonical_plist_source)"
  dest_plist="$(installed_plist_path)"

  [[ -f "$source_plist" ]] || return 1

  /bin/launchctl bootout "$LAUNCHD_TARGET" >/dev/null 2>&1 || true
  /bin/cp "$source_plist" "$dest_plist" || return 1

  if [[ "$LAUNCHD_DOMAIN" == system ]]; then
    /usr/sbin/chown root:wheel "$dest_plist" || return 1
    /bin/chmod 644 "$dest_plist" || return 1
  fi

  /bin/launchctl bootstrap "$LAUNCHD_DOMAIN" "$dest_plist" >/dev/null 2>&1 || return 1
  if ! /bin/launchctl print "$LAUNCHD_TARGET" 2>/dev/null | /usr/bin/grep -Fq "$EXPECTED_NODE_PATH"; then
    return 1
  fi

  action_restart
}

repair_stale_lock() {
  local launchd_pid holders
  launchd_pid=$(get_launchd_pid || true)
  holders=$(lock_holder_pids || true)

  if [[ -n "$launchd_pid" && -n "$holders" ]]; then
    for holder in $holders; do
      if [[ "$holder" == "$launchd_pid" ]]; then
        return 1
      fi
    done
  fi

  rm -f "$LOCK_FILE" || return 1
  action_restart
}

write_docker_context_json() {
  local output_file="$1"
  local daemon_running="$2"
  local ts
  ts=$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ")

  local backend_state="not_found"
  local backend_health="unknown"
  local http_status="null"

  if [[ "$daemon_running" == "true" ]]; then
    backend_state=$(docker inspect --format '{{.State.Status}}' portfolio-backend 2>/dev/null || echo "not_found")
    if [[ "$backend_state" == "running" ]]; then
      backend_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' portfolio-backend 2>/dev/null || echo "unknown")
      local code
      code=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time "$DOCKER_HEALTH_TIMEOUT" "$DOCKER_HEALTH_URL" 2>/dev/null || echo "0")
      http_status="$code"
    fi
  fi

  /usr/bin/python3 - "$output_file" "$ts" "$daemon_running" "$DOCKER_COMPOSE_DIR" \
    "$backend_state" "$backend_health" "$http_status" <<'PY'
import json
import sys

output_file = sys.argv[1]
ts = sys.argv[2]
daemon_running = sys.argv[3] == "true"
compose_dir = sys.argv[4]
backend_state = sys.argv[5]
backend_health = sys.argv[6]
http_status_str = sys.argv[7]
http_status = int(http_status_str) if http_status_str not in ("null", "") else None

payload = {
    "timestamp": ts,
    "failureCount": 1,
    "dockerDaemonRunning": daemon_running,
    "composeDir": compose_dir,
    "services": [
        {
            "name": "backend",
            "containerState": backend_state if backend_state in ("running", "stopped") else "not_found",
            "healthStatus": backend_health if backend_health in ("healthy", "unhealthy", "starting", "none") else "unknown",
            "httpStatus": http_status,
        }
    ],
}

with open(output_file, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
PY
}

repair_docker_daemon() {
  log "REPAIR: starting Docker Desktop"
  open -a Docker
  local elapsed=0
  while (( elapsed < DOCKER_POST_DAEMON_WAIT )); do
    /bin/sleep 5
    elapsed=$(( elapsed + 5 ))
    if docker info >/dev/null 2>&1; then
      log "REPAIR: Docker daemon is ready after ${elapsed}s"
      return 0
    fi
  done
  log "REPAIR: Docker daemon did not start within ${DOCKER_POST_DAEMON_WAIT}s"
  return 1
}

repair_docker_restart() {
  log "REPAIR: restarting Docker Compose backend service"
  (cd "$DOCKER_COMPOSE_DIR" && docker compose restart backend) || return 1
  /bin/sleep "$DOCKER_POST_RESTART_WAIT"
}

repair_docker_recreate() {
  log "REPAIR: recreating Docker Compose services"
  (cd "$DOCKER_COMPOSE_DIR" && docker compose down && docker compose up -d) || return 1
  /bin/sleep 20
}

repair_docker_health_wait() {
  log "REPAIR: waiting for Docker containers to stabilize"
  /bin/sleep 20
  local code
  code=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time "$DOCKER_HEALTH_TIMEOUT" "$DOCKER_HEALTH_URL" 2>/dev/null || echo "0")
  if [[ "$code" == "200" ]]; then
    return 0
  fi
  return 1
}

run_docker_policy_decide() {
  local context_file="$1"
  local decision_file="$2"

  if [[ ! -x "$WATCHDOG_NODE_BIN" ]] && ! command -v "$WATCHDOG_NODE_BIN" >/dev/null 2>&1; then
    log "DOCKER POLICY: node binary not available at $WATCHDOG_NODE_BIN"
    return 1
  fi
  if [[ ! -f "$WATCHDOG_POLICY_JS" ]]; then
    log "DOCKER POLICY: missing helper at $WATCHDOG_POLICY_JS"
    return 1
  fi

  "$WATCHDOG_NODE_BIN" "$WATCHDOG_POLICY_JS" docker-decide \
    --docker-context-file "$context_file" \
    --state-file "$STATE_FILE" > "$decision_file"
}

validate_docker_after_action() {
  /bin/sleep "$DOCKER_POST_RESTART_WAIT"

  if ! docker info >/dev/null 2>&1; then
    VALIDATION_OUTCOME="same_signature_recurred"
    VALIDATION_SIGNATURE="docker_daemon_down"
    return 0
  fi

  local code
  code=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time "$DOCKER_HEALTH_TIMEOUT" "$DOCKER_HEALTH_URL" 2>/dev/null || echo "0")
  if [[ "$code" == "200" ]]; then
    VALIDATION_OUTCOME="health_recovered"
    VALIDATION_SIGNATURE=""
    return 0
  fi

  local backend_state
  backend_state=$(docker inspect --format '{{.State.Status}}' portfolio-backend 2>/dev/null || echo "not_found")
  if [[ "$backend_state" != "running" ]]; then
    VALIDATION_OUTCOME="same_signature_recurred"
    VALIDATION_SIGNATURE="docker_container_stopped"
    return 0
  fi

  VALIDATION_OUTCOME="same_signature_recurred"
  VALIDATION_SIGNATURE="docker_container_unhealthy"
}

check_docker_health() {
  command -v docker >/dev/null 2>&1 || return 0

  local daemon_running=true
  docker info >/dev/null 2>&1 || daemon_running=false

  local need_action=false

  if [[ "$daemon_running" == "false" ]]; then
    need_action=true
  else
    local backend_state
    backend_state=$(docker inspect --format '{{.State.Status}}' portfolio-backend 2>/dev/null || echo "not_found")
    if [[ "$backend_state" != "running" ]]; then
      need_action=true
    else
      local code
      code=$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time "$DOCKER_HEALTH_TIMEOUT" "$DOCKER_HEALTH_URL" 2>/dev/null || echo "0")
      if [[ "$code" != "200" ]]; then
        need_action=true
      fi
    fi
  fi

  [[ "$need_action" == "true" ]] || return 0

  log "DOCKER: health check failed (daemon=$daemon_running)"

  local docker_context docker_decision
  docker_context="$(mktemp /tmp/homer-watchdog-docker-ctx.XXXXXX)"
  docker_decision="$(mktemp /tmp/homer-watchdog-docker-dec.XXXXXX)"

  write_docker_context_json "$docker_context" "$daemon_running"

  if ! run_docker_policy_decide "$docker_context" "$docker_decision"; then
    log "DOCKER: policy engine failed"
    rm -f "$docker_context" "$docker_decision"
    return 1
  fi

  local action signature reason repair_handler
  action=$(json_field "$docker_decision" "action")
  signature=$(json_field "$docker_decision" "signature")
  reason=$(json_field "$docker_decision" "reason")
  repair_handler=$(json_field "$docker_decision" "repairHandler")

  if [[ -z "$action" || "$action" == "null" ]]; then
    rm -f "$docker_context" "$docker_decision"
    return 0
  fi

  log "DOCKER: signature=$signature action=$action handler=$repair_handler"

  EXECUTED="true"
  VALIDATION_OUTCOME="validation_failed"
  VALIDATION_SIGNATURE=""

  if [[ "$action" == "escalate" ]]; then
    send_telegram "*Homer Watchdog: Docker Escalation*
Signature: \`${signature}\`
Reason: ${reason}"
    VALIDATION_OUTCOME="validation_failed"
  elif [[ "$action" == "repair" && -n "$repair_handler" && "$repair_handler" != "null" ]]; then
    send_telegram "*Homer Watchdog: Docker ${action}*
Signature: \`${signature}\`
Handler: \`${repair_handler}\`"
    execute_repair_handler "$repair_handler"
    local rc=$?
    if (( rc != 0 )); then
      VALIDATION_OUTCOME="validation_failed"
    else
      validate_docker_after_action
    fi
  fi

  record_policy_outcome "$docker_decision" "$VALIDATION_OUTCOME" "$EXECUTED" "$VALIDATION_SIGNATURE"
  append_event_log "$docker_decision" "$VALIDATION_OUTCOME" "" "$VALIDATION_SIGNATURE"

  rm -f "$docker_context" "$docker_decision"
}

execute_repair_handler() {
  local handler="$1"
  case "$handler" in
    repair_native_modules)
      repair_native_modules
      ;;
    repair_launchd_runtime)
      repair_launchd_runtime
      ;;
    repair_stale_lock)
      repair_stale_lock
      ;;
    repair_docker_daemon)
      repair_docker_daemon
      ;;
    repair_docker_restart)
      repair_docker_restart
      ;;
    repair_docker_recreate)
      repair_docker_recreate
      ;;
    repair_docker_health_wait)
      repair_docker_health_wait
      ;;
    *)
      return 1
      ;;
  esac
}

build_symptom_summary() {
  local context_file="$1"
  local launchd_pid port_pid health_timed_out lock_count failure_count
  launchd_pid=$(json_field "$context_file" "launchdPid")
  port_pid=$(json_field "$context_file" "portOwnerPid")
  health_timed_out=$(json_field "$context_file" "healthTimedOut")
  lock_count=$(json_field "$context_file" "lockHolders" | /usr/bin/python3 -c "import sys,json; print(len(json.loads(sys.stdin.read())))" 2>/dev/null || echo "?")
  failure_count=$(json_field "$context_file" "failureCount")

  local symptoms=""
  if [[ -z "$launchd_pid" || "$launchd_pid" == "null" ]]; then
    symptoms="${symptoms}- Daemon process is NOT running (no launchd PID)\n"
  else
    symptoms="${symptoms}- Daemon process IS running (PID ${launchd_pid})\n"
  fi
  if [[ -z "$port_pid" || "$port_pid" == "null" ]]; then
    symptoms="${symptoms}- Port ${PORT} is FREE (nobody listening)\n"
  elif [[ "$port_pid" == "$launchd_pid" ]]; then
    symptoms="${symptoms}- Port ${PORT} is held by the daemon (PID ${port_pid})\n"
  else
    symptoms="${symptoms}- Port ${PORT} is held by a DIFFERENT process (PID ${port_pid}, expected ${launchd_pid})\n"
  fi
  if [[ "$health_timed_out" == "true" ]]; then
    symptoms="${symptoms}- Health endpoint TIMED OUT (did not respond within ${HEALTH_TIMEOUT}s)\n"
  else
    symptoms="${symptoms}- Health endpoint returned an error or was unreachable\n"
  fi
  symptoms="${symptoms}- Lock holders: ${lock_count}\n"
  symptoms="${symptoms}- Consecutive health failures: ${failure_count}\n"
  echo -e "$symptoms"
}

run_claude_triage() {
  local context_file="$1"
  local llm_output_file="$2"

  if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
    log "TRIAGE: claude binary not found at $CLAUDE_BIN"
    : > "$llm_output_file"
    return 0
  fi

  local symptoms
  symptoms=$(build_symptom_summary "$context_file")

  local prompt
  prompt=$(cat <<EOF
You are the Homer daemon watchdog. The daemon health check has failed and the deterministic classifier could not match a known signature. You must decide what to do.

SYMPTOMS:
${symptoms}
AVAILABLE ACTIONS:
- restart: graceful launchctl restart (safe, preserves state)
- force_kill: kill -9 the daemon process + port holder + stale locks, then restart (use when restart alone won't work, e.g. port conflict or stuck process)
- repair: run a specific repair handler (only for ABI mismatch, launchd plist issues, or stale locks)
- source_fix: have Claude edit Homer source code to fix a bug (only if logs show a clear stack trace into Homer source/dist code)
- escalate: do nothing, notify the user (use when evidence is ambiguous or you're unsure)

REPAIR HANDLERS (only valid with action=repair):
- repair_native_modules: rebuild fs-ext/better-sqlite3 against current Node
- repair_launchd_runtime: reinstall the daemon plist
- repair_stale_lock: remove orphaned lock file

SIGNATURES (classify the failure):
- daemon_missing: no PID, port free
- port_conflict: port held by wrong process
- stale_lock_holder: lock held by non-daemon process
- health_timeout_with_live_pid: daemon alive + port held but health timed out
- native_module_abi_mismatch: ERR_DLOPEN_FAILED in logs
- launchd_runtime_mismatch: wrong Node.js path in launchd
- unknown_startup_crash: daemon exited, no match
- unknown_runtime_failure: daemon alive but health failing, no match

Read the recent stdout, stderr, and fatal logs in the context carefully. Look for error messages, stack traces, OOM kills, or connection refused patterns.

Return ONLY one raw JSON object (no markdown fences, no commentary):
{"action":"restart|force_kill|repair|source_fix|escalate","signature":"<one of the signatures above>","reason":"one sentence explaining what you see and why you chose this action","repairHandler":"repair_native_modules|repair_launchd_runtime|repair_stale_lock|null"}

FULL CONTEXT JSON:
$(cat "$context_file")
EOF
)

  run_with_timeout "$TRIAGE_TIMEOUT" "$CLAUDE_BIN" -p "$prompt" --output-format text --model sonnet > "$llm_output_file" 2>&1 || true
}

run_ai_triage() {
  local context_file="$1"
  local llm_output_file="$2"

  case "$RECOVERY_AGENT" in
    claude)
      log "TRIAGE: unknown signature, requesting Claude Sonnet classification"
      run_claude_triage "$context_file" "$llm_output_file"
      ;;
    bash|none)
      log "TRIAGE: AI disabled (RECOVERY_AGENT=$RECOVERY_AGENT), skipping"
      : > "$llm_output_file"
      ;;
    *)
      log "TRIAGE: unknown RECOVERY_AGENT=$RECOVERY_AGENT, falling back to Claude"
      run_claude_triage "$context_file" "$llm_output_file"
      ;;
  esac
}

cleanup_stale_cli_runs() {
  if [[ ! -f "$DB_PATH" ]]; then
    return 0
  fi
  local stale_count
  stale_count=$(/usr/bin/sqlite3 "$DB_PATH" \
    "UPDATE cli_runs SET status = 'failed', error = 'watchdog: stale run cleanup'
     WHERE status = 'running' AND started_at < (CAST(strftime('%s','now','-2 hours') AS INTEGER) * 1000);
     SELECT changes();" 2>/dev/null || echo 0)
  if [[ "$stale_count" -gt 0 ]] 2>/dev/null; then
    log "CLEANUP: marked ${stale_count} stale cli_runs as failed"
  fi
}

run_source_fix() {
  local context_file="$1"
  local reason="$2"
  local report_file="$3"
  local llm_fix_output build_log rc

  if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
    return 1
  fi

  llm_fix_output=$(run_with_timeout "$FIX_TIMEOUT" "$CLAUDE_BIN" -p \
    "Fix the Homer daemon bug in ~/homer. Edit code only. Do not run npm build, npm test, launchctl, or restart commands.

Watchdog reason: ${reason}
Context JSON:
$(cat "$context_file")
" \
    --allowedTools 'Edit,Read,Glob,Grep' 2>&1) || true

  {
    echo
    echo "=== SOURCE FIX OUTPUT ==="
    echo "$llm_fix_output"
  } >> "$report_file"

  build_log="$(mktemp /tmp/homer-watchdog-build.XXXXXX)"
  if ! (
    cd "$HOMER_DIR" &&
    npm run build
  ) >"$build_log" 2>&1; then
    {
      echo
      echo "=== BUILD FAILURE ==="
      cat "$build_log"
    } >> "$report_file"
    rm -f "$build_log"
    return 20
  fi

  {
    echo
    echo "=== BUILD OUTPUT ==="
    cat "$build_log"
  } >> "$report_file"
  rm -f "$build_log"

  action_restart
  rc=$?
  return "$rc"
}

action_escalate() {
  local reason="$1"
  log "ACTION: escalate -- ${reason}"
  local dump_file
  dump_file=$(dump_diagnostics)
  send_telegram "*Homer Watchdog Escalation*
${reason}
Diagnostics: \`${dump_file}\`"
  echo "$dump_file"
}

write_incident_report() {
  local report_file="$1"
  local context_file="$2"
  local decision_file="$3"
  local llm_output_file="${4:-}"

  {
    echo "=== Watchdog Incident $(/bin/date) ==="
    echo
    echo "=== Decision ==="
    cat "$decision_file"
    echo
    echo "=== Context ==="
    cat "$context_file"
    if [[ -n "$llm_output_file" && -f "$llm_output_file" ]]; then
      echo
      echo "=== Claude Triage Output ==="
      cat "$llm_output_file"
    fi
  } > "$report_file"
}

append_report_validation() {
  local report_file="$1"
  local outcome="$2"
  local validation_signature="${3:-}"
  {
    echo
    echo "=== Post Action Validation ==="
    echo "Outcome: $outcome"
    echo "Validation Signature: ${validation_signature:-none}"
  } >> "$report_file"
}

append_event_log() {
  local decision_file="$1"
  local outcome="$2"
  local report_file="$3"
  local validation_signature="${4:-}"
  rotate_event_log
  WD_EVENT_OUTCOME="$outcome" \
  WD_EVENT_REPORT="$report_file" \
  WD_EVENT_VALIDATION_SIGNATURE="$validation_signature" \
  /usr/bin/python3 - "$decision_file" >> "$EVENT_LOG" <<'PY'
import json
import os
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    decision = json.load(handle)

event = {
    "timestamp": __import__("datetime").datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
    "incident_id": decision.get("incidentId"),
    "signature": decision.get("signature"),
    "decision_source": decision.get("decisionSource"),
    "action": decision.get("action"),
    "repair_handler": decision.get("repairHandler"),
    "budget_snapshot": decision.get("budgetSnapshot"),
    "pre_action_summary": decision.get("reason"),
    "post_action_validation": os.environ.get("WD_EVENT_VALIDATION_SIGNATURE") or None,
    "final_outcome": os.environ.get("WD_EVENT_OUTCOME"),
    "report_file": os.environ.get("WD_EVENT_REPORT"),
}
print(json.dumps(event, separators=(",", ":")))
PY
}

validate_after_action() {
  local decision_signature="$1"
  local validation_context validation_result health_rc health_timed_out validation_signature

  /bin/sleep "$POST_ACTION_WAIT"
  check_health
  health_rc=$?
  if (( health_rc == 0 )); then
    VALIDATION_OUTCOME="health_recovered"
    VALIDATION_SIGNATURE=""
    return 0
  fi
  health_timed_out=0
  if (( health_rc == 28 )); then
    health_timed_out=1
  fi

  validation_context="$(mktemp /tmp/homer-watchdog-validation.XXXXXX)"
  validation_result="$(mktemp /tmp/homer-watchdog-classify.XXXXXX)"
  write_context_json "$validation_context" "$CONSECUTIVE_FAILURES" "$health_timed_out"
  if ! run_policy_classify "$validation_context" "$validation_result"; then
    VALIDATION_SIGNATURE=""
    VALIDATION_OUTCOME="validation_failed"
    rm -f "$validation_context" "$validation_result"
    return 0
  fi
  validation_signature=$(json_field "$validation_result" "signature")

  if [[ -n "$validation_signature" ]]; then
    VALIDATION_SIGNATURE="$validation_signature"
    if [[ "$validation_signature" == "$decision_signature" ]]; then
      VALIDATION_OUTCOME="same_signature_recurred"
    else
      VALIDATION_OUTCOME="new_signature_recurred"
    fi
  else
    VALIDATION_SIGNATURE=""
    VALIDATION_OUTCOME="validation_failed"
  fi

  rm -f "$validation_context" "$validation_result"
}

execute_decision() {
  local decision_file="$1"
  local context_file="$2"
  local report_file="$3"
  local action reason repair_handler signature

  action=$(json_field "$decision_file" "action")
  reason=$(json_field "$decision_file" "reason")
  repair_handler=$(json_field "$decision_file" "repairHandler")
  signature=$(json_field "$decision_file" "signature")

  EXECUTED="true"
  VALIDATION_OUTCOME="validation_failed"
  VALIDATION_SIGNATURE=""

  # Clean up stale cli_runs AFTER safety check passes but before action
  cleanup_stale_cli_runs

  # Notify via Telegram when daemon is broken and LLM decides a destructive action
  if [[ "$action" == "restart" || "$action" == "force_kill" || "$action" == "repair" || "$action" == "source_fix" ]]; then
    send_telegram "*Homer Watchdog: ${action}*
Signature: \`${signature}\`
Reason: ${reason}"
  fi

  case "$action" in
    restart)
      action_restart
      local rc=$?
      if (( rc == 10 )); then
        EXECUTED="false"
        VALIDATION_OUTCOME="action_skipped_by_policy"
        return 0
      fi
      if (( rc != 0 )); then
        return 0
      fi
      validate_after_action "$signature"
      ;;
    force_kill)
      action_force_kill || return 0
      validate_after_action "$signature"
      ;;
    repair)
      execute_repair_handler "$repair_handler"
      local rc=$?
      if (( rc == 10 )); then
        EXECUTED="false"
        VALIDATION_OUTCOME="action_skipped_by_policy"
        return 0
      fi
      if (( rc != 0 )); then
        return 0
      fi
      validate_after_action "$signature"
      ;;
    source_fix)
      run_source_fix "$context_file" "$reason" "$report_file"
      local rc=$?
      if (( rc == 20 )); then
        VALIDATION_SIGNATURE="build_failure"
        VALIDATION_OUTCOME="validation_failed"
        return 0
      fi
      if (( rc == 10 )); then
        EXECUTED="false"
        VALIDATION_OUTCOME="action_skipped_by_policy"
        return 0
      fi
      if (( rc != 0 )); then
        return 0
      fi
      validate_after_action "$signature"
      ;;
    escalate)
      action_escalate "$reason" >> "$report_file"
      VALIDATION_OUTCOME="validation_failed"
      ;;
    *)
      VALIDATION_SIGNATURE="llm_parse_failure"
      VALIDATION_OUTCOME="validation_failed"
      ;;
  esac
}

run_dry_run() {
  local context_file="$1"
  local llm_output_file="${2:-}"
  local decision_file
  decision_file="$(mktemp /tmp/homer-watchdog-decision.XXXXXX)"

  if [[ -n "$llm_output_file" ]]; then
    run_policy_decide "$context_file" "$decision_file" "$llm_output_file" || return 1
  else
    run_policy_decide "$context_file" "$decision_file" || return 1
  fi

  cat "$decision_file"
  rm -f "$decision_file"
}

handle_failure() {
  local health_timed_out="$1"
  local context_file decision_file llm_output_file needs_llm report_file incident_id

  context_file="$(mktemp /tmp/homer-watchdog-context.XXXXXX)"
  decision_file="$(mktemp /tmp/homer-watchdog-decision.XXXXXX)"
  llm_output_file="$(mktemp /tmp/homer-watchdog-llm.XXXXXX)"

  write_context_json "$context_file" "$CONSECUTIVE_FAILURES" "$health_timed_out"
  if ! run_policy_decide "$context_file" "$decision_file"; then
    local fallback_report
    fallback_report=$(action_escalate "Watchdog policy helper unavailable")
    log "TRIAGE: policy helper failed; diagnostics at $fallback_report"
    rm -f "$context_file" "$decision_file" "$llm_output_file"
    return 0
  fi

  needs_llm=$(json_field "$decision_file" "needsLlm")
  if [[ "$needs_llm" == "true" ]]; then
    run_ai_triage "$context_file" "$llm_output_file"
    if ! run_policy_decide "$context_file" "$decision_file" "$llm_output_file"; then
      local fallback_report
      fallback_report=$(action_escalate "Watchdog policy helper failed after Claude triage")
      log "TRIAGE: policy helper failed after Claude triage; diagnostics at $fallback_report"
      rm -f "$context_file" "$decision_file" "$llm_output_file"
      return 0
    fi
  fi

  incident_id=$(json_field "$decision_file" "incidentId")
  report_file="$CRASH_REPORTS_DIR/${incident_id:-incident}-$(/bin/date +%Y%m%d-%H%M%S).txt"
  write_incident_report "$report_file" "$context_file" "$decision_file" "$llm_output_file"

  log "TRIAGE: signature=$(json_field "$decision_file" "signature") action=$(json_field "$decision_file" "action") source=$(json_field "$decision_file" "decisionSource")"
  execute_decision "$decision_file" "$context_file" "$report_file"
  record_policy_outcome "$decision_file" "$VALIDATION_OUTCOME" "$EXECUTED" "$VALIDATION_SIGNATURE"
  append_report_validation "$report_file" "$VALIDATION_OUTCOME" "$VALIDATION_SIGNATURE"
  append_event_log "$decision_file" "$VALIDATION_OUTCOME" "$report_file" "$VALIDATION_SIGNATURE"

  rm -f "$context_file" "$decision_file" "$llm_output_file"
}

DRY_RUN=0
DRY_RUN_CONTEXT_FILE=""
DRY_RUN_LLM_OUTPUT_FILE=""

while (( $# > 0 )); do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --once)
      : # accepted for backward compat, ignored (always one-shot now)
      ;;
    --context-file)
      DRY_RUN_CONTEXT_FILE="${2:-}"
      shift
      ;;
    --llm-output-file)
      DRY_RUN_LLM_OUTPUT_FILE="${2:-}"
      shift
      ;;
    --state-file)
      STATE_FILE="${2:-$STATE_FILE}"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if (( DRY_RUN == 1 )); then
  if [[ -z "$DRY_RUN_CONTEXT_FILE" ]]; then
    echo "--dry-run requires --context-file" >&2
    exit 1
  fi
  if [[ -z "${STATE_FILE:-}" || "$STATE_FILE" == "$APP_SUPPORT_DIR/watchdog-state.json" ]]; then
    STATE_FILE="$(mktemp /tmp/homer-watchdog-state.XXXXXX)"
    trap 'rm -f "$STATE_FILE"' EXIT
  fi
  run_dry_run "$DRY_RUN_CONTEXT_FILE" "$DRY_RUN_LLM_OUTPUT_FILE"
  exit 0
fi

# --- Watchdog Execution Lock (atomic mkdir, same pattern as heartbeat) ---
WATCHDOG_LOCK_DIR="${APP_SUPPORT_DIR}/watchdog.lockdir"
WATCHDOG_LOCK_MAX_AGE=300  # 5 minutes

acquire_watchdog_lock() {
  if mkdir "$WATCHDOG_LOCK_DIR" 2>/dev/null; then
    echo "$$" > "$WATCHDOG_LOCK_DIR/pid"
    trap 'rm -rf "$WATCHDOG_LOCK_DIR"' EXIT
    return 0
  fi
  # Check for stale lock — PID dead OR age exceeds max
  local owner_pid lock_age
  owner_pid=$(cat "$WATCHDOG_LOCK_DIR/pid" 2>/dev/null || echo "")
  lock_age=$(($(date +%s) - $(stat -f%m "$WATCHDOG_LOCK_DIR" 2>/dev/null || echo "0")))
  if { [[ -n "$owner_pid" ]] && ! kill -0 "$owner_pid" 2>/dev/null; } || (( lock_age > WATCHDOG_LOCK_MAX_AGE )); then
    log "removing stale watchdog lock (pid=$owner_pid, age=${lock_age}s)"
    rm -rf "$WATCHDOG_LOCK_DIR"
    mkdir "$WATCHDOG_LOCK_DIR" 2>/dev/null || return 1
    echo "$$" > "$WATCHDOG_LOCK_DIR/pid"
    trap 'rm -rf "$WATCHDOG_LOCK_DIR"' EXIT
    return 0
  fi
  log "watchdog lock held by pid=$owner_pid (age=${lock_age}s); skipping"
  return 1
}

# --- One-shot mode (default entry point via launchd StartInterval) ---
run_once() {
  acquire_watchdog_lock || exit 0

  EXECUTED="true"
  VALIDATION_OUTCOME="validation_failed"
  VALIDATION_SIGNATURE=""

  # Check drain sentinel — daemon is shutting down gracefully, don't interfere
  local DRAIN_SENTINEL="$APP_SUPPORT_DIR/daemon.draining"
  local DRAIN_MAX_AGE_SECS=360  # 6 minutes (270s drain + 90s margin)
  if [[ -f "$DRAIN_SENTINEL" ]]; then
    local sentinel_age sentinel_pid
    sentinel_age=$(($(date +%s) - $(stat -f%m "$DRAIN_SENTINEL")))
    sentinel_pid=$(/usr/bin/python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('pid',''))" "$DRAIN_SENTINEL" 2>/dev/null || echo "")
    # Validate PID if available — if process is dead, sentinel is stale
    if [[ -n "$sentinel_pid" ]] && ! kill -0 "$sentinel_pid" 2>/dev/null; then
      log "drain sentinel PID ${sentinel_pid} is dead; removing stale sentinel"
      /bin/rm -f "$DRAIN_SENTINEL"
    elif (( sentinel_age > DRAIN_MAX_AGE_SECS )); then
      log "drain sentinel expired (age=${sentinel_age}s); removing"
      /bin/rm -f "$DRAIN_SENTINEL"
    else
      log "daemon is draining (pid=${sentinel_pid:-?}, age=${sentinel_age}s); suppressing watchdog"
      exit 0
    fi
  fi

  # Retry health checks before escalating — avoids false positives from transient blips
  local attempt=1 health_rc=0 health_timed_out=0
  CONSECUTIVE_FAILURES=0

  while (( attempt <= FAILURES_BEFORE_ACTION )); do
    if (( attempt > 1 )); then
      log "watchdog: health retry ${attempt}/${FAILURES_BEFORE_ACTION} after ${HEALTH_RETRY_DELAY}s delay"
      sleep "$HEALTH_RETRY_DELAY"
    fi

    check_health
    health_rc=$?

    if (( health_rc == 0 )); then
      if (( attempt > 1 )); then
        log "watchdog: health recovered after $((attempt - 1)) retries"
      fi
      # Healthy -- do periodic maintenance checks
      check_disk_space || true
      check_memory || true
      check_docker_health || true
      exit 0
    fi

    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    if (( health_rc == 28 )); then
      health_timed_out=1
    fi

    log "watchdog: health check failed (attempt ${attempt}/${FAILURES_BEFORE_ACTION}, rc=${health_rc})"
    attempt=$((attempt + 1))
  done

  log "watchdog: health failed ${CONSECUTIVE_FAILURES} consecutive checks (agent=${RECOVERY_AGENT})"
  handle_failure "$health_timed_out"
  check_docker_health || true
}

# --- Dispatch (always one-shot, launchd handles scheduling) ---
run_once
