# Homer Daemon: Bulletproof 24/7 Operation

**Date:** 2026-01-31
**Status:** IMPLEMENTED

---

## Root Cause Analysis

### The Problem
Homer daemon was stuck in a crash loop, unable to acquire the flock() lock even after all visible Homer processes were killed.

### Root Cause (Consensus from Codex + Gemini Pro + Gemini Flash)

**File descriptor inheritance without `FD_CLOEXEC`**: When Homer spawns child processes (Claude CLI, connectivity monitors, etc.), the lock file descriptor was inherited via `fork()`. When the parent Homer process died (SIGKILL, crash), orphaned child processes kept the FD open, preventing `flock()` from releasing.

Key insight: `flock()` locks are released on the **last close** of the file descriptor. If any child process still has the FD, the lock persists.

### Why It Looked Like "Zombie Locks"
- `lsof` showed PIDs holding the lock file
- Those PIDs weren't Homer - they were orphaned child processes (Claude CLI, monitors)
- Killing Homer didn't help because children kept the FD
- New Homer instances got `EAGAIN` from flock()
- Watchdog kept restarting, creating more zombies

---

## Defense-in-Depth Strategy (Implemented)

### Layer 1: FD_CLOEXEC on Lock File
- **File:** `src/daemon/lock.ts`
- **Fix:** Set `FD_CLOEXEC` via `fcntlSync()` immediately after opening lock file
- **Effect:** Child processes don't inherit the lock FD

```typescript
// After opening lock file
fcntlSync(lockFd, "setfd", fsExtConstants.FD_CLOEXEC);
```

### Layer 2: Exit 0 on Lock Failure
- **File:** `src/index.ts`
- **Fix:** Wrap lock acquisition in try-catch, always exit with code 0
- **Effect:** launchd won't restart (SuccessfulExit=false)

```typescript
try {
  const lockAcquired = acquireDaemonLock();
  if (!lockAcquired) {
    process.exit(0); // Clean exit
  }
} catch (lockErr) {
  process.exit(0); // Exit 0 even on error
}
```

### Layer 3: Watchdog Stale Lock Cleanup
- **File:** `scripts/watchdog.sh`
- **Fix:** Before restarting, check for stale lock holders and kill them
- **Effect:** Breaks the crash loop by cleaning orphaned children

```bash
cleanup_stale_lock() {
  holders=$(lsof -n -t -- "$LOCK_FILE")
  for p in $holders; do
    if ps -o command= -p "$p" | grep -Eq "homer|claude|node"; then
      kill -9 "$p"
    fi
  done
}
```

### Layer 4: launchd Configuration
- **File:** `~/Library/LaunchAgents/com.homer.daemon.plist`
- **Fixes:**
  - `ThrottleInterval=30`: Prevent rapid restart loops
  - `ExitTimeOut=30`: Allow graceful shutdown
  - `AbandonProcessGroup=false`: Kill children when parent dies

---

## What Must Be True for 24/7 Reliability

| Requirement | Implementation | Verified |
|-------------|----------------|----------|
| Lock FD has FD_CLOEXEC | `fcntlSync(lockFd, "setfd", FD_CLOEXEC)` | ✅ |
| Lock failure exits 0 | `process.exit(0)` on any lock error | ✅ |
| launchd doesn't restart on exit 0 | `SuccessfulExit=false` | ✅ |
| Restart throttling | `ThrottleInterval=30` | ✅ |
| Graceful shutdown time | `ExitTimeOut=30` | ✅ |
| Children killed on parent death | `AbandonProcessGroup=false` | ✅ |
| Watchdog cleans stale locks | `cleanup_stale_lock()` before restart | ✅ |
| Lock file has diagnostics | PID, PPID, timestamp, exec path | ✅ |

---

## Files Modified

1. `src/daemon/lock.ts` - Added FD_CLOEXEC, better diagnostics
2. `src/index.ts` - Try-catch for lock, exit 0 on failure
3. `scripts/watchdog.sh` - Stale lock cleanup
4. `~/Library/LaunchAgents/com.homer.daemon.plist` - ThrottleInterval, ExitTimeOut

---

## Monitoring

### Check Lock Status
```bash
# Who holds the lock?
lsof -n -t -- "$HOME/Library/Application Support/Homer/homer.lock"

# Lock file contents
cat "$HOME/Library/Application Support/Homer/homer.lock"
```

### Check for Crash Loop
```bash
# Recent fatal log entries
tail -20 ~/Library/Logs/homer/fatal.log

# Watchdog failures
grep "health failed" ~/Library/Logs/homer/watchdog.log | tail -10
```

### Manual Recovery
```bash
# Full cleanup
launchctl bootout gui/501/com.homer.daemon
pkill -9 -f "homer/dist/index.js"
rm -f "$HOME/Library/Application Support/Homer/homer.lock"
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.homer.daemon.plist
```

---

## Future Improvements (Not Yet Implemented)

1. **BullMQ Migration** - Persistent job queue with Redis
2. **Unix Domain Socket** - Secondary single-instance check with IPC
3. **Health Alerts** - Telegram notifications on repeated failures
4. **Metrics** - Track lock acquisition failures, restart counts

---

## References

- Codex analysis: `~/Desktop/codex-output/20260131_222041_daemon-crash-analysis.md`
- Gemini Pro research: `~/Desktop/gemini-output/20260131_222050_nodejs-daemon-macos-reliability.md`
- OpenClaw patterns: `~/homer/docs/OPENCLAW_RESEARCH.md`
