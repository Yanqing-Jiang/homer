import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { StateManager } from "../state/manager.js";
import { QueueManager } from "../queue/manager.js";
import { readFileSync } from "fs";
import { config } from "../config/index.js";
import type { Scheduler, RegisteredJob } from "../scheduler/index.js";

// Scheduler reference (set after initialization)
let schedulerRef: Scheduler | null = null;

export function setWebScheduler(scheduler: Scheduler): void {
  schedulerRef = scheduler;
}

// Store recent log entries for SSE
const recentLogs: string[] = [];
const MAX_LOG_ENTRIES = 100;

export function createRoutes(
  server: FastifyInstance,
  stateManager: StateManager,
  queueManager: QueueManager
): void {
  // Health check
  server.get("/health", async () => {
    return { status: "ok", uptime: process.uptime() };
  });

  // API: Get active sessions
  server.get("/api/sessions", async () => {
    const sessions = stateManager.getActiveSessions();
    return sessions.map((s) => ({
      id: s.id,
      lane: s.lane,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      messageCount: s.messageCount,
      claudeSessionId: stateManager.getClaudeSessionId(s.lane),
      ageMinutes: Math.round((Date.now() - s.lastActivityAt) / 1000 / 60),
    }));
  });

  // API: Get job queue
  server.get("/api/jobs", async (request: FastifyRequest) => {
    const query = request.query as { limit?: string };
    const limit = parseInt(query.limit ?? "50", 10);
    const jobs = queueManager.getRecentJobs(limit);
    return jobs.map((j) => ({
      ...j,
      ageMinutes: j.createdAt ? Math.round((Date.now() - j.createdAt) / 1000 / 60) : null,
      durationMs: j.startedAt && j.completedAt ? j.completedAt - j.startedAt : null,
    }));
  });

  // API: Get job stats
  server.get("/api/stats", async () => {
    const sessions = stateManager.getActiveSessions();
    const jobStats = queueManager.getStats();

    return {
      sessions: {
        active: sessions.length,
        byLane: sessions.reduce(
          (acc, s) => {
            acc[s.lane] = (acc[s.lane] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        ),
      },
      jobs: jobStats,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    };
  });

  // API: Get recent logs (SSE)
  server.get("/api/logs/stream", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send recent logs first
    for (const log of recentLogs) {
      reply.raw.write(`data: ${log}\n\n`);
    }

    // Watch log file for changes
    const logPath = `${config.paths.logs}/stdout.log`;
    let lastSize = 0;

    const checkLogs = () => {
      try {
        const content = readFileSync(logPath, "utf-8");
        if (content.length > lastSize) {
          const newContent = content.slice(lastSize);
          const lines = newContent.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            reply.raw.write(`data: ${line}\n\n`);
            addLogEntry(line);
          }
          lastSize = content.length;
        }
      } catch {
        // Log file might not exist yet
      }
    };

    const interval = setInterval(checkLogs, 1000);

    request.raw.on("close", () => {
      clearInterval(interval);
    });
  });

  // API: Get all scheduled jobs with state
  server.get("/api/scheduled-jobs", async () => {
    if (!schedulerRef) {
      return { error: "Scheduler not initialized", jobs: [] };
    }

    const jobs = schedulerRef.getJobs();
    return jobs.map((job) => {
      const state = stateManager.getScheduledJobState(job.config.id);
      return {
        id: job.config.id,
        name: job.config.name,
        cron: job.config.cron,
        lane: job.config.lane,
        enabled: job.config.enabled,
        timeout: job.config.timeout,
        sourceFile: job.sourceFile,
        lastRun: job.lastRun?.toISOString() ?? null,
        lastSuccess: job.lastSuccess?.toISOString() ?? null,
        consecutiveFailures: job.consecutiveFailures,
        state: state
          ? {
              lastRunAt: state.lastRunAt,
              lastSuccessAt: state.lastSuccessAt,
              consecutiveFailures: state.consecutiveFailures,
            }
          : null,
      };
    });
  });

  // API: Get job history
  server.get("/api/scheduled-jobs/:id/history", async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const query = request.query as { limit?: string };
    const limit = parseInt(query.limit ?? "10", 10);

    const runs = stateManager.getRecentScheduledJobRuns(id, limit);
    return runs.map((run) => ({
      id: run.id,
      jobId: run.jobId,
      jobName: run.jobName,
      sourceFile: run.sourceFile,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      success: run.success === 1,
      output: run.output?.slice(0, 500), // Truncate output for API
      error: run.error,
      exitCode: run.exitCode,
    }));
  });

  // API: Manually trigger a job
  server.post("/api/scheduled-jobs/:id/trigger", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!schedulerRef) {
      reply.status(503);
      return { error: "Scheduler not initialized", success: false };
    }

    const { id } = request.params as { id: string };
    const job = schedulerRef.getJob(id);

    if (!job) {
      reply.status(404);
      return { error: "Job not found", success: false };
    }

    const triggered = schedulerRef.triggerJob(id);
    return { success: triggered, jobId: id, jobName: job.config.name };
  });

  // Dashboard HTML
  server.get("/", async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.type("text/html");
    return getDashboardHtml();
  });

  // HTMX partials
  server.get("/partials/sessions", async () => {
    const sessions = stateManager.getActiveSessions();
    return getSessionsPartial(sessions, stateManager);
  });

  server.get("/partials/jobs", async () => {
    const jobs = queueManager.getRecentJobs(20);
    return getJobsPartial(jobs);
  });

  server.get("/partials/stats", async () => {
    const sessions = stateManager.getActiveSessions();
    const jobStats = queueManager.getStats();
    return getStatsPartial(sessions.length, jobStats);
  });

  // HTMX partial for scheduled jobs
  server.get("/partials/scheduled-jobs", async () => {
    if (!schedulerRef) {
      return "<p>Scheduler not initialized</p>";
    }

    const jobs = schedulerRef.getJobs();
    return getScheduledJobsPartial(jobs, stateManager);
  });
}

function addLogEntry(entry: string): void {
  recentLogs.push(entry);
  if (recentLogs.length > MAX_LOG_ENTRIES) {
    recentLogs.shift();
  }
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>H.O.M.E.R Dashboard</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
  <script src="https://unpkg.com/htmx.org@1.9.10"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <style>
    :root {
      --pico-font-size: 14px;
    }
    body { padding: 1rem; }
    .grid { gap: 1rem; }
    .card { padding: 1rem; background: var(--pico-card-background-color); border-radius: var(--pico-border-radius); }
    .card h3 { margin-bottom: 0.5rem; font-size: 1rem; }
    .status-badge {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: bold;
    }
    .status-pending { background: #fbbf24; color: #000; }
    .status-running { background: #3b82f6; color: #fff; }
    .status-completed { background: #22c55e; color: #fff; }
    .status-failed { background: #ef4444; color: #fff; }
    .log-container {
      background: #1a1a1a;
      padding: 0.5rem;
      border-radius: 4px;
      max-height: 300px;
      overflow-y: auto;
      font-family: monospace;
      font-size: 0.75rem;
      line-height: 1.4;
    }
    .log-entry { margin: 0; white-space: pre-wrap; word-break: break-all; }
    .lane-work { border-left: 3px solid #3b82f6; padding-left: 0.5rem; }
    .lane-invest { border-left: 3px solid #22c55e; padding-left: 0.5rem; }
    .lane-personal { border-left: 3px solid #a855f7; padding-left: 0.5rem; }
    .lane-learning { border-left: 3px solid #f59e0b; padding-left: 0.5rem; }
    table { font-size: 0.85rem; }
    th, td { padding: 0.5rem !important; }
  </style>
</head>
<body>
  <main class="container-fluid">
    <h1>H.O.M.E.R Dashboard</h1>
    <p>Hybrid Orchestration for Multi-model Execution and Routing</p>

    <div class="grid">
      <!-- Stats -->
      <div class="card" hx-get="/partials/stats" hx-trigger="load, every 5s" hx-swap="innerHTML">
        <h3>Loading stats...</h3>
      </div>
    </div>

    <div class="grid" style="margin-top: 1rem;">
      <!-- Sessions -->
      <div class="card">
        <h3>Active Sessions</h3>
        <div hx-get="/partials/sessions" hx-trigger="load, every 10s" hx-swap="innerHTML">
          Loading sessions...
        </div>
      </div>

      <!-- Jobs -->
      <div class="card">
        <h3>Recent Jobs</h3>
        <div hx-get="/partials/jobs" hx-trigger="load, every 5s" hx-swap="innerHTML">
          Loading jobs...
        </div>
      </div>
    </div>

    <!-- Scheduled Jobs -->
    <div class="card" style="margin-top: 1rem;">
      <h3>Scheduled Jobs</h3>
      <div hx-get="/partials/scheduled-jobs" hx-trigger="load, every 30s" hx-swap="innerHTML">
        Loading scheduled jobs...
      </div>
    </div>

    <!-- Logs -->
    <div class="card" style="margin-top: 1rem;" x-data="{ logs: [] }" x-init="
      const es = new EventSource('/api/logs/stream');
      es.onmessage = (e) => {
        logs.push(e.data);
        if (logs.length > 50) logs.shift();
        $nextTick(() => {
          const container = $refs.logContainer;
          container.scrollTop = container.scrollHeight;
        });
      };
    ">
      <h3>Live Logs</h3>
      <div class="log-container" x-ref="logContainer">
        <template x-for="(log, i) in logs" :key="i">
          <p class="log-entry" x-text="log"></p>
        </template>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function getSessionsPartial(sessions: ReturnType<StateManager["getActiveSessions"]>, stateManager: StateManager): string {
  if (sessions.length === 0) {
    return "<p>No active sessions</p>";
  }

  const rows = sessions
    .map((s) => {
      const age = Math.round((Date.now() - s.lastActivityAt) / 1000 / 60);
      const claudeId = stateManager.getClaudeSessionId(s.lane);
      return `
        <tr class="lane-${s.lane}">
          <td><strong>${s.lane}</strong></td>
          <td>${age}m ago</td>
          <td>${s.messageCount}</td>
          <td>${claudeId ? claudeId.slice(0, 8) + "..." : "-"}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <table>
      <thead>
        <tr><th>Lane</th><th>Last Active</th><th>Messages</th><th>Claude ID</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function getJobsPartial(jobs: ReturnType<QueueManager["getRecentJobs"]>): string {
  if (jobs.length === 0) {
    return "<p>No jobs</p>";
  }

  const rows = jobs
    .slice(0, 20)
    .map((j) => {
      const age = j.createdAt ? Math.round((Date.now() - j.createdAt) / 1000 / 60) : 0;
      const queryPreview = j.query.slice(0, 30) + (j.query.length > 30 ? "..." : "");
      return `
        <tr class="lane-${j.lane}">
          <td><span class="status-badge status-${j.status}">${j.status}</span></td>
          <td>${j.lane}</td>
          <td>${queryPreview}</td>
          <td>${age}m ago</td>
        </tr>
      `;
    })
    .join("");

  return `
    <table>
      <thead>
        <tr><th>Status</th><th>Lane</th><th>Query</th><th>Age</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function getStatsPartial(
  activeSessions: number,
  jobStats: { pending: number; running: number; completed: number; failed: number }
): string {
  const uptimeMinutes = Math.round(process.uptime() / 60);
  const mem = process.memoryUsage();
  const memMb = Math.round(mem.heapUsed / 1024 / 1024);

  return `
    <div class="grid">
      <div>
        <h3>${activeSessions}</h3>
        <small>Active Sessions</small>
      </div>
      <div>
        <h3>${jobStats.pending}</h3>
        <small>Pending Jobs</small>
      </div>
      <div>
        <h3>${jobStats.running}</h3>
        <small>Running Jobs</small>
      </div>
      <div>
        <h3>${jobStats.completed}</h3>
        <small>Completed Jobs</small>
      </div>
      <div>
        <h3>${uptimeMinutes}m</h3>
        <small>Uptime</small>
      </div>
      <div>
        <h3>${memMb}MB</h3>
        <small>Memory</small>
      </div>
    </div>
  `;
}

function getScheduledJobsPartial(
  jobs: RegisteredJob[],
  _stateManager: StateManager
): string {
  if (jobs.length === 0) {
    return "<p>No scheduled jobs configured</p>";
  }

  const rows = jobs
    .map((job) => {
      const status = job.config.enabled ? "✅" : "⏸️";
      const lastRun = job.lastRun
        ? formatTimeAgo(job.lastRun)
        : "never";
      const failures = job.consecutiveFailures > 0
        ? `<span class="status-badge status-failed">${job.consecutiveFailures} fail</span>`
        : "";

      return `
        <tr class="lane-${job.config.lane}">
          <td>${status}</td>
          <td><strong>${job.config.id}</strong><br><small>${job.config.name}</small></td>
          <td><code>${job.config.cron}</code></td>
          <td>${job.config.lane}</td>
          <td>${lastRun} ${failures}</td>
          <td>
            <button
              hx-post="/api/scheduled-jobs/${job.config.id}/trigger"
              hx-swap="none"
              hx-confirm="Trigger ${job.config.name}?"
              class="outline"
              style="padding: 0.25rem 0.5rem; font-size: 0.75rem;"
            >
              Run
            </button>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <table>
      <thead>
        <tr>
          <th></th>
          <th>Job</th>
          <th>Schedule</th>
          <th>Lane</th>
          <th>Last Run</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}
