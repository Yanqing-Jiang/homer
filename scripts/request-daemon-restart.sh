#!/usr/bin/env bash

# Persist restart intent first; SIGHUP only wakes the resident supervisor.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOMER_ROOT="${HOMER_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
TARGET="${LAUNCHD_TARGET:-gui/$(id -u)/com.homer.daemon}"
APP_SUPPORT_DIR="${HOMER_APP_SUPPORT:-$HOME/Library/Application Support/Homer}"
REQUEST_FILE="${HOMER_RESTART_REQUEST:-$APP_SUPPORT_DIR/restart.request}"
FORCE=0
FORCE_STALE=0
REASON=""

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --force-stale) FORCE_STALE=1 ;;
    --now) ;;
    --*) echo "refuse: unknown restart option: $arg" >&2; exit 2 ;;
    *) [[ -z "$REASON" ]] && REASON="$arg" ;;
  esac
done
REASON="${REASON:-manual-restart}"

if [[ ! -f "$HOMER_ROOT/dist/.build-version" ]]; then
  echo "refuse: dist/.build-version is missing; run npm run build first." >&2
  exit 1
fi

supervisor_pid="$(launchctl print "$TARGET" 2>/dev/null | awk '/pid =/ {print $3; exit}')"
if [[ ! "$supervisor_pid" =~ ^[0-9]+$ ]] || ! kill -0 "$supervisor_pid" 2>/dev/null; then
  echo "refuse: Homer supervisor is not running; install it with 'npm run supervisor:install'." >&2
  exit 1
fi

mkdir -p "$APP_SUPPORT_DIR"
tmp="${REQUEST_FILE}.tmp.$$"
trap 'rm -f "$tmp"' EXIT
node - "$HOMER_ROOT/dist/.build-version" "$tmp" "$REASON" "$FORCE" "$FORCE_STALE" <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const [buildPath, output, reason, force, forceStale] = process.argv.slice(2);
const targetBuild = JSON.parse(fs.readFileSync(buildPath, "utf8"));
const request = {
  version: 1,
  reason,
  requester: `${process.env.USER ?? "unknown"}@${os.hostname()}:pid-${process.ppid}`,
  requestedAt: new Date().toISOString(),
  force: force === "1",
  forceStale: forceStale === "1",
  targetBuild,
};
fs.writeFileSync(output, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
NODE
mv -f "$tmp" "$REQUEST_FILE"
trap - EXIT

kill -HUP "$supervisor_pid"
echo "Restart request queued (reason=$REASON force=$FORCE force-stale=$FORCE_STALE); supervisor pid $supervisor_pid woken."
