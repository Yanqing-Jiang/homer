#!/usr/bin/env bash
# Create-or-select a window for the homer-mini toolbar's `+` button.
#
# Invoked from /Users/yj/homer/config/tmux-mini.conf as:
#   run-shell "/Users/yj/homer/config/tmux-mini-newwin.sh '%1'"
#
# The name is validated here, as shell data, instead of being interpolated into
# a tmux format expression: tmux replaces only the FIRST %% per template (so a
# two-placeholder `if-shell -F` condition silently skipped its length check),
# and `#`, `,` or `}` in prompt text can corrupt a format expression into a
# truthy result rather than being cleanly rejected.
#
# The regex mirrors /Users/yj/homer-web/src/web/api/terminal.ts so every name
# created here stays attachable and deletable through the web API.
set -euo pipefail

TMUX_BIN=/Users/yj/homer/bin/tmux
name=${1-}

if [[ ! $name =~ ^[A-Za-z0-9_-]{1,32}$ ]]; then
  "$TMUX_BIN" display-message -t homer-mini: 'Invalid name: use 1-32 letters, digits, _ or -'
  exit 0
fi

# Exact-line match on the shared window list. A tmux target is deliberately not
# used for the existence probe: a name could misparse as a target spec.
if "$TMUX_BIN" list-windows -t homer-mini: -F '#{window_name}' | grep -qxF -- "$name"; then
  "$TMUX_BIN" select-window -t "homer-mini:=$name"
else
  "$TMUX_BIN" new-window -t homer-mini: -n "$name"
fi
