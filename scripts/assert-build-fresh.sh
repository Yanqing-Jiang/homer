#!/usr/bin/env bash
#
# Refuse a daemon restart when compiled dist is older than source — the exact
# incident where an edit "ships" via a plain restart without a rebuild. Run
# before any human/agent-initiated restart; recovery paths (heartbeat/watchdog
# restarting a CRASHED process) are intentionally exempt.
#
# Escape hatch (intentional stale restart, e.g. crash recovery):
#   assert-build-fresh.sh --force-stale   OR   HOMER_ALLOW_STALE_RESTART=1
#
set -eo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--force-stale" ] || [ "${HOMER_ALLOW_STALE_RESTART:-}" = "1" ]; then
  exit 0
fi

if [ ! -f dist/.build-version ]; then
  echo "refuse: no dist/.build-version — run 'npm run deploy' (never restart an unbuilt daemon)." >&2
  exit 1
fi

if [ ! -f dist/index.js ]; then
  echo "refuse: dist/index.js is missing — run 'npm run deploy'." >&2
  exit 1
fi

newer_source=""
for source_path in src package.json tsconfig.json scripts/write-build-version.mjs; do
  if [ -e "$source_path" ]; then
    newer_source="$(find "$source_path" -type f -newer dist/.build-version -print -quit)"
    [ -n "$newer_source" ] && break
  fi
done

if [ -n "$newer_source" ]; then
  echo "refuse: source newer than dist — run 'npm run deploy'. For config-only edits, no restart is needed." >&2
  echo "  newest unbuilt file: ${newer_source}" >&2
  echo "  (intentional stale restart, e.g. crash recovery: 'npm run restart:force-stale')" >&2
  exit 1
fi
