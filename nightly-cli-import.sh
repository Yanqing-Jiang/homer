#!/bin/bash
#
# Nightly CLI Session Import
# Runs at 11:45 PM daily to import CLI sessions from the past day
#
# Install to crontab:
#   45 23 * * * /Users/yj/homer/nightly-cli-import.sh >> /Users/yj/homer/logs/nightly-cli-import.log 2>&1
#

set -euo pipefail

echo "========================================"
echo "Nightly CLI Import - $(date)"
echo "========================================"

cd /Users/yj/homer

# Import CLI sessions from last 2 days (to catch any stragglers)
echo "Importing CLI sessions..."
node --loader ts-node/esm src/cli-sessions/import-cli.ts --since 2

echo ""
echo "✅ Nightly CLI import completed at $(date)"
echo ""
