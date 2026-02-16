#!/bin/bash
# Auto-update CLI tools daily (runs 30min before morning brief)
# Managed by: com.homer.cli-update.plist

export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/yj/.local/bin:$PATH"

LOG="/Users/yj/homer/logs/cli-update.log"
exec >> "$LOG" 2>&1

echo "=== CLI Update $(date '+%Y-%m-%d %H:%M:%S') ==="

# Claude Code — standalone installer
echo "[claude] Updating..."
claude update 2>&1 | tail -3
echo "[claude] $(claude --version 2>/dev/null)"

# Codex — npm global
echo "[codex] Updating..."
npm update -g @openai/codex 2>&1 | tail -3
echo "[codex] $(codex --version 2>/dev/null)"

# OpenCode (Gemini CLI) — Homebrew
echo "[opencode] Updating..."
brew upgrade opencode 2>&1 | tail -3
echo "[opencode] $(opencode --version 2>/dev/null)"

# Kimi — Homebrew
echo "[kimi] Updating..."
brew upgrade kimi-cli 2>&1 | tail -3
echo "[kimi] $(kimi --version 2>/dev/null)"

echo "=== Done ==="
