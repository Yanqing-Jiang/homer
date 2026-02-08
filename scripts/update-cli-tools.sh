#!/bin/bash
# Auto-update CLI tools: Claude, Gemini, Codex
# Runs daily at 5:30 AM via LaunchAgent

set -e

LOG_DIR="/Users/yj/homer/logs"
LOG_FILE="$LOG_DIR/cli-updates.log"
mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Starting CLI tools update ==="

# Claude Code (install script)
log "Updating Claude Code..."
if curl -fsSL https://claude.ai/install.sh | bash >> "$LOG_FILE" 2>&1; then
    log "Claude Code updated successfully"
else
    log "Claude Code update failed"
fi

# Gemini CLI (Homebrew)
log "Updating Gemini CLI..."
if /opt/homebrew/bin/brew upgrade gemini-cli >> "$LOG_FILE" 2>&1; then
    log "Gemini CLI updated successfully"
elif /opt/homebrew/bin/brew upgrade gemini-cli 2>&1 | grep -q "already installed"; then
    log "Gemini CLI already up to date"
else
    log "Gemini CLI update failed or already current"
fi

# Codex CLI (npm)
log "Updating Codex CLI..."
if /opt/homebrew/bin/npm install -g @openai/codex >> "$LOG_FILE" 2>&1; then
    log "Codex CLI updated successfully"
else
    log "Codex CLI update failed"
fi

log "=== CLI tools update complete ==="

# Log versions
log "Current versions:"
log "  Claude: $(/Users/yj/.local/bin/claude --version 2>/dev/null || echo 'unknown')"
log "  Gemini: $(/opt/homebrew/bin/gemini --version 2>/dev/null || echo 'unknown')"
log "  Codex: $(/opt/homebrew/bin/codex --version 2>/dev/null | head -1 || echo 'unknown')"
