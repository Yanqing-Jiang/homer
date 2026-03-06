/**
 * ProcessRegistry — Central singleton tracking every HOMER-spawned child process.
 *
 * Provides registration, activity tracking, snapshot/recovery (via DB),
 * and bulk kill for graceful shutdown.
 */

import type { ChildProcess } from "child_process";
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

export type ProcessType = "executor" | "investigation" | "cleanup" | "utility";
export type ProcessSource =
  | "cli-runner"
  | "scheduler"
  | "connectivity"
  | "watchdog"
  | "cleanup";

export interface ProcessRecord {
  pid: number;
  pgid?: number;
  command: string;
  type: ProcessType;
  spawnedAt: number;
  timeoutMs: number;
  lastActivity: number;
  source: ProcessSource;
  runId?: string;
  jobId?: string;
  settled: boolean;
  settledAt?: number;
  extendedUntil?: number; // Set by triage "extend" action instead of mutating spawnedAt
}

// Throttle activity updates to every 10s per process
const ACTIVITY_THROTTLE_MS = 10_000;

class ProcessRegistryImpl {
  private processes = new Map<number, ProcessRecord>();
  private activityTimers = new Map<number, number>(); // pid -> last update ts
  private db: Database.Database | null = null;
  private tickCount = 0;

  /**
   * Initialize with DB reference for snapshot/recovery.
   * Call once after StateManager is ready.
   * Note: snapshot timer is driven externally via tickSnapshot() from SessionTimeoutManager.
   */
  init(db: Database.Database): void {
    this.db = db;
  }

  /**
   * Called externally (by SessionTimeoutManager) on each check cycle (~30s).
   * Snapshots every 2nd call to maintain ~60s interval.
   */
  tickSnapshot(): void {
    this.tickCount++;
    if (this.tickCount % 2 === 0) {
      this.snapshot();
    }
  }

  /**
   * Register a spawned child process for lifecycle tracking.
   */
  register(
    proc: ChildProcess,
    meta: {
      command: string;
      type: ProcessType;
      timeoutMs: number;
      source: ProcessSource;
      runId?: string;
      jobId?: string;
      detached?: boolean; // Only set pgid for detached processes
    }
  ): ProcessRecord | null {
    if (!proc.pid) {
      logger.warn({ command: meta.command }, "Cannot register process without PID");
      return null;
    }

    const now = Date.now();
    const record: ProcessRecord = {
      pid: proc.pid,
      pgid: meta.detached ? proc.pid : undefined, // Only detached processes get group kill
      command: meta.command,
      type: meta.type,
      spawnedAt: now,
      timeoutMs: meta.timeoutMs,
      lastActivity: now,
      source: meta.source,
      runId: meta.runId,
      jobId: meta.jobId,
      settled: false,
    };

    this.processes.set(proc.pid, record);

    // Auto-unregister on exit
    proc.once("exit", () => {
      this.settle(proc.pid!);
    });
    proc.once("error", () => {
      this.settle(proc.pid!);
    });

    logger.debug(
      { pid: proc.pid, command: meta.command, type: meta.type, source: meta.source },
      "Process registered"
    );

    return record;
  }

  /**
   * Mark a process as settled (exited). Does not remove from map until next snapshot.
   */
  private settle(pid: number): void {
    const record = this.processes.get(pid);
    if (record && !record.settled) {
      record.settled = true;
      record.settledAt = Date.now();
      this.activityTimers.delete(pid);
    }
  }

  /**
   * Mark a process as settled. Kept in map for snapshot persistence;
   * cleaned from memory on next snapshot cycle (after 1 hour).
   */
  unregister(pid: number): void {
    this.settle(pid);
  }

  /**
   * Update lastActivity timestamp (throttled to avoid overhead).
   */
  touch(pid: number): void {
    const record = this.processes.get(pid);
    if (!record || record.settled) return;

    const now = Date.now();
    const lastUpdate = this.activityTimers.get(pid) ?? 0;
    if (now - lastUpdate < ACTIVITY_THROTTLE_MS) return;

    record.lastActivity = now;
    this.activityTimers.set(pid, now);
  }

  /**
   * Get all tracked processes.
   */
  getAll(): ProcessRecord[] {
    return Array.from(this.processes.values());
  }

  /**
   * Get only active (non-settled) processes.
   */
  getActive(): ProcessRecord[] {
    return this.getAll().filter((r) => !r.settled);
  }

  /**
   * Get processes idle longer than thresholdMs.
   */
  getIdle(thresholdMs: number): ProcessRecord[] {
    const cutoff = Date.now() - thresholdMs;
    return this.getActive().filter((r) => r.lastActivity < cutoff);
  }

  /**
   * Get processes by type.
   */
  getByType(type: ProcessType): ProcessRecord[] {
    return this.getActive().filter((r) => r.type === type);
  }

  /**
   * Kill all active managed processes with the given signal.
   */
  killAll(signal: NodeJS.Signals = "SIGTERM"): void {
    const active = this.getActive();
    logger.info({ count: active.length, signal }, "Killing all managed processes");

    for (const record of active) {
      this.killProcess(record, signal);
    }
  }

  /**
   * Kill a single process safely.
   */
  killProcess(record: ProcessRecord, signal: NodeJS.Signals): boolean {
    if (record.pid <= 1 || record.pid === process.pid) {
      logger.warn({ pid: record.pid }, "Refusing to kill protected PID");
      return false;
    }

    try {
      // Try group kill first for detached processes
      if (record.pgid && record.pgid > 1) {
        try {
          process.kill(-record.pgid, signal);
          return true;
        } catch {
          // Fall through to direct kill
        }
      }
      process.kill(record.pid, signal);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // Already dead
        this.settle(record.pid);
        return false;
      }
      logger.warn({ pid: record.pid, error: err }, "Failed to kill process");
      return false;
    }
  }

  /**
   * Persist current state to DB.
   */
  snapshot(): void {
    if (!this.db) return;

    try {
      const upsert = this.db.prepare(`
        INSERT OR REPLACE INTO managed_processes
          (pid, pgid, command, type, spawned_at, timeout_ms, last_activity, source, run_id, job_id, settled, settled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const tx = this.db.transaction(() => {
        for (const r of this.processes.values()) {
          upsert.run(
            r.pid,
            r.pgid ?? null,
            r.command,
            r.type,
            r.spawnedAt,
            r.timeoutMs,
            r.lastActivity,
            r.source,
            r.runId ?? null,
            r.jobId ?? null,
            r.settled ? 1 : 0,
            r.settledAt ?? null
          );
        }
      });
      tx();

      // Clean up old settled processes from in-memory map (keep last hour)
      const cutoff = Date.now() - 3600_000;
      for (const [pid, record] of this.processes) {
        if (record.settled && (record.settledAt ?? 0) < cutoff) {
          this.processes.delete(pid);
        }
      }
    } catch (err) {
      logger.warn({ error: err }, "Process registry snapshot failed");
    }
  }

  /**
   * Recover from DB after a crash. Verify which PIDs are still alive.
   */
  recover(): void {
    if (!this.db) return;

    try {
      const rows = this.db
        .prepare("SELECT * FROM managed_processes WHERE settled = 0")
        .all() as Array<{
        pid: number;
        pgid: number | null;
        command: string;
        type: ProcessType;
        spawned_at: number;
        timeout_ms: number;
        last_activity: number;
        source: ProcessSource;
        run_id: string | null;
        job_id: string | null;
      }>;

      let stale = 0;

      // On recovery, we can't safely re-attach to orphaned processes because:
      // 1. PIDs can be reused by the OS — kill(pid, 0) proves liveness, not identity
      // 2. We have no ChildProcess handle to listen for exit events
      // Instead, mark all stale records as settled. The CleanupScheduler's OS orphan
      // scan will catch any truly orphaned HOMER processes via command-line matching.
      for (const row of rows) {
        this.db!
          .prepare(
            "UPDATE managed_processes SET settled = 1, settled_at = ? WHERE pid = ?"
          )
          .run(Date.now(), row.pid);
        stale++;
      }

      if (stale > 0) {
        logger.info(
          { stale },
          "Process registry: marked stale rows as settled on recovery"
        );
      }
    } catch (err) {
      logger.warn({ error: err }, "Process registry recovery failed");
    }
  }

  /**
   * Get DB reference (for audit logging by timeout manager / cleanup scheduler).
   */
  getDb(): Database.Database | null {
    return this.db;
  }

  /**
   * Run a final snapshot on shutdown.
   */
  stop(): void {
    this.snapshot();
  }
}

// Singleton
export const processRegistry = new ProcessRegistryImpl();
