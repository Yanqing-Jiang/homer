#!/bin/bash
# Auto-update CLI tools daily at 5:00 AM
# Managed by: com.homer.cli-update.plist

export PATH="/opt/homebrew/bin:/usr/local/bin:/Users/yj/.local/bin:$PATH"

LOG="/Users/yj/homer/logs/cli-update.log"
exec >> "$LOG" 2>&1

echo "=== CLI Update $(date '+%Y-%m-%d %H:%M:%S') ==="

# Claude Code — built-in self-updater
echo "[claude] Updating..."
claude update 2>&1 | tail -3
echo "[claude] $(claude --version 2>/dev/null)"

# Codex — npm global (use install @latest to avoid semver skips)
echo "[codex] Updating..."
npm install -g @openai/codex@latest 2>&1 | tail -3
echo "[codex] $(codex --version 2>/dev/null)"

# OpenCode — Homebrew
echo "[opencode] Updating..."
brew upgrade opencode 2>&1 | tail -3
echo "[opencode] $(opencode --version 2>/dev/null)"

# Kimi — Homebrew (formula: kimi-cli, binary: kimi)
echo "[kimi] Updating..."
brew upgrade kimi-cli 2>&1 | tail -3
echo "[kimi] $(kimi --version 2>/dev/null)"

# Antigravity CLI (agy) — replaces retired Gemini CLI.
# Standalone Mach-O binary at ~/.local/bin/agy; no package-manager auto-update.
# Update manually by replacing the binary; this just reports the installed version.
echo "[agy] $(/Users/yj/.local/bin/agy --version 2>/dev/null) (Antigravity CLI — manual update)"

echo "=== Done ==="
