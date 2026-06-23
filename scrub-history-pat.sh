#!/usr/bin/env bash
# Scrub Supabase PAT(s) from Claude history.jsonl.
# RUN THIS ONLY AFTER CLOSING ALL CLAUDE SESSIONS (the file is live-appended).
set -euo pipefail
f="$HOME/.claude/history.jsonl"
[ -f "$f" ] || { echo "no $f"; exit 0; }

before=$(grep -ocE 'sbp_[A-Za-z0-9]{20,}' "$f" || true)
echo "sbp_ tokens before: $before"
[ "$before" = "0" ] && { echo "nothing to scrub"; exit 0; }

cp "$f" "$f.bak"; chmod 600 "$f.bak"
LC_ALL=C sed -E -i '' 's/sbp_[A-Za-z0-9]{20,}/sbp_REDACTED/g' "$f"
chmod 600 "$f"

after=$(grep -ocE 'sbp_[A-Za-z0-9]{20,}' "$f" || true)
echo "sbp_ tokens after:  $after"
if [ "$after" = "0" ]; then
  rm -f "$f.bak"
  echo "done — backup removed."
else
  echo "WARNING: tokens remain; backup kept at $f.bak"
fi
