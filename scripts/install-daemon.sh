#!/usr/bin/env bash
#
# Homer daemon installer.
#
# Generates ~/Library/LaunchAgents/com.homer.daemon.plist from
# config/com.homer.daemon.plist.template (substituting paths/user from the
# running environment) and loads it via launchctl. Secrets are NOT injected
# into the plist — Homer loads .env at startup via dotenv.
#
# Usage:
#   bash scripts/install-daemon.sh                # install / refresh user agent (default)
#   bash scripts/install-daemon.sh --system       # install as system LaunchDaemon (requires sudo)
#
# Portable: derives every path from $HOME, id -un/id -gn, and command -v node.
#

set -euo pipefail

# --- Resolve repo root from script location (works for any clone path) ------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOMER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Derive user/host environment -------------------------------------------
HOMER_USER="$(id -un)"
HOMER_GROUP="$(id -gn)"
HOMER_HOME="$HOME"
NODE_BIN="$(command -v node || true)"
HOMER_PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"

# Optional app wrapper (Homer.app bundle so launchd can attribute the
# background item). Defaults to ~/Applications/Homer.app/Contents/MacOS/Homer
# but degrades gracefully to the raw node binary if not built.
HOMER_APP_BIN="${HOMER_APP_BIN:-$HOMER_HOME/Applications/Homer.app/Contents/MacOS/Homer}"

TEMPLATE_SRC="$HOMER_DIR/config/com.homer.daemon.plist.template"
LOGS_DIR="$HOMER_DIR/logs"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

INSTALL_MODE="agent"
for arg in "$@"; do
  case "$arg" in
    --system) INSTALL_MODE="system" ;;
    --agent)  INSTALL_MODE="agent" ;;
    -h|--help)
      cat <<USAGE
Usage: $0 [--agent | --system]

  --agent     Install as user LaunchAgent (default; stops on logout).
  --system    Install as system LaunchDaemon (24/7; requires sudo).
USAGE
      exit 0 ;;
  esac
done

echo "=== Homer Daemon Installer ==="
echo "  Repo:      $HOMER_DIR"
echo "  User:      $HOMER_USER ($HOMER_GROUP)"
echo "  Home:      $HOMER_HOME"
echo "  Node:      ${NODE_BIN:-(not found in PATH!)}"
echo "  Mode:      $INSTALL_MODE"
echo ""

# --- Pre-flight checks ------------------------------------------------------
if [ -z "$NODE_BIN" ]; then
  echo -e "${RED}Error:${NC} node not found in PATH. Install Node 20+ and retry."
  exit 1
fi
if [ ! -f "$TEMPLATE_SRC" ]; then
  echo -e "${RED}Error:${NC} plist template not found at $TEMPLATE_SRC"
  exit 1
fi
if [ ! -f "$HOMER_DIR/dist/index.js" ]; then
  echo -e "${YELLOW}Warning:${NC} $HOMER_DIR/dist/index.js missing — run 'npm run build' first."
fi
if [ ! -f "$HOMER_DIR/.env" ]; then
  echo -e "${YELLOW}Warning:${NC} $HOMER_DIR/.env missing — Homer will start with empty secrets."
  echo "         Copy .env.example to .env and fill in credentials."
fi

mkdir -p "$LOGS_DIR"

# --- Optional: build the Homer.app wrapper if available ---------------------
if [ ! -x "$HOMER_APP_BIN" ] && [ -x "$HOMER_DIR/scripts/build-homer-app.sh" ]; then
  echo "Building Homer.app wrapper at $HOMER_APP_BIN..."
  bash "$HOMER_DIR/scripts/build-homer-app.sh" "$(dirname "$(dirname "$HOMER_APP_BIN")")" || \
    echo -e "${YELLOW}  app wrapper build failed — continuing with raw node binary${NC}"
fi
# If the wrapper still isn't there, use node directly so the plist still works.
if [ ! -x "$HOMER_APP_BIN" ]; then
  echo -e "${YELLOW}Note:${NC} no Homer.app wrapper — using /usr/bin/env to launch node."
  HOMER_APP_BIN="/usr/bin/env"
fi

# --- Generate plist from template -------------------------------------------
GENERATED_PLIST="$(mktemp -t homer-plist-XXXXXX).plist"
trap 'rm -f "$GENERATED_PLIST"' EXIT

# sed-based substitution (portable across macOS BSD sed and GNU sed)
sed \
  -e "s|__HOMER_DIR__|$HOMER_DIR|g" \
  -e "s|__HOMER_USER__|$HOMER_USER|g" \
  -e "s|__HOMER_GROUP__|$HOMER_GROUP|g" \
  -e "s|__HOMER_HOME__|$HOMER_HOME|g" \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__HOMER_APP_BIN__|$HOMER_APP_BIN|g" \
  -e "s|__HOMER_PATH__|$HOMER_PATH|g" \
  "$TEMPLATE_SRC" > "$GENERATED_PLIST"

# Sanity check: no placeholder left behind
if grep -q '__[A-Z_]*__' "$GENERATED_PLIST"; then
  echo -e "${RED}Error:${NC} plist still has unresolved placeholders:"
  grep '__[A-Z_]*__' "$GENERATED_PLIST"
  exit 1
fi
# Sanity check: no /Users/yj leakage (catches templates copied from a private fork)
if grep -q '/Users/yj' "$GENERATED_PLIST"; then
  echo -e "${RED}Error:${NC} generated plist contains hardcoded /Users/yj — template likely needs fixing:"
  grep -n '/Users/yj' "$GENERATED_PLIST"
  exit 1
fi

# --- Install (agent or system) ----------------------------------------------
if [ "$INSTALL_MODE" = "system" ]; then
  if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error:${NC} --system requires sudo."
    echo "  Run: sudo $0 --system"
    exit 1
  fi
  PLIST_DST="/Library/LaunchDaemons/com.homer.daemon.plist"
  LAUNCHD_TARGET="system/com.homer.daemon"

  echo "[1/4] Unloading existing daemon (if any)..."
  launchctl bootout "$LAUNCHD_TARGET" 2>/dev/null || true
  pkill -f "$HOMER_DIR/dist/index.js" 2>/dev/null || true
  sleep 2

  echo "[2/4] Installing plist to $PLIST_DST..."
  cp "$GENERATED_PLIST" "$PLIST_DST"
  chown root:wheel "$PLIST_DST"
  chmod 644 "$PLIST_DST"
  chown -R "$HOMER_USER:$HOMER_GROUP" "$LOGS_DIR"

  echo "[3/4] Loading daemon..."
  launchctl bootstrap system "$PLIST_DST"
  launchctl enable "$LAUNCHD_TARGET"
else
  PLIST_DST="$HOMER_HOME/Library/LaunchAgents/com.homer.daemon.plist"
  LAUNCHD_TARGET="gui/$(id -u)/com.homer.daemon"
  mkdir -p "$(dirname "$PLIST_DST")"

  echo "[1/4] Unloading existing agent (if any)..."
  launchctl bootout "$LAUNCHD_TARGET" 2>/dev/null || true
  sleep 2

  echo "[2/4] Installing plist to $PLIST_DST..."
  cp "$GENERATED_PLIST" "$PLIST_DST"

  echo "[3/4] Loading agent..."
  launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
fi

echo "[4/4] Verifying..."
sleep 3
if curl -s --max-time 10 http://127.0.0.1:3000/health > /dev/null 2>&1; then
  echo -e "${GREEN}✓ Homer is running and healthy.${NC}"
else
  echo -e "${YELLOW}⚠ Homer may still be starting. Check logs:${NC}"
  echo "    tail -f $LOGS_DIR/stdout.log"
fi

echo ""
echo "=== Status ==="
launchctl print "$LAUNCHD_TARGET" 2>/dev/null | grep -E "state|pid|last exit" || true

echo ""
echo "=== Commands ==="
if [ "$INSTALL_MODE" = "system" ]; then
  echo "  Restart: sudo launchctl kickstart -k $LAUNCHD_TARGET"
  echo "  Stop:    sudo launchctl bootout $LAUNCHD_TARGET"
  echo "  Status:  sudo launchctl print $LAUNCHD_TARGET"
else
  echo "  Restart: launchctl kickstart -k $LAUNCHD_TARGET"
  echo "  Stop:    launchctl bootout $LAUNCHD_TARGET"
  echo "  Status:  launchctl print $LAUNCHD_TARGET"
fi
echo "  Logs:    tail -f $LOGS_DIR/stdout.log"
echo ""
echo -e "${GREEN}✓ Installation complete.${NC}"
