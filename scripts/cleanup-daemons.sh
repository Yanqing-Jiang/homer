#!/bin/bash

# Homer Daemon Cleanup Script
# Kills all stuck Homer processes and cleans up PID locks
# Use when Homer fails to start due to duplicate instances

set -e

echo "🧹 Homer Daemon Cleanup"
echo "======================="
echo ""

# Function to safely kill processes
kill_processes() {
    local pattern=$1
    local name=$2

    pids=$(pgrep -f "$pattern" || true)

    if [ -z "$pids" ]; then
        echo "✓ No $name processes found"
        return 0
    fi

    echo "🔍 Found $name processes:"
    ps -fp $pids || true
    echo ""

    echo "🛑 Killing $name processes..."
    pkill -f "$pattern" || true
    sleep 1

    # Force kill if still running
    pids=$(pgrep -f "$pattern" || true)
    if [ -n "$pids" ]; then
        echo "⚠️  Force killing stubborn processes..."
        pkill -9 -f "$pattern" || true
    fi

    echo "✓ $name processes cleaned up"
}

# Kill Homer daemon processes
kill_processes "node.*homer/dist/index.js" "Homer daemon"

# Kill MCP server processes
kill_processes "node.*homer/dist/mcp/index.js" "Homer MCP"

# Kill any stuck Claude processes related to Homer
kill_processes "claude.*resume" "Claude resume"

# Remove PID lock file
if [ -f /tmp/homer.pid ]; then
    echo ""
    echo "🗑️  Removing PID lock file..."
    rm -f /tmp/homer.pid
    echo "✓ PID lock removed"
else
    echo ""
    echo "✓ No PID lock file found"
fi

echo ""
echo "✅ Cleanup complete!"
echo ""
echo "You can now start Homer with:"
echo "  cd ~/homer && node dist/index.js"
echo ""
