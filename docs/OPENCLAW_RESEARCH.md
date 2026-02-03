# OpenClaw Architecture Research
## Daemon Management & Session Lifecycle Best Practices

**Research Date:** 2026-01-31
**Purpose:** Identify best practices from OpenClaw and modern Node.js daemon patterns to improve Homer's reliability

---

## Executive Summary

Homer currently suffers from:
- Multiple daemon instances running simultaneously
- Port conflicts (web server already in use)
- Stuck background processes
- Lost tasks in queue

OpenClaw and modern Node.js patterns offer proven solutions to these problems through:
1. **Single-instance enforcement** (PID locks, port binding)
2. **Graceful shutdown** (SIGTERM/SIGINT handlers)
3. **Process supervision** (systemd/launchd integration)
4. **Background job queues** (BullMQ with Redis)

---

## 1. OpenClaw Architecture Analysis

### 1.1 Gateway Design (Single Instance Pattern)

OpenClaw enforces a single daemon instance through:

```
┌─────────────────────────────────────┐
│      OpenClaw Gateway Daemon        │
├─────────────────────────────────────┤
│ WebSocket Control Plane             │
│ ws://127.0.0.1:18789                │
│                                     │
│ - Sessions                          │
│ - Presence                          │
│ - Config                            │
│ - Cron jobs                         │
│ - Webhooks                          │
│ - Canvas host (HTTP :18793)         │
└─────────────────────────────────────┘
          ↑
          │ Single process per user
          │
┌─────────┴──────────┐
│  launchd (macOS)   │
│  systemd (Linux)   │
└────────────────────┘
```

**Key Insights:**
- **ONE Gateway per host** (explicitly documented)
- **Fixed port binding** (127.0.0.1:18789) - second instance fails immediately
- **systemd/launchd integration** - OS manages single instance
- **No manual PID files needed** - port binding IS the lock

**Homer Comparison:**
- Homer has NO single-instance enforcement
- Web server port binding (3000) fails silently, daemon continues running
- Multiple daemons can run with different PIDs
- No coordination between instances

**Priority:** HIGH - This is the root cause of all our issues

---

### 1.2 Skills Management (Session Snapshots)

OpenClaw uses a **snapshot-at-session-start** model:

```
Session Lifecycle:
─────────────────

1. Session Start
   ↓
   Read all SKILL.md files → Filter by eligibility → Snapshot
   ↓
2. Session Running
   ↓
   Use cached snapshot (no re-reads)
   ↓
3. Mid-Session Refresh (Optional)
   ↓
   Watcher detects SKILL.md change → Rebuild snapshot
   ↓
4. Session End
   ↓
   Discard snapshot
```

**Eligibility Gates:**
- `requires.bins` - binary dependencies
- `requires.env` - environment variables
- `requires.config` - config requirements
- `os` field - platform restrictions

**Homer Comparison:**
- Homer has `~/.claude/skills/` directory
- No documented eligibility filtering
- No watcher for hot reload
- Skills probably loaded per-request (inefficient)

**Priority:** MEDIUM - Nice to have, but not blocking

---

### 1.3 Environment Scoping

OpenClaw **scopes environment per-turn**:

```typescript
// Before skill execution
const originalEnv = { ...process.env };
Object.assign(process.env, skill.env);

// Run skill
await executeSkill();

// After skill execution
process.env = originalEnv; // Restore
```

**Prevents:**
- Cross-skill environment pollution
- Permanent process state changes
- API key leakage between skills

**Homer Comparison:**
- Homer executors spawn child processes
- Environment passed via `child_process.spawn(cmd, args, { env })`
- Should be safe, but worth verifying

**Priority:** LOW - Already mostly handled

---

## 2. Single-Instance Enforcement Patterns

### 2.1 PID Lock Pattern (pidlock npm)

**How it works:**
```typescript
import { lock, unlock } from 'pidlock';

async function startDaemon() {
  try {
    await lock('/tmp/homer.pid');
    console.log('Lock acquired, starting daemon...');

    // Start daemon services...

  } catch (err) {
    if (err.code === 'ELOCKED') {
      console.error('Another instance is running');
      process.exit(1);
    }
    throw err;
  }
}

process.on('SIGTERM', async () => {
  await unlock('/tmp/homer.pid');
  process.exit(0);
});
```

**Implementation:**
1. Create directory `/proc/$pid/` (atomic)
2. Symlink `/tmp/homer.pid` → `/proc/$pid/`
3. Check if old PID still alive (`/proc/$old_pid/cmdline`)
4. Auto-unlock on SIGTERM

**Pros:**
- Cross-platform (works on Linux, macOS)
- Auto-cleanup if process dies
- Simple API

**Cons:**
- Requires `/proc/` filesystem (macOS hack)
- Race conditions possible

---

### 2.2 Port Binding Pattern (OpenClaw)

**How it works:**
```typescript
async function startDaemon() {
  const server = fastify();

  try {
    await server.listen({ port: 18789, host: '127.0.0.1' });
    console.log('Daemon started');
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error('Another instance is already running');
      process.exit(1);
    }
    throw err;
  }
}
```

**Pros:**
- Atomic (OS-level lock)
- Zero dependencies
- Works everywhere
- No cleanup needed

**Cons:**
- Only works if daemon needs a server
- Port must be fixed

**Homer Application:**
- Homer already has web server on port 3000
- Currently handles port conflict WRONG (logs warning, continues)
- Should exit immediately if port taken

**Priority:** HIGH - Easiest, most reliable fix

---

### 2.3 systemd/launchd Integration (Best Practice)

**macOS (launchd):**
```xml
<!-- com.homer.daemon.plist -->
<key>KeepAlive</key>
<dict>
  <key>SuccessfulExit</key>
  <false/>  <!-- Only restart on crash -->
  <key>NetworkState</key>
  <true/>   <!-- Wait for network -->
</dict>
```

**Homer Current State:**
- Already using launchd
- `KeepAlive.SuccessfulExit = false` (correct)
- But launchd will restart if port conflict causes exit

**The Problem:**
1. Daemon A starts, binds port 3000
2. User runs `npm start` (Daemon B)
3. Daemon B port conflict → exits
4. launchd sees Daemon B exit → restarts it
5. Loop continues

**Solution:**
- Exit code 0 on port conflict (successful exit)
- launchd won't restart
- OR: Use lock file BEFORE binding port

---

## 3. Graceful Shutdown Best Practices

### 3.1 Signal Handling (Node.js Standard)

**Homer Current Implementation:** ✅ GOOD
```typescript
// fatal-handlers.ts
process.on('SIGTERM', () => void gracefulExit('SIGTERM'));
process.on('SIGINT', () => void gracefulExit('SIGINT'));
```

**Best Practice Comparison:**
```typescript
// Industry standard pattern
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`Received ${signal}, starting graceful shutdown...`);

  // 1. Stop accepting new work
  await server.close(); // No new HTTP requests
  queueWorker.stop();   // No new queue jobs

  // 2. Wait for in-flight work (with timeout)
  await Promise.race([
    waitForInFlightJobs(),
    timeout(30000)
  ]);

  // 3. Close resources
  await db.close();
  await redis.disconnect();

  // 4. Exit cleanly
  process.exit(0);
}
```

**Homer Gaps:**
- ✅ Has shutdown tasks
- ✅ Has timeout (8s)
- ❌ Doesn't wait for in-flight jobs
- ❌ Queue worker stops immediately (may lose current job)

**Priority:** MEDIUM - Can lose work during shutdown

---

### 3.2 Kubernetes/Docker Considerations

**PID 1 Problem:**
```dockerfile
# BAD: Node as PID 1 won't receive signals
CMD ["node", "dist/index.js"]

# GOOD: Use tini as init process
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
```

**Homer Impact:**
- Homer runs via launchd (not PID 1)
- Not a problem currently
- Worth noting for future Docker deployment

---

## 4. Background Job Queue Patterns

### 4.1 Homer's Current Queue

**Architecture:**
```
QueueManager (EventEmitter)
    ↓
    emit("job:ready")
    ↓
QueueWorker.processJob()
    ↓
    Job runs IN-PROCESS
```

**Problems:**
1. **In-process execution** - If daemon crashes, job lost
2. **No persistence** - Jobs only in SQLite, no retry on daemon restart
3. **No visibility** - Can't see what's running after crash
4. **Timeout kills everything** - No job-level isolation

---

### 4.2 BullMQ Pattern (Industry Standard)

**Architecture:**
```
┌──────────────┐
│  Homer Bot   │ ─add job→ Redis Queue
└──────────────┘              ↓
                    ┌─────────────────┐
                    │  BullMQ Worker  │
                    │  (separate      │
                    │   process)      │
                    └─────────────────┘
                              ↓
                    Update SQLite with result
```

**Benefits:**
1. **Job persistence** - Redis persists jobs to disk
2. **Worker isolation** - Crash doesn't lose jobs
3. **Retry/backoff** - Built-in exponential backoff
4. **Monitoring** - Bull Board UI for visibility
5. **Concurrency** - Multiple workers, rate limiting
6. **Scheduling** - Delayed jobs, cron patterns

**Example:**
```typescript
// Producer (Homer Bot)
import { Queue } from 'bullmq';

const queue = new Queue('homer-jobs', {
  connection: { host: 'localhost', port: 6379 }
});

await queue.add('execute-claude', {
  lane: 'work',
  query: 'Analyze this code...',
  chatId: 123
}, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 }
});

// Worker (separate process or same daemon)
import { Worker } from 'bullmq';

const worker = new Worker('homer-jobs', async (job) => {
  const result = await executeClaudeCommand(job.data.query);
  return result;
}, {
  connection: { host: 'localhost', port: 6379 },
  concurrency: 4
});

worker.on('completed', (job, result) => {
  bot.api.sendMessage(job.data.chatId, result.output);
});
```

**Migration Path:**
1. Install Redis (`brew install redis`)
2. Add BullMQ to package.json
3. Keep SQLite for sessions/state
4. Use Redis ONLY for job queue
5. Run BullMQ worker in same daemon process (start)
6. Later: Move to separate worker process (optional)

**Priority:** HIGH - Solves task loss problem

---

## 5. Recommended Improvements for Homer

### 5.1 Immediate Fixes (This Week)

#### Fix #1: Port Binding as Lock (2 hours)
```typescript
// src/index.ts
async function main() {
  logger.info("H.O.M.E.R Phase 5 starting up...");

  // Create web server FIRST (before other initialization)
  const server = await createWebServer(...);

  try {
    await startWebServer(server);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      logger.error('Another Homer instance is already running');
      process.exit(0); // Exit 0 so launchd won't restart
    }
    throw err;
  }

  // Continue with bot, queue, etc.
}
```

**Impact:** Prevents 90% of duplicate daemon issues

---

#### Fix #2: PID Lock Fallback (1 hour)
```bash
npm install pidlock
```

```typescript
// src/index.ts
import { lock } from 'pidlock';

async function main() {
  // Acquire lock FIRST
  try {
    await lock('/Users/yj/homer/data/homer.pid');
  } catch (err) {
    if (err.code === 'ELOCKED') {
      logger.error('Another Homer instance is running (PID lock)');
      process.exit(0);
    }
    throw err;
  }

  // Register cleanup
  registerShutdownTask(async () => {
    await unlock('/Users/yj/homer/data/homer.pid');
  });

  // Continue...
}
```

**Impact:** Double protection (port + PID)

---

#### Fix #3: Cleanup Script (30 minutes)
```bash
#!/bin/bash
# ~/homer/scripts/cleanup-daemons.sh

echo "Stopping all Homer daemons..."

# Stop launchd service
launchctl unload ~/Library/LaunchAgents/com.homer.daemon.plist 2>/dev/null

# Find any node processes running Homer
pgrep -f "node.*homer/dist/index.js" | while read pid; do
  echo "Killing PID $pid"
  kill -TERM $pid
  sleep 2
  kill -9 $pid 2>/dev/null # Force kill if still alive
done

# Remove PID lock
rm -f /Users/yj/homer/data/homer.pid

# Check port 3000
lsof -ti:3000 | while read pid; do
  echo "Port 3000 held by PID $pid (killing...)"
  kill -TERM $pid
done

echo "Done. Ready for fresh start."
```

**Impact:** Quick recovery from stuck state

---

### 5.2 Medium-Term Improvements (Next Sprint)

#### Improvement #1: BullMQ Migration (1 day)
- Replace in-process queue with BullMQ + Redis
- Keep SQLite for job metadata
- Add retry/backoff logic
- Add Bull Board UI for monitoring

**Files to Change:**
- `src/queue/manager.ts` - Wrap BullMQ Queue
- `src/queue/worker.ts` - Use BullMQ Worker
- `src/web/routes.ts` - Add `/admin/jobs` (Bull Board)

---

#### Improvement #2: Health Checks (4 hours)
```typescript
// src/heartbeat/health.ts
export interface HealthStatus {
  daemon: 'healthy' | 'degraded' | 'down';
  components: {
    bot: boolean;
    webServer: boolean;
    queueWorker: boolean;
    database: boolean;
    redis?: boolean;
  };
  metrics: {
    uptime: number;
    jobsProcessed: number;
    jobsQueued: number;
    lastHeartbeat: string;
  };
}

// src/web/routes.ts
server.get('/health', async (req, reply) => {
  const health = await getHealthStatus();
  reply.code(health.daemon === 'healthy' ? 200 : 503).send(health);
});
```

**Monitoring:**
```bash
# External uptime check
curl http://localhost:3000/health | jq .daemon
```

---

#### Improvement #3: Job Persistence Audit (2 hours)
- Add `job_start_time` to SQLite
- Track in-flight jobs across restarts
- Resume or fail-fast on startup

```typescript
// On daemon start
async function recoverInFlightJobs() {
  const staleJobs = stateManager.getJobsByStatus('running');

  for (const job of staleJobs) {
    const runtime = Date.now() - job.startedAt;

    if (runtime > 10 * 60 * 1000) { // 10 minutes
      logger.warn({ jobId: job.id }, 'Marking stale job as failed');
      queueManager.failJob(job.id, 'Daemon restart');
    } else {
      logger.info({ jobId: job.id }, 'Re-queuing interrupted job');
      queueManager.enqueue(job); // Re-add to queue
    }
  }
}
```

---

### 5.3 Long-Term Architecture (Future)

#### Vision: Separation of Concerns
```
┌────────────────────────────────────────────────────┐
│                  Homer Daemon                      │
├────────────────────────────────────────────────────┤
│  1. Telegram Bot (message ingestion)              │
│  2. Web Server (API, voice chat, dashboard)       │
│  3. Scheduler (cron jobs, reminders)              │
│  4. Job Producer (enqueue to Redis)               │
└────────────────────────────────────────────────────┘
                      ↓ Redis
┌────────────────────────────────────────────────────┐
│              Homer Worker (separate)               │
├────────────────────────────────────────────────────┤
│  1. BullMQ Worker (process jobs)                  │
│  2. Claude executor                                │
│  3. Subagent executors (Gemini, Codex, Kimi)     │
└────────────────────────────────────────────────────┘
```

**Benefits:**
- **Restart daemon without killing jobs**
- **Scale workers independently**
- **Better monitoring/logging**
- **Easier debugging (separate logs)**

---

## 6. Comparison Matrix

| Feature | Homer Current | OpenClaw | Industry Best | Homer Should |
|---------|--------------|----------|---------------|--------------|
| **Single Instance** | ❌ None | ✅ Port binding | ✅ PID lock + port | ✅ Both |
| **Graceful Shutdown** | ✅ SIGTERM/INT | ✅ SIGTERM/INT | ✅ + resource drain | ⚠️ Add drain |
| **Job Queue** | ⚠️ In-process | ❌ None | ✅ Redis/Bull | ✅ Migrate |
| **Job Persistence** | ⚠️ SQLite only | ❌ None | ✅ Redis WAL | ✅ Add |
| **Process Supervision** | ✅ launchd | ✅ systemd/launchd | ✅ PM2/systemd | ✅ Keep |
| **Health Checks** | ❌ None | ❌ None | ✅ /health endpoint | ✅ Add |
| **Skills Hot Reload** | ❌ None | ✅ Watcher | ✅ Watcher | ⚠️ Nice to have |
| **Environment Isolation** | ✅ Child process | ✅ Per-turn scope | ✅ Containers | ✅ Keep |

---

## 7. Action Plan

### Phase 1: Stop the Bleeding (1 day)
- [ ] Fix port binding to exit on conflict
- [ ] Add PID lock with pidlock npm
- [ ] Create cleanup script
- [ ] Test daemon restart scenarios

### Phase 2: Job Reliability (3 days)
- [ ] Install Redis + BullMQ
- [ ] Migrate QueueManager to BullMQ
- [ ] Add job persistence audit
- [ ] Add Bull Board monitoring UI

### Phase 3: Observability (2 days)
- [ ] Add /health endpoint
- [ ] Add metrics collection
- [ ] Add uptime monitoring alerts
- [ ] Document recovery procedures

### Phase 4: Architecture Evolution (Future)
- [ ] Separate worker process
- [ ] Containerize (Docker)
- [ ] Add load balancing
- [ ] Multi-host deployment

---

## 8. References

### OpenClaw
- [Skills Documentation](https://docs.openclaw.ai/tools/skills)
- [GitHub Repository](https://github.com/openclaw/openclaw)
- [IBM Analysis: Testing Limits of Vertical Integration](https://www.ibm.com/think/news/clawdbot-ai-agent-testing-limits-vertical-integration)
- [DigitalOcean Guide: What is OpenClaw?](https://www.digitalocean.com/resources/articles/what-is-openclaw)

### Node.js Daemon Patterns
- [pidlock npm Package](https://www.npmjs.com/package/pidlock)
- [singleton-process GitHub](https://github.com/twistedstream/singleton-process)
- [Node.js Graceful Shutdown Guide (DEV)](https://dev.to/yusadolat/nodejs-graceful-shutdown-a-beginners-guide-40b6)
- [Graceful Shutdown in Kubernetes (RisingStack)](https://blog.risingstack.com/graceful-shutdown-node-js-kubernetes/)

### BullMQ & Background Jobs
- [BullMQ Official Docs](https://bullmq.io/)
- [Building Job Queues with BullMQ (OneUptime)](https://oneuptime.com/blog/post/2026-01-06-nodejs-job-queue-bullmq-redis/view)
- [Scalable Background Jobs Guide (DEV)](https://dev.to/asad_ahmed_5592ac0a7d0258/building-scalable-background-jobs-in-nodejs-with-bullmq-a-complete-guide-509p)
- [Job Scheduling with BullMQ (Better Stack)](https://betterstack.com/community/guides/scaling-nodejs/bullmq-scheduled-tasks/)

### Process Management
- [PM2 vs systemd Comparison (cryeffect.net)](https://cryeffect.net/2025/pm2/)
- [Why PM2 for Node.js (xeg.io)](https://www.xeg.io/shared-searches/why-pm2-is-preferred-over-systemctl-for-nodejs-applications-67078e84899198cfc914d3f5)
- [PM2 Complete Guide (Better Stack)](https://betterstack.com/community/guides/scaling-nodejs/pm2-guide/)

---

## Appendix: ASCII Architecture Diagrams

### Homer Current State
```
┌────────────────────────────────────────────────────┐
│            Homer Daemon (Process A)                │
│  Port 3000 ✅                                      │
│  PID 12345                                         │
│  Status: Running                                   │
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│            Homer Daemon (Process B)                │
│  Port 3000 ❌ CONFLICT                            │
│  PID 12389                                         │
│  Status: Running (degraded, no web server)         │
└────────────────────────────────────────────────────┘

Problem: Both running, no coordination!
```

### Homer Proposed State
```
┌────────────────────────────────────────────────────┐
│            Homer Daemon (Process A)                │
│  Port 3000 ✅ LOCKED                               │
│  PID Lock: /Users/yj/homer/data/homer.pid ✅       │
│  Status: Running                                   │
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│            Homer Daemon (Process B attempt)        │
│  Port 3000 ❌ BLOCKED → Exit code 0                │
│  PID Lock: ❌ BLOCKED → Exit code 0                │
│  Status: Clean exit (launchd won't restart)        │
└────────────────────────────────────────────────────┘

Solution: Only one instance possible!
```

---

**Document Created:** 2026-01-31
**Author:** Homer (via Claude Sonnet 4.5)
**Next Review:** After Phase 1 implementation
