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

# A running `browserctl agent` rides out a restart: it keeps its tab, retries the broker for
# up to 5 min, and the next broker generation restores its lease from the handoff. Refuse only
# for leases that cannot survive: any holder other than a browserctl agent (daemon jobs,
# stewardship touches, Python collectors renewing through plain `browserctl renew`), and agents
# started before the current bin/browserctl, which predate the retry. Both instances are
# checked; fail open if the broker itself cannot report (a restart may be the fix).
# DEBT: "predates the retry" is judged by process start vs bin/browserctl mtime, so ANY later edit
# to bin/browserctl makes already-running agents refuse a restart (conservative). Upgrade to a
# client-advertised protocol version on reserve-external if that ever blocks a restart falsely.
if [[ "$FORCE" != "1" ]]; then
  active_leases="$(node - "$HOMER_ROOT/bin/browserctl" <<'NODE' 2>/dev/null || true
const { execFileSync } = require("node:child_process");
const { statSync } = require("node:fs");
const browserctl = process.argv[2];
const now = Date.now();
const read = (args) => { try { return JSON.parse(execFileSync(browserctl, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] })); } catch (error) { try { return JSON.parse(error.stdout); } catch { return null; } } };
const clientMtime = statSync(browserctl).mtimeMs;
const agentPid = (owner) => /^browserctl-agent:(\d+)(?::|$)/.exec(owner ?? "")?.[1];
const survives = (owner, adopter) => [owner, adopter].filter(Boolean).every((name) => {
  const pid = agentPid(name);
  if (!pid) return false;
  try { return Date.parse(execFileSync("/bin/ps", ["-o", "lstart=", "-p", pid], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) >= clientMtime - 1_000; }
  catch { return true; } // exited: nothing left to interrupt
});
const live = [];
const note = (instance, surface, owner, adopter, expiresAt) => {
  const at = typeof expiresAt === "number" ? expiresAt : Date.parse(expiresAt);
  if (!(at > now) || survives(owner, adopter)) return;
  live.push(`${instance}:${surface} (owner=${owner}${adopter ? ` adopter=${adopter}` : ""} expires=${new Date(at).toISOString()})`);
};
const downloads = read(["status"])?.status;
for (const [surface, s] of Object.entries(downloads?.surfaces ?? {})) if (s?.lease) note("downloads", surface, s.lease.owner, null, s.lease.expiresAt);
for (const r of downloads?.externalReservations ?? []) note("downloads", r.surface, r.owner, r.adopterOwner, r.expiresAt);
const interactive = read(["status", "--instance", "interactive"]);
for (const r of interactive?.leases ?? []) if (r.leaseId) note("interactive", r.surface, r.owner, r.adopterOwner, r.leaseExpiresAt);
for (const r of interactive?.reservations ?? []) note("interactive", r.surface, r.owner, r.adopterOwner, r.expiresAt);
process.stdout.write([...new Set(live)].join("; "));
NODE
)"
  if [[ -n "$active_leases" ]]; then
    echo "refuse: browser lease(s) that would not survive a restart: $active_leases" >&2
    echo "        Wait for them to finish or pass --force." >&2
    exit 3
  fi
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
