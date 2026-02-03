# HOMER Scheduler Migration Strategy

## Executive Summary

This document outlines the migration from the current dual-system architecture (Scheduler + NightSupervisor) to a unified runtime. The migration preserves all existing functionality while enabling new capabilities like intent-based execution, unified discovery, and better observability.

**Current State:**
- `Scheduler` (CronManager) - Runs jobs from `schedule.json` via cron expressions
- `NightSupervisor` - Runs at 1 AM with multi-phase workflow (ingestion -> deep_work -> synthesis -> briefing)
- Separate execution paths, separate state tracking
- Jobs: nightly-memory, morning-brief, ideas-explore, etc.

**Target State:**
- Unified Runtime Loop with configurable tick interval
- Intent-based job representation (all jobs are "intents" with triggers)
- Single execution pipeline with pluggable executors
- DiscoveryEngine replaces NightSupervisor's planning phase
- Unified observability and state tracking

---

## Phase 1: Foundation (Parallel Operation)

**Duration:** 1-2 days
**Risk:** Low
**Rollback:** Delete new tables, no impact on existing system

### 1.1 Database Schema Extension

Create new tables alongside existing `scheduled_job_runs` and `scheduled_job_state`:

```sql
-- ~/homer/src/runtime/schema.sql

-- Intents: Unified job representation
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,

  -- Trigger configuration (JSON)
  -- { "type": "cron", "expression": "0 1 * * *" }
  -- { "type": "event", "event": "idea_added" }
  -- { "type": "interval", "ms": 7200000 }
  trigger_config TEXT NOT NULL,

  -- Execution configuration (JSON)
  -- { "executor": "claude", "model": "sonnet", "timeout": 600000 }
  execution_config TEXT NOT NULL,

  -- Query/prompt template
  query_template TEXT NOT NULL,

  -- Context files (JSON array)
  context_files TEXT,

  -- Lane for cwd resolution
  lane TEXT NOT NULL DEFAULT 'default',

  -- State
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 50,  -- 0-100, higher = more important

  -- Metadata
  source TEXT,  -- 'schedule.json', 'night_plan', 'user', etc.
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_intents_enabled ON intents(enabled);
CREATE INDEX IF NOT EXISTS idx_intents_source ON intents(source);

-- Intent runs: Unified execution history
CREATE TABLE IF NOT EXISTS intent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT NOT NULL,

  -- Trigger info
  triggered_by TEXT NOT NULL,  -- 'cron', 'event:xxx', 'manual', 'discovery'
  triggered_at TEXT NOT NULL,

  -- Execution
  started_at TEXT,
  completed_at TEXT,

  -- Result
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed, cancelled
  success INTEGER,
  output TEXT,
  error TEXT,
  exit_code INTEGER,

  -- Metrics
  duration_ms INTEGER,
  tokens_used INTEGER,
  cost_estimate REAL,

  -- Artifacts (JSON array of file paths)
  artifacts TEXT,

  FOREIGN KEY (intent_id) REFERENCES intents(id)
);

CREATE INDEX IF NOT EXISTS idx_intent_runs_intent ON intent_runs(intent_id);
CREATE INDEX IF NOT EXISTS idx_intent_runs_status ON intent_runs(status);
CREATE INDEX IF NOT EXISTS idx_intent_runs_triggered ON intent_runs(triggered_at);

-- Discovery sessions: Replaces night_mode planning
CREATE TABLE IF NOT EXISTS discovery_sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,

  -- Phase tracking
  phase TEXT NOT NULL DEFAULT 'planning',  -- planning, execution, synthesis

  -- Plan (JSON)
  plan TEXT,

  -- Results
  intents_created INTEGER DEFAULT 0,
  intents_executed INTEGER DEFAULT 0,
  findings TEXT,  -- JSON array

  -- Output artifacts
  morning_briefing TEXT,

  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Feature flags for gradual rollout
CREATE TABLE IF NOT EXISTS runtime_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Initialize default flags
INSERT OR IGNORE INTO runtime_flags (key, value, description) VALUES
  ('runtime.enabled', 'false', 'Master switch for new runtime'),
  ('runtime.scheduler_bridge', 'false', 'Route schedule.json jobs through intent system'),
  ('runtime.discovery_enabled', 'false', 'Enable DiscoveryEngine (replaces NightSupervisor)'),
  ('runtime.parallel_mode', 'true', 'Run old and new systems in parallel for comparison'),
  ('runtime.tick_interval_ms', '60000', 'Runtime loop interval');
```

### 1.2 Unified Executor Interface

```typescript
// ~/homer/src/runtime/executor.ts

import type { IntentRun } from './types.js';

/**
 * Unified executor interface - all executors implement this
 */
export interface Executor {
  name: string;

  /**
   * Execute an intent and return the result
   */
  execute(run: IntentRun, options: ExecutionOptions): Promise<ExecutionResult>;

  /**
   * Check if this executor can handle the given config
   */
  canHandle(config: ExecutionConfig): boolean;
}

export interface ExecutionOptions {
  cwd: string;
  timeout: number;
  contextPrompt?: string;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  duration: number;
  artifacts?: string[];
  tokensUsed?: number;
}

export interface ExecutionConfig {
  executor: 'claude' | 'gemini' | 'kimi';
  model?: string;
  timeout?: number;
  sandbox?: boolean;
  yolo?: boolean;
}

/**
 * Executor registry - maps executor names to implementations
 */
export class ExecutorRegistry {
  private executors: Map<string, Executor> = new Map();

  register(executor: Executor): void {
    this.executors.set(executor.name, executor);
  }

  get(name: string): Executor | undefined {
    return this.executors.get(name);
  }

  findExecutor(config: ExecutionConfig): Executor | undefined {
    for (const executor of this.executors.values()) {
      if (executor.canHandle(config)) {
        return executor;
      }
    }
    return undefined;
  }
}
```

### 1.3 Intent Manager

```typescript
// ~/homer/src/runtime/intent-manager.ts

import type Database from 'better-sqlite3';
import type { Intent, IntentRun, TriggerConfig } from './types.js';
import { logger } from '../utils/logger.js';

export class IntentManager {
  constructor(private db: Database.Database) {}

  /**
   * Create a new intent
   */
  create(intent: Omit<Intent, 'id' | 'created_at' | 'updated_at'>): Intent {
    const id = `intent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this.db.prepare(`
      INSERT INTO intents (
        id, name, description, trigger_config, execution_config,
        query_template, context_files, lane, enabled, priority, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      intent.name,
      intent.description || null,
      JSON.stringify(intent.triggerConfig),
      JSON.stringify(intent.executionConfig),
      intent.queryTemplate,
      intent.contextFiles ? JSON.stringify(intent.contextFiles) : null,
      intent.lane,
      intent.enabled ? 1 : 0,
      intent.priority,
      intent.source || null
    );

    logger.info({ intentId: id, name: intent.name }, 'Intent created');
    return this.get(id)!;
  }

  /**
   * Get intent by ID
   */
  get(id: string): Intent | null {
    const row = this.db.prepare('SELECT * FROM intents WHERE id = ?').get(id);
    return row ? this.rowToIntent(row) : null;
  }

  /**
   * List intents with optional filters
   */
  list(options?: { enabled?: boolean; source?: string }): Intent[] {
    let query = 'SELECT * FROM intents WHERE 1=1';
    const params: unknown[] = [];

    if (options?.enabled !== undefined) {
      query += ' AND enabled = ?';
      params.push(options.enabled ? 1 : 0);
    }

    if (options?.source) {
      query += ' AND source = ?';
      params.push(options.source);
    }

    query += ' ORDER BY priority DESC, created_at ASC';

    return this.db.prepare(query).all(...params).map(this.rowToIntent);
  }

  /**
   * Get intents that should trigger now based on their trigger config
   */
  getDueIntents(now: Date): Intent[] {
    const enabled = this.list({ enabled: true });

    return enabled.filter(intent => {
      const trigger = intent.triggerConfig;

      switch (trigger.type) {
        case 'cron':
          return this.cronMatches(trigger.expression, now);
        case 'interval':
          return this.intervalDue(intent.id, trigger.ms, now);
        case 'event':
          // Events are triggered externally, not by polling
          return false;
        default:
          return false;
      }
    });
  }

  /**
   * Create a run record for an intent
   */
  createRun(intentId: string, triggeredBy: string): IntentRun {
    const now = new Date().toISOString();

    const result = this.db.prepare(`
      INSERT INTO intent_runs (intent_id, triggered_by, triggered_at, status)
      VALUES (?, ?, ?, 'pending')
    `).run(intentId, triggeredBy, now);

    return {
      id: result.lastInsertRowid as number,
      intentId,
      triggeredBy,
      triggeredAt: now,
      status: 'pending'
    };
  }

  /**
   * Update run status and result
   */
  completeRun(
    runId: number,
    result: { success: boolean; output: string; error?: string; exitCode: number; duration: number }
  ): void {
    this.db.prepare(`
      UPDATE intent_runs SET
        status = ?,
        success = ?,
        output = ?,
        error = ?,
        exit_code = ?,
        duration_ms = ?,
        completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      result.success ? 'completed' : 'failed',
      result.success ? 1 : 0,
      result.output,
      result.error || null,
      result.exitCode,
      result.duration,
      runId
    );
  }

  private rowToIntent(row: unknown): Intent {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      name: r.name as string,
      description: r.description as string | undefined,
      triggerConfig: JSON.parse(r.trigger_config as string),
      executionConfig: JSON.parse(r.execution_config as string),
      queryTemplate: r.query_template as string,
      contextFiles: r.context_files ? JSON.parse(r.context_files as string) : undefined,
      lane: r.lane as string,
      enabled: r.enabled === 1,
      priority: r.priority as number,
      source: r.source as string | undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string
    };
  }

  private cronMatches(expression: string, now: Date): boolean {
    // Use node-cron or similar to check if expression matches current time
    // Implementation depends on cron library
    return false; // Placeholder
  }

  private intervalDue(intentId: string, intervalMs: number, now: Date): boolean {
    const lastRun = this.db.prepare(`
      SELECT completed_at FROM intent_runs
      WHERE intent_id = ? AND status = 'completed'
      ORDER BY completed_at DESC LIMIT 1
    `).get(intentId) as { completed_at: string } | undefined;

    if (!lastRun) return true; // Never run, is due

    const lastRunTime = new Date(lastRun.completed_at).getTime();
    return now.getTime() - lastRunTime >= intervalMs;
  }
}
```

### 1.4 Feature Flag System

```typescript
// ~/homer/src/runtime/flags.ts

import type Database from 'better-sqlite3';

export class FeatureFlags {
  private cache: Map<string, string> = new Map();

  constructor(private db: Database.Database) {
    this.loadAll();
  }

  private loadAll(): void {
    const rows = this.db.prepare('SELECT key, value FROM runtime_flags').all() as Array<{ key: string; value: string }>;
    this.cache.clear();
    for (const row of rows) {
      this.cache.set(row.key, row.value);
    }
  }

  get(key: string): string | undefined {
    return this.cache.get(key);
  }

  getBool(key: string): boolean {
    return this.cache.get(key) === 'true';
  }

  getNumber(key: string): number {
    return parseInt(this.cache.get(key) || '0', 10);
  }

  set(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO runtime_flags (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, value);
    this.cache.set(key, value);
  }

  // Convenience methods for runtime flags
  isRuntimeEnabled(): boolean {
    return this.getBool('runtime.enabled');
  }

  isSchedulerBridgeEnabled(): boolean {
    return this.getBool('runtime.scheduler_bridge');
  }

  isDiscoveryEnabled(): boolean {
    return this.getBool('runtime.discovery_enabled');
  }

  isParallelModeEnabled(): boolean {
    return this.getBool('runtime.parallel_mode');
  }

  getTickInterval(): number {
    return this.getNumber('runtime.tick_interval_ms') || 60000;
  }
}
```

### 1.5 Deliverables for Phase 1

1. `~/homer/src/runtime/schema.sql` - New database tables
2. `~/homer/src/runtime/types.ts` - TypeScript interfaces
3. `~/homer/src/runtime/executor.ts` - Unified executor interface
4. `~/homer/src/runtime/intent-manager.ts` - Intent CRUD operations
5. `~/homer/src/runtime/flags.ts` - Feature flag system
6. Database migration script in StateManager

---

## Phase 2: Bridge (Parallel Routing)

**Duration:** 2-3 days
**Risk:** Medium
**Rollback:** Disable `runtime.scheduler_bridge` flag

### 2.1 Schedule.json Bridge

Create a bridge that converts existing `schedule.json` jobs into intents:

```typescript
// ~/homer/src/runtime/bridges/scheduler-bridge.ts

import type { ScheduledJobConfig } from '../../scheduler/types.js';
import type { Intent } from '../types.js';
import { loadAllSchedules, getAllJobs } from '../../scheduler/loader.js';
import { IntentManager } from '../intent-manager.js';
import { logger } from '../../utils/logger.js';

/**
 * Converts schedule.json jobs to intents and syncs them
 */
export class SchedulerBridge {
  constructor(private intentManager: IntentManager) {}

  /**
   * Sync all schedule.json jobs as intents
   * - Creates new intents for new jobs
   * - Updates existing intents if config changed
   * - Disables intents for removed jobs
   */
  async sync(): Promise<{ created: number; updated: number; disabled: number }> {
    const schedules = await loadAllSchedules();
    const jobs = getAllJobs(schedules);

    let created = 0;
    let updated = 0;
    let disabled = 0;

    const existingIntents = this.intentManager.list({ source: 'schedule.json' });
    const existingByJobId = new Map(
      existingIntents.map(i => [this.extractJobId(i), i])
    );
    const seenJobIds = new Set<string>();

    for (const job of jobs) {
      seenJobIds.add(job.config.id);

      const existing = existingByJobId.get(job.config.id);
      const intent = this.jobToIntent(job.config, job.sourceFile);

      if (existing) {
        // Check if update needed (compare configs)
        if (this.needsUpdate(existing, intent)) {
          this.intentManager.update(existing.id, intent);
          updated++;
        }
      } else {
        this.intentManager.create(intent);
        created++;
      }
    }

    // Disable intents for removed jobs
    for (const [jobId, intent] of existingByJobId) {
      if (!seenJobIds.has(jobId) && intent.enabled) {
        this.intentManager.disable(intent.id);
        disabled++;
      }
    }

    logger.info({ created, updated, disabled }, 'Scheduler bridge sync completed');
    return { created, updated, disabled };
  }

  /**
   * Convert a ScheduledJobConfig to an Intent
   */
  private jobToIntent(job: ScheduledJobConfig, sourceFile: string): Omit<Intent, 'id' | 'created_at' | 'updated_at'> {
    return {
      name: job.name,
      description: `Bridged from ${sourceFile}`,
      triggerConfig: {
        type: 'cron',
        expression: job.cron,
        // Store original job ID for reference
        metadata: { originalJobId: job.id }
      },
      executionConfig: {
        executor: job.executor || 'claude',
        model: job.model,
        timeout: job.timeout,
      },
      queryTemplate: job.query,
      contextFiles: job.contextFiles,
      lane: job.lane,
      enabled: job.enabled,
      priority: this.calculatePriority(job),
      source: 'schedule.json'
    };
  }

  private calculatePriority(job: ScheduledJobConfig): number {
    // Higher priority for notification-enabled jobs
    let priority = 50;
    if (job.notifyOnSuccess) priority += 10;
    if (job.id === 'morning-brief') priority += 20;
    if (job.id === 'nightly-memory') priority += 15;
    return priority;
  }

  private extractJobId(intent: Intent): string {
    return intent.triggerConfig.metadata?.originalJobId || intent.id;
  }

  private needsUpdate(existing: Intent, newIntent: Omit<Intent, 'id' | 'created_at' | 'updated_at'>): boolean {
    // Compare relevant fields
    return (
      existing.queryTemplate !== newIntent.queryTemplate ||
      JSON.stringify(existing.triggerConfig) !== JSON.stringify(newIntent.triggerConfig) ||
      JSON.stringify(existing.executionConfig) !== JSON.stringify(newIntent.executionConfig) ||
      existing.enabled !== newIntent.enabled
    );
  }
}
```

### 2.2 Execution Router

Route executions through either old or new system based on flags:

```typescript
// ~/homer/src/runtime/router.ts

import type { RegisteredJob, JobExecutionResult } from '../scheduler/types.js';
import type { Intent, IntentRun } from './types.js';
import { executeScheduledJob } from '../scheduler/executor.js';
import { IntentManager } from './intent-manager.js';
import { ExecutorRegistry } from './executor.js';
import { FeatureFlags } from './flags.js';
import { logger } from '../utils/logger.js';

export class ExecutionRouter {
  constructor(
    private intentManager: IntentManager,
    private executorRegistry: ExecutorRegistry,
    private flags: FeatureFlags
  ) {}

  /**
   * Execute a job - routes to old or new system based on flags
   */
  async executeJob(job: RegisteredJob): Promise<JobExecutionResult> {
    const bridgeEnabled = this.flags.isSchedulerBridgeEnabled();
    const parallelMode = this.flags.isParallelModeEnabled();

    if (!bridgeEnabled) {
      // Old system only
      return executeScheduledJob(job);
    }

    // Find corresponding intent
    const intent = this.findIntentForJob(job);

    if (!intent) {
      logger.warn({ jobId: job.config.id }, 'No intent found for job, falling back to old executor');
      return executeScheduledJob(job);
    }

    if (parallelMode) {
      // Run both and compare (for validation)
      const [oldResult, newResult] = await Promise.all([
        executeScheduledJob(job),
        this.executeIntent(intent)
      ]);

      this.compareResults(job.config.id, oldResult, newResult);
      return oldResult; // Return old result as source of truth during parallel mode
    }

    // New system only
    const result = await this.executeIntent(intent);
    return this.intentResultToJobResult(result, job);
  }

  /**
   * Execute an intent through the new unified pipeline
   */
  async executeIntent(intent: Intent): Promise<IntentRun> {
    const run = this.intentManager.createRun(intent.id, 'scheduler_bridge');

    try {
      // Mark as running
      this.intentManager.updateRunStatus(run.id, 'running');

      // Find executor
      const executor = this.executorRegistry.findExecutor(intent.executionConfig);
      if (!executor) {
        throw new Error(`No executor found for config: ${JSON.stringify(intent.executionConfig)}`);
      }

      // Load context
      const contextPrompt = intent.contextFiles?.length
        ? this.loadContextFiles(intent.contextFiles)
        : undefined;

      // Execute
      const result = await executor.execute(run, {
        cwd: this.resolveCwd(intent.lane),
        timeout: intent.executionConfig.timeout || 600000,
        contextPrompt
      });

      // Record result
      this.intentManager.completeRun(run.id, result);

      return { ...run, ...result, status: result.success ? 'completed' : 'failed' };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.intentManager.completeRun(run.id, {
        success: false,
        output: '',
        error: errorMsg,
        exitCode: 1,
        duration: 0
      });
      throw error;
    }
  }

  private findIntentForJob(job: RegisteredJob): Intent | null {
    const intents = this.intentManager.list({ source: 'schedule.json' });
    return intents.find(i =>
      i.triggerConfig.metadata?.originalJobId === job.config.id
    ) || null;
  }

  private compareResults(jobId: string, old: JobExecutionResult, newRun: IntentRun): void {
    const mismatch = old.success !== (newRun.status === 'completed');

    if (mismatch) {
      logger.warn({
        jobId,
        oldSuccess: old.success,
        newSuccess: newRun.status === 'completed',
        oldOutput: old.output.slice(0, 200),
        newOutput: (newRun as unknown as { output: string }).output?.slice(0, 200)
      }, 'Execution result mismatch between old and new systems');
    } else {
      logger.debug({ jobId }, 'Execution results match');
    }
  }

  private intentResultToJobResult(run: IntentRun, job: RegisteredJob): JobExecutionResult {
    const r = run as unknown as { output: string; error?: string; exitCode: number; durationMs: number };
    return {
      jobId: job.config.id,
      jobName: job.config.name,
      sourceFile: job.sourceFile,
      startedAt: new Date(run.triggeredAt),
      completedAt: new Date(),
      success: run.status === 'completed',
      output: r.output || '',
      error: r.error,
      exitCode: r.exitCode || (run.status === 'completed' ? 0 : 1),
      duration: r.durationMs || 0
    };
  }

  private loadContextFiles(files: string[]): string {
    // Reuse existing logic from scheduler/executor.ts
    return ''; // Placeholder
  }

  private resolveCwd(lane: string): string {
    const LANE_CWD: Record<string, string> = {
      work: '/Users/yj/work',
      life: '/Users/yj/life',
      default: '/Users/yj'
    };
    return LANE_CWD[lane] || LANE_CWD.default;
  }
}
```

### 2.3 Integration Points

Modify `~/homer/src/scheduler/index.ts` to use the router:

```typescript
// In Scheduler.executeJob method:

private async executeJob(job: RegisteredJob, _manual: boolean): Promise<void> {
  // Check if we should use the new router
  if (this.executionRouter && this.flags.isSchedulerBridgeEnabled()) {
    return this.executeJobViaRouter(job, _manual);
  }

  // Existing implementation...
}

private async executeJobViaRouter(job: RegisteredJob, _manual: boolean): Promise<void> {
  try {
    const result = await this.executionRouter.executeJob(job);
    // ... rest of notification logic
  } catch (error) {
    // ... error handling
  }
}
```

### 2.4 Deliverables for Phase 2

1. `~/homer/src/runtime/bridges/scheduler-bridge.ts` - Job-to-intent converter
2. `~/homer/src/runtime/router.ts` - Execution routing logic
3. Modified `~/homer/src/scheduler/index.ts` - Router integration
4. Integration tests comparing old vs new results

---

## Phase 3: Cutover

**Duration:** 2-3 days
**Risk:** Medium-High
**Rollback:** Disable `runtime.enabled`, re-enable old Scheduler

### 3.1 Runtime Loop

```typescript
// ~/homer/src/runtime/loop.ts

import { IntentManager } from './intent-manager.js';
import { ExecutionRouter } from './router.js';
import { DiscoveryEngine } from './discovery.js';
import { FeatureFlags } from './flags.js';
import { logger } from '../utils/logger.js';

export class RuntimeLoop {
  private running = false;
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(
    private intentManager: IntentManager,
    private router: ExecutionRouter,
    private discovery: DiscoveryEngine,
    private flags: FeatureFlags
  ) {}

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    logger.info('Runtime loop started');

    // Initial tick
    await this.tick();

    // Schedule recurring ticks
    this.scheduleTick();
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    logger.info('Runtime loop stopped');
  }

  private scheduleTick(): void {
    const interval = this.flags.getTickInterval();
    this.tickTimer = setTimeout(async () => {
      if (this.running) {
        await this.tick();
        this.scheduleTick();
      }
    }, interval);
  }

  private async tick(): Promise<void> {
    const now = new Date();

    try {
      // 1. Check for due intents
      const dueIntents = this.intentManager.getDueIntents(now);

      logger.debug({ dueCount: dueIntents.length }, 'Runtime tick');

      // 2. Execute due intents (respect concurrency limits)
      for (const intent of dueIntents) {
        // Check if already running
        if (this.isIntentRunning(intent.id)) {
          logger.debug({ intentId: intent.id }, 'Intent already running, skipping');
          continue;
        }

        // Execute (fire and forget, track via intent_runs)
        this.router.executeIntent(intent).catch(err => {
          logger.error({ intentId: intent.id, error: err }, 'Intent execution failed');
        });
      }

      // 3. Run discovery if enabled and it's the right time
      if (this.flags.isDiscoveryEnabled() && this.shouldRunDiscovery(now)) {
        this.discovery.run().catch(err => {
          logger.error({ error: err }, 'Discovery run failed');
        });
      }

    } catch (error) {
      logger.error({ error }, 'Runtime tick error');
    }
  }

  private isIntentRunning(intentId: string): boolean {
    // Check intent_runs for running status
    return false; // Placeholder
  }

  private shouldRunDiscovery(now: Date): boolean {
    // Run discovery at 1 AM (matching NightSupervisor schedule)
    return now.getHours() === 1 && now.getMinutes() === 0;
  }
}
```

### 3.2 Discovery Engine (NightSupervisor Replacement)

```typescript
// ~/homer/src/runtime/discovery.ts

import { IntentManager } from './intent-manager.js';
import { buildContextPack } from '../night/context.js';
import { executeGeminiWithFallback } from '../executors/gemini-cli.js';
import { logger } from '../utils/logger.js';
import type Database from 'better-sqlite3';

/**
 * DiscoveryEngine - Generates intents from context analysis
 * Replaces NightSupervisor's planning phase
 */
export class DiscoveryEngine {
  constructor(
    private db: Database.Database,
    private intentManager: IntentManager
  ) {}

  async run(): Promise<DiscoverySession> {
    const sessionId = `discovery_${Date.now()}`;
    const startedAt = new Date().toISOString();

    logger.info({ sessionId }, 'Discovery session starting');

    // Record session start
    this.db.prepare(`
      INSERT INTO discovery_sessions (id, started_at, phase)
      VALUES (?, ?, 'planning')
    `).run(sessionId, startedAt);

    try {
      // 1. Build context (reuse from NightSupervisor)
      const contextPack = await buildContextPack({
        outputDir: `${process.env.HOME}/homer/night_mode`,
        memoryDir: `${process.env.HOME}/memory`,
        // ... other defaults
      } as NightModeConfig);

      // 2. Generate plan via Gemini
      this.updatePhase(sessionId, 'planning');
      const plan = await this.generatePlan(contextPack.compiled);

      // 3. Convert plan items to intents
      this.updatePhase(sessionId, 'execution');
      const intentsCreated = await this.createIntentsFromPlan(plan, sessionId);

      // 4. Generate synthesis/briefing
      this.updatePhase(sessionId, 'synthesis');
      const briefing = await this.generateBriefing(plan, intentsCreated);

      // Record completion
      this.db.prepare(`
        UPDATE discovery_sessions SET
          completed_at = CURRENT_TIMESTAMP,
          plan = ?,
          intents_created = ?,
          morning_briefing = ?
        WHERE id = ?
      `).run(
        JSON.stringify(plan),
        intentsCreated,
        briefing,
        sessionId
      );

      logger.info({ sessionId, intentsCreated }, 'Discovery session completed');

      return {
        id: sessionId,
        plan,
        intentsCreated,
        briefing
      };

    } catch (error) {
      logger.error({ sessionId, error }, 'Discovery session failed');
      throw error;
    }
  }

  private async generatePlan(context: string): Promise<NightPlan> {
    const prompt = `You are the Discovery Engine. Analyze the context and identify valuable work.

Focus on:
1. **Maintenance**: Idea consolidation, memory cleanup
2. **Research**: Topics worth exploring based on recent activity
3. **Ideas**: Promising ideas to develop further
4. **Improvements**: Code or process improvements

Return a JSON plan with this structure:
{
  "summary": "Brief focus description",
  "maintenance_tasks": [...],
  "research_tasks": [...],
  "ideas_to_explore": [...],
  "code_proposals": [...]
}

Be selective - quality over quantity.`;

    const result = await executeGeminiWithFallback(prompt, context, {
      model: 'gemini-3-flash-preview',
      sandbox: true,
      timeout: 300000
    });

    // Parse plan from response
    const jsonMatch = result.output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return { summary: 'No plan generated', research_tasks: [], ideas_to_explore: [], code_proposals: [] };
  }

  private async createIntentsFromPlan(plan: NightPlan, sessionId: string): Promise<number> {
    let created = 0;

    // Convert research tasks to intents
    for (const task of plan.research_tasks || []) {
      this.intentManager.create({
        name: `Research: ${task.query.slice(0, 50)}`,
        triggerConfig: { type: 'immediate' },
        executionConfig: { executor: 'gemini', timeout: 300000 },
        queryTemplate: `Research the following topic thoroughly:\n\n${task.query}`,
        lane: 'default',
        enabled: true,
        priority: task.priority === 'high' ? 70 : 50,
        source: `discovery:${sessionId}`
      });
      created++;
    }

    // Convert idea explorations to intents
    for (const idea of plan.ideas_to_explore || []) {
      this.intentManager.create({
        name: `Explore: ${idea.topic.slice(0, 50)}`,
        triggerConfig: { type: 'immediate' },
        executionConfig: { executor: 'gemini', timeout: 300000 },
        queryTemplate: `Explore this idea and identify potential applications:\n\n${idea.topic}`,
        lane: 'default',
        enabled: true,
        priority: 60,
        source: `discovery:${sessionId}`
      });
      created++;
    }

    return created;
  }

  private async generateBriefing(plan: NightPlan, intentsCreated: number): Promise<string> {
    // Simplified briefing generation
    return `## Discovery Briefing

### Summary
${plan.summary}

### Work Created
- ${intentsCreated} intents created for execution

### Research Topics
${(plan.research_tasks || []).map(t => `- ${t.query}`).join('\n')}

### Ideas to Explore
${(plan.ideas_to_explore || []).map(i => `- ${i.topic}`).join('\n')}
`;
  }

  private updatePhase(sessionId: string, phase: string): void {
    this.db.prepare('UPDATE discovery_sessions SET phase = ? WHERE id = ?').run(phase, sessionId);
  }
}

interface DiscoverySession {
  id: string;
  plan: NightPlan;
  intentsCreated: number;
  briefing: string;
}

interface NightPlan {
  summary: string;
  maintenance_tasks?: unknown[];
  research_tasks?: Array<{ id: string; query: string; priority: string }>;
  ideas_to_explore?: Array<{ id: string; topic: string }>;
  code_proposals?: unknown[];
}

interface NightModeConfig {
  outputDir: string;
  memoryDir: string;
}
```

### 3.3 Modified Entry Point

```typescript
// ~/homer/src/index.ts modifications

// In main():

// Initialize runtime (new system)
const flags = new FeatureFlags(stateManager.db);
const intentManager = new IntentManager(stateManager.db);
const executorRegistry = new ExecutorRegistry();

// Register executors
executorRegistry.register(new ClaudeExecutor());
executorRegistry.register(new GeminiExecutor());
executorRegistry.register(new KimiExecutor());

const router = new ExecutionRouter(intentManager, executorRegistry, flags);
const discovery = new DiscoveryEngine(stateManager.db, intentManager);
const runtimeLoop = new RuntimeLoop(intentManager, router, discovery, flags);

// Check if new runtime should take over
if (flags.isRuntimeEnabled()) {
  logger.info('Starting new runtime loop');
  await runtimeLoop.start();

  // Skip old scheduler if not in parallel mode
  if (!flags.isParallelModeEnabled()) {
    logger.info('Old scheduler disabled, runtime loop is primary');
    // Don't start old scheduler
  } else {
    // Start both for comparison
    await scheduler.start();
  }
} else {
  // Old system only
  await scheduler.start();
}

// Register shutdown
registerShutdownTask(() => {
  runtimeLoop.stop();
});
```

### 3.4 Deliverables for Phase 3

1. `~/homer/src/runtime/loop.ts` - Main runtime loop
2. `~/homer/src/runtime/discovery.ts` - Discovery engine
3. Modified `~/homer/src/index.ts` - Dual startup logic
4. Cutover runbook with step-by-step instructions

---

## Data Migration

### Migration Scripts

```typescript
// ~/homer/src/runtime/migrate.ts

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

/**
 * Migrate existing data to new schema
 */
export async function migrateToRuntime(db: Database.Database): Promise<void> {
  logger.info('Starting runtime migration');

  // 1. Create new tables (idempotent)
  db.exec(RUNTIME_SCHEMA);

  // 2. Migrate scheduled_job_runs to intent_runs (historical data)
  const existingRuns = db.prepare(`
    SELECT * FROM scheduled_job_runs
    WHERE NOT EXISTS (
      SELECT 1 FROM intent_runs WHERE intent_runs.id = scheduled_job_runs.id
    )
  `).all();

  logger.info({ count: existingRuns.length }, 'Migrating historical job runs');

  // Note: We don't migrate runs without corresponding intents
  // Historical data stays in scheduled_job_runs for reference

  // 3. Initialize feature flags
  const defaultFlags = [
    ['runtime.enabled', 'false'],
    ['runtime.scheduler_bridge', 'false'],
    ['runtime.discovery_enabled', 'false'],
    ['runtime.parallel_mode', 'true'],
    ['runtime.tick_interval_ms', '60000']
  ];

  for (const [key, value] of defaultFlags) {
    db.prepare(`
      INSERT OR IGNORE INTO runtime_flags (key, value)
      VALUES (?, ?)
    `).run(key, value);
  }

  logger.info('Runtime migration completed');
}

/**
 * Rollback migration (for emergency recovery)
 */
export function rollbackRuntime(db: Database.Database): void {
  logger.warn('Rolling back runtime migration');

  // Disable all runtime flags
  db.prepare(`UPDATE runtime_flags SET value = 'false' WHERE key LIKE 'runtime.%'`).run();

  // Don't delete tables - keep data for debugging
  // Just disable the runtime

  logger.info('Runtime rollback completed - old scheduler will take over');
}
```

### Data Preservation

All existing data is preserved:
- `homer.db` - No destructive changes, only additive tables
- `~/memory/daily/` - Untouched by migration
- `~/memory/ideas.md` - Untouched by migration
- `schedule.json` - Read-only bridge, original file unchanged

---

## Rollback Procedures

### Level 1: Feature Flag Rollback (Instant)

```bash
# Via Telegram bot command (to be implemented)
/runtime disable

# Or direct SQLite
sqlite3 ~/homer/data/homer.db "UPDATE runtime_flags SET value='false' WHERE key='runtime.enabled'"
```

**Effect:** Old scheduler resumes, new runtime stops on next tick

### Level 2: Bridge Rollback (Instant)

```bash
sqlite3 ~/homer/data/homer.db "UPDATE runtime_flags SET value='false' WHERE key='runtime.scheduler_bridge'"
```

**Effect:** Jobs route through old executor only

### Level 3: Full Rollback (Requires Restart)

```bash
# 1. Disable all runtime flags
sqlite3 ~/homer/data/homer.db "UPDATE runtime_flags SET value='false' WHERE key LIKE 'runtime.%'"

# 2. Restart HOMER
launchctl kickstart -k gui/$(id -u)/com.yj.homer
```

**Effect:** Complete revert to pre-migration behavior

### Level 4: Code Rollback (Emergency)

```bash
# 1. Git revert
cd ~/homer
git checkout HEAD~1 -- src/index.ts src/scheduler/

# 2. Rebuild and restart
pnpm build
launchctl kickstart -k gui/$(id -u)/com.yj.homer
```

---

## Testing Strategy

### Phase 1 Tests

1. **Schema Tests**
   - Verify tables created correctly
   - Test foreign key constraints
   - Verify indexes exist

2. **Intent Manager Tests**
   - CRUD operations
   - Trigger matching (cron, interval)
   - Run tracking

3. **Feature Flag Tests**
   - Get/set operations
   - Boolean parsing
   - Default values

### Phase 2 Tests

1. **Bridge Tests**
   - Job-to-intent conversion accuracy
   - Sync create/update/disable logic
   - Config change detection

2. **Router Tests**
   - Correct routing based on flags
   - Parallel execution comparison
   - Fallback on missing intent

3. **Integration Tests**
   - Run each existing job through bridge
   - Compare outputs to baseline
   - Verify notifications still work

### Phase 3 Tests

1. **Runtime Loop Tests**
   - Tick scheduling
   - Due intent detection
   - Concurrency limits

2. **Discovery Tests**
   - Plan generation
   - Intent creation from plan
   - Briefing generation

3. **End-to-End Tests**
   - Full night cycle simulation
   - 24-hour operation test
   - Graceful shutdown/restart

### Test Data

Create a test schedule with fast-cycling jobs:

```json
{
  "version": "1.0",
  "jobs": [
    {
      "id": "test-minute",
      "name": "Test Job (Every Minute)",
      "cron": "* * * * *",
      "query": "echo 'test'",
      "lane": "default",
      "enabled": true,
      "timeout": 30000
    }
  ]
}
```

---

## Gradual Rollout Plan

### Week 1: Foundation
- Deploy Phase 1 (new tables, interfaces)
- Run in parallel mode, no execution changes
- Monitor for any issues

### Week 2: Bridge
- Enable `runtime.scheduler_bridge`
- Run in parallel comparison mode
- Review execution logs for mismatches

### Week 3: Validation
- Compare 100+ executions between old and new
- Fix any discrepancies
- Get sign-off on parity

### Week 4: Cutover
- Enable `runtime.enabled`
- Disable parallel mode
- Old scheduler becomes fallback only

### Week 5: Cleanup
- Enable `runtime.discovery_enabled`
- Disable NightSupervisor
- Remove parallel mode code (optional)

---

## Monitoring & Observability

### Key Metrics

1. **Execution Metrics**
   - Intent runs per hour
   - Success rate by intent
   - Average duration by executor

2. **Discovery Metrics**
   - Sessions per day
   - Intents generated per session
   - Briefing quality (manual review)

3. **System Health**
   - Runtime loop uptime
   - Tick latency
   - Database query times

### Alerting

```typescript
// Add to runtime loop
if (tickDuration > 5000) {
  logger.warn({ duration: tickDuration }, 'Slow runtime tick');
}

if (failedIntents > 3) {
  // Notify via Telegram
  await bot.api.sendMessage(chatId, `Warning: ${failedIntents} intent failures in last hour`);
}
```

### Dashboard Additions

Add to web dashboard (`/dashboard`):
- Intent list with status
- Discovery session history
- Feature flag controls
- Migration progress indicator

---

## File Structure

```
~/homer/src/runtime/
├── index.ts           # Main exports
├── types.ts           # TypeScript interfaces
├── schema.sql         # Database schema
├── migrate.ts         # Migration scripts
├── flags.ts           # Feature flag system
├── intent-manager.ts  # Intent CRUD
├── executor.ts        # Unified executor interface
├── loop.ts            # Runtime loop
├── router.ts          # Execution router
├── discovery.ts       # Discovery engine
└── bridges/
    └── scheduler-bridge.ts  # Schedule.json bridge
```

---

## Success Criteria

1. **Zero Data Loss**
   - All historical job runs preserved
   - All ideas preserved
   - All memory files intact

2. **Functional Parity**
   - All 8 existing jobs execute correctly
   - Notification behavior unchanged
   - Approval flow unchanged

3. **Performance**
   - No increase in execution time
   - No increase in resource usage
   - Tick latency < 1 second

4. **Rollback Tested**
   - Each rollback level verified
   - Recovery time < 5 minutes

---

## Timeline

| Phase | Duration | Deliverables |
|-------|----------|--------------|
| Phase 1 | 1-2 days | Schema, interfaces, flags |
| Phase 2 | 2-3 days | Bridge, router, parallel mode |
| Phase 3 | 2-3 days | Runtime loop, discovery engine |
| Testing | 3-5 days | Full test suite, validation |
| Rollout | 5 weeks | Gradual feature flag rollout |

**Total:** ~3 weeks development + 5 weeks rollout = 8 weeks to full migration

---

## Open Questions

1. Should discovery-generated intents auto-execute or require approval?
2. How to handle intent versioning when schedule.json changes?
3. Should we migrate historical `scheduled_job_runs` to `intent_runs`?
4. What's the retention policy for discovery sessions?

---

*Document Version: 1.0*
*Last Updated: 2026-02-02*
*Author: HOMER Migration Planning*
