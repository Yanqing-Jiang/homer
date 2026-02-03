#!/bin/bash
#
# HOMER Daemon Installation Script
# Installs HOMER as a system LaunchDaemon for true 24/7 operation
#
# Usage:
#   sudo ./install-daemon.sh          # Install as system daemon (recommended)
#   ./install-daemon.sh --agent       # Install as user agent (legacy)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOMER_DIR="/Users/yj/homer"
PLIST_SRC="$HOMER_DIR/com.homer.daemon.plist"
LOGS_DIR="$HOMER_DIR/logs"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=== HOMER Daemon Installer ==="
echo ""

# Create logs directory
mkdir -p "$LOGS_DIR"

# Check for --agent flag
if [[ "${1:-}" == "--agent" ]]; then
    echo -e "${YELLOW}Installing as user LaunchAgent (legacy mode)${NC}"
    echo "Note: LaunchAgents stop when you log out."
    echo ""

    LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

    # Stop existing
    launchctl bootout gui/$(id -u)/com.homer.daemon 2>/dev/null || true
    sleep 2

    # Copy and load
    cp "$PLIST_SRC" "$LAUNCH_AGENTS_DIR/"
    launchctl bootstrap gui/$(id -u) "$LAUNCH_AGENTS_DIR/com.homer.daemon.plist"

    echo -e "${GREEN}✓ LaunchAgent installed${NC}"
    echo ""
    echo "Commands:"
    echo "  Restart: launchctl kickstart -k gui/\$(id -u)/com.homer.daemon"
    echo "  Stop:    launchctl bootout gui/\$(id -u)/com.homer.daemon"
    echo "  Logs:    tail -f $LOGS_DIR/stdout.log"
    exit 0
fi

# System daemon installation (requires sudo)
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: System daemon installation requires sudo${NC}"
    echo ""
    echo "Usage:"
    echo "  sudo $0              # Install as system daemon (24/7)"
    echo "  $0 --agent           # Install as user agent (stops on logout)"
    exit 1
fi

echo -e "${GREEN}Installing as system LaunchDaemon (24/7 operation)${NC}"
echo ""

LAUNCH_DAEMONS_DIR="/Library/LaunchDaemons"
PLIST_DST="$LAUNCH_DAEMONS_DIR/com.homer.daemon.plist"

# 1. Stop and unload the old LaunchAgent (if loaded)
echo "[1/6] Unloading existing LaunchAgent..."
su - yj -c "launchctl bootout gui/\$(id -u) /Users/yj/Library/LaunchAgents/com.homer.daemon.plist 2>/dev/null" || true

# 2. Unload existing LaunchDaemon (if any)
echo "[2/6] Unloading existing LaunchDaemon..."
launchctl bootout system/com.homer.daemon 2>/dev/null || true

# 3. Kill any running Homer processes
echo "[3/6] Stopping running Homer processes..."
pkill -f "homer/dist/index.js" 2>/dev/null || true
sleep 2

# 4. Install the LaunchDaemon plist
echo "[4/6] Installing LaunchDaemon plist..."
cp "$PLIST_SRC" "$PLIST_DST"
chown root:wheel "$PLIST_DST"
chmod 644 "$PLIST_DST"

# 5. Ensure logs dir is writable
chown -R yj:staff "$LOGS_DIR"

# 6. Load and start the daemon
echo "[5/6] Loading and starting daemon..."
launchctl bootstrap system "$PLIST_DST"
launchctl enable system/com.homer.daemon

echo "[6/6] Verifying..."
sleep 3

# Check health
if curl -s --max-time 10 http://localhost:3000/health > /dev/null 2>&1; then
    echo ""
    echo -e "${GREEN}✓ HOMER is running and healthy!${NC}"
else
    echo ""
    echo -e "${YELLOW}⚠ HOMER may still be starting. Check logs:${NC}"
    echo "  tail -f $LOGS_DIR/stdout.log"
fi

# Show status
echo ""
echo "=== Status ==="
launchctl print system/com.homer.daemon 2>/dev/null | grep -E "state|pid|last exit" || true

echo ""
echo "=== Commands ==="
echo "  Restart: sudo launchctl kickstart -k system/com.homer.daemon"
echo "  Stop:    sudo launchctl bootout system/com.homer.daemon"
echo "  Status:  sudo launchctl print system/com.homer.daemon"
echo "  Logs:    tail -f $LOGS_DIR/stdout.log"
echo ""
echo -e "${GREEN}✓ Installation complete${NC}"
