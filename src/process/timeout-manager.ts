/**
 * SessionTimeoutManager — Backstop enforcement on top of each executor's own timeout.
 *
 * Features:
 * - Enforcement enabled by default (PROCESS_TIMEOUT_ENFORCE=0 to disable)
 * - LLM triage via Claude Code (Sonnet) before killing executor processes > 30min
 * - Hard kill ceiling: any process > 45min killed immediately regardless of LLM
 * - Circuit breaker: max 3 LLM triage calls per hour
 * - Piggybacks processRegistry.tickSnapshot() for DB persistence
 */

import { processRegistry } from "./registry.js";
import type { ProcessRecord, ProcessType } from "./registry.js";
import { logger } from "../utils/logger.js";
import { execFile } from "child_process";

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

// Hard kill ceiling — absolute safety backstop
const HARD_KILL_CEILING_MS = 45 * 60 * 1000; // 45 min

// LLM triage circuit breaker
const MAX_TRIAGE_PER_HOUR = 3;
const TRIAGE_TIMEOUT_MS = 30_000; // 30s for LLM response

interface TriageDecision {
  action: "kill" | "extend" | "escalate";
  reason: string;
}

export class SessionTimeoutManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingKills = new Set<number>(); // PIDs awaiting SIGKILL after SIGTERM
  private triagePending = new Set<number>(); // PIDs currently being triaged
  private enforce: boolean;
  private triageTimestamps: number[] = []; // Timestamps of recent triage calls

  constructor() {
    // Enforcement enabled by default; set PROCESS_TIMEOUT_ENFORCE=0 to disable
    this.enforce = process.env.PROCESS_TIMEOUT_ENFORCE !== "0";
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
    // Piggyback registry snapshot (~60s interval via 2x multiplier inside tickSnapshot)
    processRegistry.tickSnapshot();

    const active = processRegistry.getActive();
    const now = Date.now();

    for (const record of active) {
      // timeoutMs: 0 means "no timeout" (e.g. long-lived Chrome sessions)
      const backstopTimeout = TYPE_TIMEOUTS[record.type] ?? TYPE_TIMEOUTS.executor;
      const effectiveTimeout = record.timeoutMs > 0
        ? Math.min(record.timeoutMs, backstopTimeout)
        : backstopTimeout;
      // If triage extended the process, skip until extension expires
      if (record.extendedUntil && now < record.extendedUntil) continue;

      const age = now - record.spawnedAt;
      if (age > effectiveTimeout) {
        this.handleTimeout(record, age, effectiveTimeout);
      }
    }
  }

  private handleTimeout(record: ProcessRecord, ageMs: number, timeoutMs: number): void {
    if (this.pendingKills.has(record.pid)) return; // Already in kill sequence
    if (this.triagePending.has(record.pid)) return; // Already being triaged

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

    // Hard kill ceiling: > 45min → immediate kill, no triage
    if (ageMs > HARD_KILL_CEILING_MS) {
      logger.warn(
        { pid: record.pid, ageMin, command: record.command },
        "Hard kill ceiling reached (>45min), killing immediately"
      );
      this.executeKill(record, "hard-ceiling");
      return;
    }

    // LLM triage for executor processes > 30min (if circuit breaker allows)
    if (record.type === "executor" && ageMs > 30 * 60 * 1000 && this.canTriage()) {
      this.triageBeforeKill(record, ageMs).catch((err) => {
        logger.warn({ error: err, pid: record.pid }, "LLM triage failed, killing process");
        this.executeKill(record, "triage-failed");
      });
      return;
    }

    // Default: kill immediately
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
    this.executeKill(record, "timeout");
  }

  /**
   * Check if we can make another LLM triage call (circuit breaker).
   */
  private canTriage(): boolean {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    this.triageTimestamps = this.triageTimestamps.filter((ts) => ts > oneHourAgo);
    return this.triageTimestamps.length < MAX_TRIAGE_PER_HOUR;
  }

  /**
   * LLM triage: ask Claude Code whether to kill, extend, or escalate.
   */
  private async triageBeforeKill(record: ProcessRecord, ageMs: number): Promise<void> {
    this.triagePending.add(record.pid);
    this.triageTimestamps.push(Date.now());

    const ageMin = (ageMs / 60_000).toFixed(1);

    logger.info(
      { pid: record.pid, command: record.command, ageMin },
      "Running LLM triage before kill"
    );

    const prompt = `A Homer daemon process has exceeded its timeout. Decide what to do.

Process: PID=${record.pid}, command="${record.command}", type=${record.type}, source=${record.source}
Age: ${ageMin} minutes (timeout: ${(record.timeoutMs / 60_000).toFixed(1)} min)
${record.jobId ? `Job: ${record.jobId}` : ""}
${record.runId ? `Run: ${record.runId}` : ""}

Return ONLY a raw JSON object (no markdown, no explanation):
{"action": "kill", "reason": "..."}

Valid actions:
- "kill" — Process is stuck/hung, terminate it
- "extend" — Process may be doing useful work (e.g. large build), give 15 more minutes
- "escalate" — Uncertain, send alert but don't kill

Rules:
- If the command contains "claude" or "codex" and age < 40min, prefer "extend" (LLM calls can be slow)
- If age > 40min, prefer "kill" regardless (approaching hard ceiling)
- If source is "scheduler" and a known long job, prefer "extend"
- Default to "kill" if uncertain`;

    try {
      const decision = await this.callClaude(prompt);

      logger.info(
        { pid: record.pid, action: decision.action, reason: decision.reason },
        "LLM triage decision"
      );

      switch (decision.action) {
        case "extend":
          // Extend by 15 minutes
          record.extendedUntil = Date.now() + 15 * 60 * 1000;
          this.logCleanup(record, `triage-extend: ${decision.reason}`, false);
          break;
        case "escalate":
          logger.warn(
            { pid: record.pid, reason: decision.reason },
            "LLM triage escalated — not killing, will re-evaluate next cycle"
          );
          this.logCleanup(record, `triage-escalate: ${decision.reason}`, false);
          break;
        case "kill":
        default:
          this.executeKill(record, `triage-kill: ${decision.reason}`);
          break;
      }
    } finally {
      this.triagePending.delete(record.pid);
    }
  }

  /**
   * Call Claude Code CLI for triage decision.
   */
  private callClaude(prompt: string): Promise<TriageDecision> {
    return new Promise((resolve) => {
      const claudeBin = process.env.CLAUDE_BIN || process.env.CLAUDE_PATH || `${process.env.HOME ?? "/Users/yj"}/.local/bin/claude`;
      const child = execFile(
        claudeBin,
        ["-p", prompt, "--output-format", "text", "-m", "sonnet"],
        { timeout: TRIAGE_TIMEOUT_MS, maxBuffer: 1024 * 64 },
        (error, stdout) => {
          if (error || !stdout) {
            resolve({ action: "kill", reason: "CC unreachable or timed out" });
            return;
          }

          try {
            // Extract JSON from response
            const match = stdout.match(/\{[^{}]*\}/);
            if (match) {
              const parsed = JSON.parse(match[0]) as { action?: string; reason?: string };
              const action = parsed.action;
              if (action === "kill" || action === "extend" || action === "escalate") {
                resolve({ action, reason: parsed.reason || "No reason given" });
                return;
              }
            }
          } catch {
            // Parse failed
          }

          resolve({ action: "kill", reason: "CC response unparseable" });
        }
      );

      // Safety: kill claude process if it hangs
      child.once("error", () => {
        resolve({ action: "kill", reason: "CC process error" });
      });
    });
  }

  /**
   * Execute the actual kill sequence (SIGTERM → grace → SIGKILL).
   */
  private executeKill(record: ProcessRecord, reason: string): void {
    if (this.pendingKills.has(record.pid)) return;

    logger.warn(
      { pid: record.pid, command: record.command, reason },
      "Executing process kill"
    );

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
      this.logCleanup(record, reason);
    }, grace);
  }

  private logCleanup(record: ProcessRecord, reason: string, isKill = true): void {
    try {
      const db = processRegistry.getDb();
      if (!db) return;
      db.prepare(
        `INSERT INTO process_cleanup_runs (trigger, processes_scanned, processes_killed, processes_spared, details)
         VALUES (?, 1, ?, ?, ?)`
      ).run(
        "timeout-manager",
        isKill ? 1 : 0,
        isKill ? 0 : 1,
        JSON.stringify([
          {
            pid: record.pid,
            command: record.command,
            action: isKill ? "killed" : "spared",
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
