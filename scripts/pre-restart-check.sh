#!/usr/bin/env bash
# Shared, noninteractive restart policy. The supervisor is the only caller that
# may turn an "allow" result into a child restart.

set -u
set -o pipefail

HOMER_DIR="${HOMER_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DB_PATH="${HOMER_DB_PATH:-$HOMER_DIR/data/homer.db}"
RUNTIME_STAMP="${HOMER_RUNTIME_STAMP:-$HOMER_DIR/run/daemon-build.json}"
DISK_BUILD="${HOMER_DISK_BUILD:-$HOMER_DIR/dist/.build-version}"
MODE="${1:-planned}"
HUMAN=0
[[ "${2:-}" == "--human" || "${1:-}" == "--human" ]] && HUMAN=1
[[ "$MODE" == "--human" ]] && MODE="planned"

# Stable contract: allow=0, defer=10, noop_same_build=11, policy_error=20.
emit() {
  local result="$1" code="$2" reason="$3"
  printf '{"version":1,"mode":"%s","result":"%s","reason":"%s","blockers":{"cli_runs":%d,"scheduled_jobs":%d,"job_queue":%d,"managed_processes":%d}}\n' \
    "$MODE" "$result" "$reason" "$cli_count" "$scheduled_count" "$queue_count" "$managed_count"
  if (( HUMAN )); then
    printf 'Restart policy: %s (%s); blockers cli=%d scheduled=%d queue=%d managed=%d\n' \
      "$result" "$reason" "$cli_count" "$scheduled_count" "$queue_count" "$managed_count" >&2
  fi
  exit "$code"
}

cli_count=0
scheduled_count=0
queue_count=0
managed_count=0

case "$MODE" in
  planned|unhealthy|force) ;;
  *) emit policy_error 20 invalid_mode ;;
esac

if ! command -v sqlite3 >/dev/null 2>&1 || [[ ! -f "$DB_PATH" ]]; then
  emit policy_error 20 database_unavailable
fi

db_query() {
  sqlite3 -readonly -cmd '.timeout 5000' "$DB_PATH" "$1" 2>/dev/null
}

cli_count="$(db_query "SELECT COUNT(*) FROM cli_runs WHERE status='running';")" || emit policy_error 20 database_query_failed
scheduled_count="$(db_query "SELECT COUNT(*) FROM scheduled_job_state WHERE is_running=1;")" || emit policy_error 20 database_query_failed
queue_count="$(db_query "SELECT COUNT(*) FROM job_queue WHERE status='running';")" || emit policy_error 20 database_query_failed
for count in "$cli_count" "$scheduled_count" "$queue_count"; do
  [[ "$count" =~ ^[0-9]+$ ]] || emit policy_error 20 database_query_failed
done

# A registry row blocks only while its PID is live and the recorded command
# still identifies that PID. This avoids treating dead rows or PID reuse as work.
managed_rows="$(db_query "SELECT pid || char(9) || command FROM managed_processes WHERE settled=0;")" || emit policy_error 20 database_query_failed
while IFS=$'\t' read -r pid command; do
  [[ "$pid" =~ ^[0-9]+$ ]] || continue
  if kill -0 "$pid" 2>/dev/null; then
    actual="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ -n "$actual" && -n "$command" && "$actual" == *"$command"* ]]; then
      managed_count=$((managed_count + 1))
    fi
  fi
done <<< "$managed_rows"

if [[ "$MODE" == "planned" || "$MODE" == "force" ]]; then
  if [[ "${HOMER_ALLOW_STALE_RESTART:-0}" != "1" ]]; then
    freshness_output="$(bash "$HOMER_DIR/scripts/assert-build-fresh.sh" 2>&1)" || {
      (( HUMAN )) && printf '%s\n' "$freshness_output" >&2
      emit defer 10 stale_or_unbuilt
    }
  fi

  build_result="$(node - "$DISK_BUILD" "$RUNTIME_STAMP" "${HOMER_CURRENT_CHILD_PID:-}" <<'NODE'
const fs = require("node:fs");
const [diskPath, runtimePath, childPid] = process.argv.slice(2);
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const comparable = (value) => value && typeof value === "object" ? {
  sha: value.sha ?? null,
  dirty: typeof value.dirty === "boolean" ? value.dirty : null,
  sourceFingerprint: value.sourceFingerprint ?? null,
  maxSourceMtimeMs: typeof value.maxSourceMtimeMs === "number" ? value.maxSourceMtimeMs : null,
} : null;
const disk = comparable(read(diskPath));
const stamp = read(runtimePath);
const runtime = comparable(stamp?.build);
if (!disk || !runtime || (childPid && Number(childPid) !== stamp?.pid)) process.stdout.write("invalid");
else process.stdout.write(JSON.stringify(disk) === JSON.stringify(runtime) ? "same" : "changed");
NODE
)" || emit policy_error 20 build_compare_failed
  [[ "$build_result" != "invalid" ]] || emit policy_error 20 runtime_stamp_invalid
  [[ "$build_result" != "same" ]] || emit noop_same_build 11 runtime_matches_dist
fi

total_blockers=$((cli_count + scheduled_count + queue_count + managed_count))
if (( total_blockers > 0 )) && [[ "$MODE" != "force" ]]; then
  emit defer 10 active_work
fi

emit allow 0 "$([[ "$MODE" == "force" ]] && echo forced || echo idle)"
