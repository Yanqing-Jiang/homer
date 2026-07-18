#!/bin/bash
# Presence-only fallback for the launchd/supervisor control plane. Child health,
# build state, restart intent, and database work belong to the supervisor.

set -u
set -o pipefail

HOMER_LABEL="${HOMER_LABEL:-com.homer.daemon}"
LAUNCHD_DOMAIN="${LAUNCHD_DOMAIN:-gui/$(/usr/bin/id -u)}"
LAUNCHD_TARGET="${LAUNCHD_DOMAIN}/${HOMER_LABEL}"
DAEMON_PLIST="${DAEMON_PLIST:-$HOME/Library/LaunchAgents/com.homer.daemon.plist}"
APP_SUPPORT_DIR="${APP_SUPPORT_DIR:-$HOME/Library/Application Support/Homer}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/homer}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/heartbeat.log}"
LOCK_DIR="${LOCK_DIR:-$APP_SUPPORT_DIR/heartbeat.lockdir}"
STATE_FILE="${STATE_FILE:-$APP_SUPPORT_DIR/heartbeat-presence.state}"
DRAIN_SENTINEL="${DRAIN_SENTINEL:-$APP_SUPPORT_DIR/daemon.draining}"
DRAIN_MAX_AGE_SECS="${DRAIN_MAX_AGE_SECS:-360}"

mkdir -p "$APP_SUPPORT_DIR" "$LOG_DIR"

log() {
  echo "$(/bin/date -u +"%Y-%m-%dT%H:%M:%SZ") $*" >> "$LOG_FILE"
}

if ! /bin/mkdir "$LOCK_DIR" 2>/dev/null; then
  owner_pid="$(/bin/cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && ! /bin/kill -0 "$owner_pid" 2>/dev/null; then
    /bin/rm -f "$LOCK_DIR/pid"
    /bin/rmdir "$LOCK_DIR" 2>/dev/null || exit 0
    /bin/mkdir "$LOCK_DIR" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap '/bin/rm -rf "$LOCK_DIR"' EXIT
echo "$$" > "$LOCK_DIR/pid"

service_loaded() {
  /bin/launchctl print "$LAUNCHD_TARGET" >/dev/null 2>&1
}

service_pid() {
  /bin/launchctl print "$LAUNCHD_TARGET" 2>/dev/null | /usr/bin/awk '/pid =/ {print $3; exit}'
}

pid_alive() {
  [[ "$1" =~ ^[0-9]+$ ]] && /bin/kill -0 "$1" 2>/dev/null
}

supervisor_identity_ok() {
  local command
  command="$(/bin/ps -p "$1" -o command= 2>/dev/null || true)"
  [[ "$command" == *"daemon-supervisor.mjs"* ]]
}

fresh_supervisor_sentinel() {
  [[ -f "$DRAIN_SENTINEL" ]] || return 1
  /usr/bin/grep -q '"owner"[[:space:]]*:[[:space:]]*"homer-supervisor"' "$DRAIN_SENTINEL" 2>/dev/null || return 1
  local modified now
  modified="$(/usr/bin/stat -f %m "$DRAIN_SENTINEL" 2>/dev/null || echo 0)"
  now="$(/bin/date +%s)"
  [[ "$modified" =~ ^[0-9]+$ ]] && (( now - modified <= DRAIN_MAX_AGE_SECS ))
}

presence_ok=0
loaded=0
pid=""
if service_loaded; then
  loaded=1
  pid="$(service_pid || true)"
  if pid_alive "$pid" && supervisor_identity_ok "$pid"; then
    presence_ok=1
  fi
fi

if (( presence_ok )); then
  echo 0 > "$STATE_FILE"
  exit 0
fi

failures="$(/bin/cat "$STATE_FILE" 2>/dev/null || echo 0)"
[[ "$failures" =~ ^[0-9]+$ ]] || failures=0
failures=$((failures + 1))
echo "$failures" > "$STATE_FILE"
log "supervisor presence missing sample=$failures loaded=$loaded pid=${pid:-none}"
(( failures >= 2 )) || exit 0

if fresh_supervisor_sentinel; then
  log "fresh supervisor drain sentinel present; recovery deferred"
  exit 0
fi

# Never mutate a loaded job while any live PID is present, even if identity is
# unexpected. This is safer than risking replacement of a live supervisor.
if pid_alive "$pid"; then
  log "loaded job has live pid=$pid with unexpected identity; no launchctl mutation"
  exit 1
fi

if (( loaded == 0 )); then
  if [[ ! -f "$DAEMON_PLIST" ]]; then
    log "daemon plist missing: $DAEMON_PLIST"
    exit 1
  fi
  log "bootstrapping missing daemon label"
  /bin/launchctl bootstrap "$LAUNCHD_DOMAIN" "$DAEMON_PLIST" >/dev/null 2>&1 || exit 1
else
  log "starting loaded daemon job with no live supervisor"
  /bin/launchctl kickstart "$LAUNCHD_TARGET" >/dev/null 2>&1 || \
    /bin/launchctl start "$HOMER_LABEL" >/dev/null 2>&1 || exit 1
fi

echo 0 > "$STATE_FILE"
