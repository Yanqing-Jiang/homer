/**
 * SessionTimeoutManager — Backstop enforcement on top of each executor's own timeout.
 *
 * Phase 1: Monitor-only (logs "would kill" but does not actually kill).
 * Set PROCESS_TIMEOUT_ENFORCE=1 env var to enable actual kills (Phase 2).
 */

import { processRegistry } from "./registry.js";
import type { ProcessRecord, ProcessType } from "./registry.js";
import { logger } from "../utils/logger.js";

const CHECK_INTERVAL_MS = 30_000; // Check every 30s

// Per-type timeouts
const TYPE_TIMEOUTS: Record<ProcessType, number> = {
  executor: 30 * 60 * 1000,     // 30 min
  investigation: 5 * 60 * 1000, // 5 min
  cleanup: 10 * 60 * 1000,      // 10 min
  utility: 5 * 60 * 1000,       // 5 min
};

// Per-type grace periods (SIGTERM → SIGKILL)
const GRACE_PERIODS: Record<ProcessType, number> = {
  executor: 10_000,
  investigation: 5_000,
  cleanup: 5_000,
  utility: 3_000,
};

export class SessionTimeoutManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingKills = new Set<number>(); // PIDs awaiting SIGKILL after SIGTERM
  private enforce: boolean;

  constructor() {
    this.enforce = process.env.PROCESS_TIMEOUT_ENFORCE === "1";
  }

  start(): void {
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    logger.info(
      { enforce: this.enforce, intervalMs: CHECK_INTERVAL_MS },
      "SessionTimeoutManager started"
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private check(): void {
    const active = processRegistry.getActive();
    const now = Date.now();

    for (const record of active) {
      // Use the smaller of the record's own timeout and the type backstop
      const backstopTimeout = TYPE_TIMEOUTS[record.type] ?? TYPE_TIMEOUTS.executor;
      const effectiveTimeout = Math.min(record.timeoutMs, backstopTimeout);
      const age = now - record.spawnedAt;

      if (age > effectiveTimeout) {
        this.handleTimeout(record, age, effectiveTimeout);
      }
    }
  }

  private handleTimeout(record: ProcessRecord, ageMs: number, timeoutMs: number): void {
    if (this.pendingKills.has(record.pid)) return; // Already in kill sequence

    const ageMin = (ageMs / 60_000).toFixed(1);
    const timeoutMin = (timeoutMs / 60_000).toFixed(1);

    if (!this.enforce) {
      logger.warn(
        {
          pid: record.pid,
          command: record.command,
          type: record.type,
          ageMin,
          timeoutMin,
          source: record.source,
        },
        "MONITOR: Would kill timed-out process (enforcement disabled)"
      );
      return;
    }

    logger.warn(
      {
        pid: record.pid,
        command: record.command,
        type: record.type,
        ageMin,
        timeoutMin,
        source: record.source,
      },
      "Killing timed-out process"
    );

    // SIGTERM first
    const killed = processRegistry.killProcess(record, "SIGTERM");
    if (!killed) return;

    this.pendingKills.add(record.pid);
    const grace = GRACE_PERIODS[record.type] ?? 5_000;

    // Escalate to SIGKILL after grace period
    setTimeout(() => {
      this.pendingKills.delete(record.pid);

      // Check if still alive
      try {
        process.kill(record.pid, 0);
        // Still alive — SIGKILL
        logger.warn({ pid: record.pid }, "Process survived SIGTERM, sending SIGKILL");
        processRegistry.killProcess(record, "SIGKILL");
      } catch {
        // Already dead, good
      }

      processRegistry.unregister(record.pid);
      this.logCleanup(record, "timeout");
    }, grace);
  }

  private logCleanup(record: ProcessRecord, reason: string): void {
    try {
      const db = processRegistry.getDb();
      if (!db) return;
      db.prepare(
        `INSERT INTO process_cleanup_runs (trigger, processes_scanned, processes_killed, processes_spared, details)
         VALUES (?, 1, 1, 0, ?)`
      ).run(
        "timeout-manager",
        JSON.stringify([
          {
            pid: record.pid,
            command: record.command,
            action: "killed",
            reason,
            type: record.type,
            ageMs: Date.now() - record.spawnedAt,
          },
        ])
      );
    } catch {
      // Best effort audit
    }
  }
}
