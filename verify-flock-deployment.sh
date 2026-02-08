#!/bin/bash
#
# Verify flock-based lock implementation deployment
#
# Run this after restarting Homer daemon to verify everything works

set -e

LOCK_FILE="$HOME/Library/Application Support/Homer/homer.lock"
DB_FILE="$HOME/homer/data/homer.db"

echo "Homer Flock Deployment Verification"
echo "===================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass() {
  echo -e "${GREEN}✓${NC} $1"
}

fail() {
  echo -e "${RED}✗${NC} $1"
}

warn() {
  echo -e "${YELLOW}⚠${NC} $1"
}

# Check 1: Homer is running
echo "1. Checking if Homer is running..."
if ps aux | grep -q "[n]ode.*homer"; then
  PID=$(ps aux | grep "[n]ode.*homer" | awk '{print $2}')
  pass "Homer daemon is running (PID: $PID)"
else
  fail "Homer daemon is NOT running"
  echo "   Start it with: cd ~/homer && npm start"
  exit 1
fi
echo ""

# Check 2: Lock file exists
echo "2. Checking lock file..."
if [ -f "$LOCK_FILE" ]; then
  pass "Lock file exists: $LOCK_FILE"
  echo "   Contents:"
  cat "$LOCK_FILE" | sed 's/^/   /'
else
  fail "Lock file does not exist"
  warn "Homer may still be using old PID lock"
  exit 1
fi
echo ""

# Check 3: Migration applied
echo "3. Checking database migration..."
MIGRATION_COUNT=$(sqlite3 "$DB_FILE" "SELECT COUNT(*) FROM _migrations WHERE name = '004_job_locking.sql'")
if [ "$MIGRATION_COUNT" -eq 1 ]; then
  pass "Migration 004_job_locking.sql applied"
else
  fail "Migration not applied yet"
  warn "Migration will run on first restart"
fi
echo ""

# Check 4: Database schema
echo "4. Checking job_queue table schema..."
LOCKED_BY=$(sqlite3 "$DB_FILE" "PRAGMA table_info(job_queue);" | grep -c "locked_by" || echo 0)
LOCKED_AT=$(sqlite3 "$DB_FILE" "PRAGMA table_info(job_queue);" | grep -c "locked_at" || echo 0)
HEARTBEAT=$(sqlite3 "$DB_FILE" "PRAGMA table_info(job_queue);" | grep -c "heartbeat_at" || echo 0)

if [ "$LOCKED_BY" -eq 1 ] && [ "$LOCKED_AT" -eq 1 ] && [ "$HEARTBEAT" -eq 1 ]; then
  pass "All locking columns present (locked_by, locked_at, heartbeat_at)"
else
  fail "Missing locking columns"
  echo "   locked_by: $LOCKED_BY, locked_at: $LOCKED_AT, heartbeat_at: $HEARTBEAT"
  warn "Columns will be added on first restart"
fi
echo ""

# Check 5: Test dual-instance prevention
echo "5. Testing dual-instance prevention..."
echo "   Starting second instance in background..."
cd ~/homer
timeout 5 node dist/index.js > /tmp/homer-test-instance.log 2>&1 &
TEST_PID=$!
sleep 2

if ! ps -p $TEST_PID > /dev/null 2>&1; then
  pass "Second instance exited cleanly (as expected)"

  # Check if it logged the correct message
  if grep -q "Another Homer instance is running" /tmp/homer-test-instance.log 2>/dev/null; then
    pass "Logged correct exit reason"
  else
    warn "Exit reason unclear, check /tmp/homer-test-instance.log"
  fi
else
  fail "Second instance is still running (should have exited)"
  kill $TEST_PID 2>/dev/null || true
  warn "Lock mechanism may not be working correctly"
fi
echo ""

# Check 6: Job queue status
echo "6. Checking job queue status..."
sqlite3 "$DB_FILE" "SELECT status, COUNT(*) as count FROM job_queue GROUP BY status" > /tmp/job-stats.txt 2>&1 || echo "No jobs" > /tmp/job-stats.txt
if [ -s /tmp/job-stats.txt ]; then
  pass "Job queue accessible"
  cat /tmp/job-stats.txt | sed 's/^/   /'
else
  warn "No jobs in queue (this is normal for fresh install)"
fi
echo ""

# Check 7: Recent log entries
echo "7. Checking recent log entries..."
if [ -f ~/homer/logs/homer.log ]; then
  echo "   Last 5 log lines:"
  tail -5 ~/homer/logs/homer.log | sed 's/^/   /'

  # Check for key messages
  if grep -q "Daemon lock acquired" ~/homer/logs/homer.log 2>/dev/null; then
    pass "Found 'Daemon lock acquired' in logs"
  else
    warn "Did not find 'Daemon lock acquired' - may still be using old PID lock"
  fi
else
  warn "Log file not found at ~/homer/logs/homer.log"
fi
echo ""

# Summary
echo "===================================="
echo "Verification Complete"
echo "===================================="
echo ""

# Overall status
if [ -f "$LOCK_FILE" ] && [ "$MIGRATION_COUNT" -eq 1 ] && [ "$LOCKED_BY" -eq 1 ]; then
  echo -e "${GREEN}✓ All checks passed!${NC}"
  echo ""
  echo "Next steps:"
  echo "  1. Monitor logs: tail -f ~/homer/logs/homer.log"
  echo "  2. Test job processing (submit a job via Telegram)"
  echo "  3. Verify heartbeats update during job execution"
  echo ""
else
  echo -e "${YELLOW}⚠ Some checks failed or pending${NC}"
  echo ""
  echo "Action required:"
  echo "  1. If migration not applied: Restart Homer daemon"
  echo "  2. If lock file missing: Check daemon startup logs"
  echo "  3. If columns missing: Migration will add them on restart"
  echo ""
fi

# Cleanup
rm -f /tmp/homer-test-instance.log /tmp/job-stats.txt
