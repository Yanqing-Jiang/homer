/**
 * CleanupScheduler — Periodic orphan/idle process cleanup.
 *
 * Runs every 2 hours. Two-pronged detection:
 * A) Registry scan for over-timeout / idle processes.
 * B) OS orphan scan via `ps` for known HOMER patterns not in registry.
 *
 * 6-layer safety before any kill. Enforcement ON by default (set PROCESS_CLEANUP_ENFORCE=0 to disable).
 * Age-based kill: tty-less HOMER-pattern process > 6h; or TTY-attached `claude` > 6h with TTY idle > 6h.
 */

import { execSync, spawnSync } from "child_process";
import { readdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { processRegistry } from "./registry.js";
import type { ProcessRecord } from "./registry.js";
import { logger } from "../utils/logger.js";
// @ts-ignore
import type Database from "better-sqlite3";

const IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours no activity
const RECENT_ACTIVITY_MS = 15 * 60 * 1000; // 15 min — spare if active recently
const ORPHAN_AGE_KILL_MS = 6 * 60 * 60 * 1000; // 6 hours — kill any HOMER process older than this

// Patterns to find HOMER-spawned processes in `ps`
const ORPHAN_PATTERNS = [
  "homer/dist",
  "claude.*--(?:print|dangerously|model|resume)",
  "codex(?:\\s+exec|.*bypass)",
  "opencode run",
  "kimi --quiet",
  "gemini.*-(?:m|p)\\s",
];

// CDP scraping Chrome lifecycle. These are matched by a dedicated predicate
// (isCdpChromeCmdline) rather than a bare ORPHAN_PATTERNS regex, because a loose
// "chrome-cdp-profile" string also matches unrelated command lines (e.g. an agent
// prompt that merely mentions the path). The live :9222 listener is always spared.
const CDP_PORT = 9222;
const CDP_PROFILE_PREFIX = "/tmp/chrome-cdp-profile-";
const CDP_PROFILE_MIN_AGE_MS = 30 * 60 * 1000; // grace period before sweeping a /tmp profile dir

/** True only for a real Homer CDP Chrome process (has both the Chrome binary and our temp profile). */
function isCdpChromeCmdline(cmdline: string): boolean {
  return cmdline.includes("Google Chrome") && cmdline.includes(`--user-data-dir=${CDP_PROFILE_PREFIX}`);
}

/** Extract the /tmp CDP profile dir from a command line, or null. */
function extractCdpProfileDir(cmdline: string): string | null {
  const m = cmdline.match(/--user-data-dir=(\/tmp\/chrome-cdp-profile-\d+)/);
  return m?.[1] ?? null;
}

interface CleanupAction {
  pid: number;
  command: string;
  action: "killed" | "spared";
  reason: string;
}

interface CdpState {
  /** PIDs currently LISTENing on the CDP port — never kill these. */
  listenerPids: Set<number>;
  /** Profile dirs backing a live listener — never delete these. */
  liveProfileDirs: Set<string>;
  /** Profile dirs referenced by ANY running Chrome process — never delete these. */
  referencedProfileDirs: Set<string>;
  /** True only if BOTH the ps and lsof scans succeeded. Disk sweep requires this
   *  (fail-closed): if process discovery failed, we cannot prove a dir is dead. */
  trusted: boolean;
}

export class CleanupScheduler {
  private db: Database.Database | null = null;
  private enforce: boolean;
  /** CDP process/profile snapshot for the current run (rebuilt each cycle). */
  private cdp: CdpState = { listenerPids: new Set(), liveProfileDirs: new Set(), referencedProfileDirs: new Set(), trusted: false };

  constructor() {
    // Enforcement ON by default; set PROCESS_CLEANUP_ENFORCE=0 to disable
    this.enforce = process.env.PROCESS_CLEANUP_ENFORCE !== "0";
  }

  init(db: Database.Database): void {
    this.db = db;
  }

  /**
   * Run a full cleanup cycle. Called by cron or manually.
   */
  async run(trigger: "scheduled" | "shutdown" | "manual" = "scheduled"): Promise<void> {
    const actions: CleanupAction[] = [];
    let scanned = 0;
    let killed = 0;
    let spared = 0;

    try {
      // Snapshot live CDP state once per cycle — used to spare the active :9222
      // session in both scans and to gate the /tmp profile-dir sweep.
      this.cdp = this.buildCdpState();

      // A: Registry scan
      const registryActions = this.scanRegistry();
      actions.push(...registryActions);

      // B: OS orphan scan
      const orphanActions = this.scanOrphans();
      actions.push(...orphanActions);

      // C: Disk sweep of leaked CDP profile directories
      this.sweepCdpProfileDirs();

      scanned = actions.length;
      killed = actions.filter((a) => a.action === "killed").length;
      spared = actions.filter((a) => a.action === "spared").length;

      // Audit trail
      this.logRun(trigger, scanned, killed, spared, actions);

      if (scanned > 0) {
        logger.info(
          { trigger, scanned, killed, spared, enforce: this.enforce },
          "Cleanup cycle complete"
        );
      }
    } catch (err) {
      logger.error({ error: err, trigger }, "Cleanup cycle failed");
    }
  }

  /**
   * A: Scan registry for over-timeout and idle processes.
   */
  private scanRegistry(): CleanupAction[] {
    const actions: CleanupAction[] = [];
    const active = processRegistry.getActive();
    const now = Date.now();

    for (const record of active) {
      const age = now - record.spawnedAt;
      const idle = now - record.lastActivity;

      // Over-timeout (belt-and-suspenders with TimeoutManager)
      // timeoutMs: 0 means "no timeout — lives until cleanup" (e.g. the long-lived
      // CDP Chrome). Such processes are exempt from BOTH timeout and idle kill:
      // nothing calls touch() on them, so the idle rule would otherwise reap a
      // perfectly healthy session every cycle. The live-CDP guard in handleProcess
      // is the backstop for the specific case of the active :9222 listener.
      if (record.timeoutMs === 0) {
        continue;
      }
      if (age > record.timeoutMs * 1.5) {
        actions.push(this.handleProcess(record, `over-timeout: age=${(age / 60000).toFixed(1)}min`));
        continue;
      }

      // Idle
      if (idle > IDLE_THRESHOLD_MS) {
        actions.push(this.handleProcess(record, `idle: ${(idle / 60000).toFixed(1)}min`));
      }
    }

    return actions;
  }

  /**
   * B: OS orphan scan via `ps`.
   */
  private scanOrphans(): CleanupAction[] {
    const actions: CleanupAction[] = [];

    try {
      // ps auxww (not aux): unlimited-width so long Chrome command lines aren't
      // truncated past the --user-data-dir flag the CDP predicate needs.
      const psOutput = execSync("ps auxww", { encoding: "utf-8", timeout: 5000 });
      const lines = psOutput.split("\n").slice(1); // Skip header

      const registeredPids = new Set(processRegistry.getAll().map((r) => r.pid));

      for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 11) continue;

        const pid = parseInt(cols[1] ?? "", 10);
        if (isNaN(pid) || pid <= 1) continue;
        if (registeredPids.has(pid)) continue; // Known to registry
        if (pid === process.pid) continue; // Self

        const cmdline = cols.slice(10).join(" ");
        const isCdpChrome = isCdpChromeCmdline(cmdline);
        const isHomerProcess = isCdpChrome || ORPHAN_PATTERNS.some((p) => new RegExp(p).test(cmdline));
        if (!isHomerProcess) continue;

        // Never reap a CDP Chrome unless we have TRUSTED state proving it is not
        // the live :9222 session. If listener discovery failed this cycle
        // (untrusted), spare every CDP Chrome — we cannot tell which one is live.
        if (isCdpChrome) {
          const dir = extractCdpProfileDir(cmdline);
          const isLive = this.cdp.listenerPids.has(pid) || (!!dir && this.cdp.liveProfileDirs.has(dir));
          if (!this.cdp.trusted || isLive) {
            actions.push({
              pid,
              command: cmdline.slice(0, 100),
              action: "spared",
              reason: isLive ? "live cdp session" : "cdp state untrusted",
            });
            continue;
          }
        }

        // Safety: Check parent PID
        if (!this.isSafeToKillOrphan(pid, cmdline)) {
          actions.push({
            pid,
            command: cmdline.slice(0, 100),
            action: "spared",
            reason: "orphan: failed safety checks",
          });
          continue;
        }

        actions.push(
          this.handleOrphan(pid, cmdline.slice(0, 100))
        );
      }
    } catch (err) {
      logger.debug({ error: err }, "Orphan scan failed");
    }

    return actions;
  }

  /**
   * Snapshot live CDP state: which PIDs are LISTENing on :9222, which profile
   * dirs back them, and which profile dirs are referenced by any running Chrome.
   */
  private buildCdpState(): CdpState {
    const listenerPids = new Set<number>();
    const liveProfileDirs = new Set<string>();
    const referencedProfileDirs = new Set<string>();
    let psOk = false;
    let lsofOk = false;

    // Any running Chrome process referencing a /tmp CDP profile dir.
    try {
      const psOutput = execSync("ps auxww", { encoding: "utf-8", timeout: 5000 });
      for (const line of psOutput.split("\n").slice(1)) {
        const cmdline = line.trim().split(/\s+/).slice(10).join(" ");
        if (!isCdpChromeCmdline(cmdline)) continue;
        const dir = extractCdpProfileDir(cmdline);
        if (dir) referencedProfileDirs.add(dir);
      }
      psOk = true;
    } catch (err) {
      logger.debug({ error: err }, "CDP ps scan failed");
    }

    // The live listener(s) on the CDP port and their profile dirs.
    // Use spawnSync (no shell `|| true`) so we can tell "lsof ran, found nothing"
    // (status 0/1, empty) from "lsof failed to run" (ENOENT/timeout → result.error
    // or null status). Only a real run counts as trusted; otherwise fail closed.
    const r = spawnSync("lsof", ["-nP", `-iTCP:${CDP_PORT}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf-8",
      timeout: 2000,
    });
    if (r.error || r.status === null) {
      logger.debug({ error: r.error, signal: r.signal }, "CDP lsof scan failed (untrusted)");
    } else {
      for (const raw of (r.stdout ?? "").trim().split("\n").filter(Boolean)) {
        const pid = Number(raw);
        if (!Number.isFinite(pid) || pid <= 1) continue;
        listenerPids.add(pid);
        const dir = extractCdpProfileDir(this.getCmdline(pid));
        if (dir) liveProfileDirs.add(dir);
      }
      lsofOk = true; // lsof executed; empty result legitimately means "no listeners"
    }

    // Trusted only if BOTH scans succeeded — the disk sweep depends on this to
    // avoid deleting a live profile dir when process discovery is unavailable.
    return { listenerPids, liveProfileDirs, referencedProfileDirs, trusted: psOk && lsofOk };
  }

  private getCmdline(pid: number): string {
    try {
      return execSync(`ps -ww -o command= -p ${pid}`, { encoding: "utf-8", timeout: 2000 }).trim();
    } catch {
      return "";
    }
  }

  /**
   * C: Delete leaked /tmp/chrome-cdp-profile-* directories. A dir is removed only
   * when ALL hold: older than the grace period, not the live profile, not
   * referenced by any running Chrome, and confirmed stale on a fresh re-check.
   */
  private sweepCdpProfileDirs(): void {
    // Fail closed: if process/listener discovery failed this cycle, we cannot
    // prove any dir is dead — skip the sweep entirely rather than risk the live one.
    if (!this.cdp.trusted) {
      logger.debug("Skipping CDP profile sweep — CDP state untrusted (ps/lsof failed)");
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync("/tmp").filter((n) => n.startsWith("chrome-cdp-profile-"));
    } catch {
      return;
    }

    const now = Date.now();
    for (const name of entries) {
      const dir = join("/tmp", name);
      try {
        const st = statSync(dir);
        const ageMs = now - Math.max(st.birthtimeMs || 0, st.mtimeMs);
        if (ageMs < CDP_PROFILE_MIN_AGE_MS) continue;
        if (this.cdp.liveProfileDirs.has(dir) || this.cdp.referencedProfileDirs.has(dir)) continue;

        // Fresh re-check just before deletion — guards the launch race where a
        // brand-new profile dir exists before Chrome starts listening. Also
        // fail-closed: an untrusted re-check must not authorize deletion.
        const fresh = this.buildCdpState();
        if (!fresh.trusted) continue;
        if (fresh.liveProfileDirs.has(dir) || fresh.referencedProfileDirs.has(dir)) continue;

        if (this.enforce) {
          rmSync(dir, { recursive: true, force: true });
          logger.info({ dir }, "Swept stale CDP profile dir");
        } else {
          logger.warn({ dir }, "MONITOR: Would delete stale CDP profile dir");
        }
      } catch {
        // Best effort — dir may have vanished between readdir and stat.
      }
    }
  }

  /**
   * 6-layer safety check for registry processes.
   */
  private handleProcess(record: ProcessRecord, reason: string): CleanupAction {
    // Layer 1: PID safety
    if (record.pid <= 1 || record.pid === process.pid) {
      return { pid: record.pid, command: record.command, action: "spared", reason: "protected PID" };
    }

    // Layer 1b: never kill the live CDP listener (backstop to the timeoutMs:0 exemption).
    if (record.command === "chrome-cdp" && this.cdp.listenerPids.has(record.pid)) {
      return { pid: record.pid, command: record.command, action: "spared", reason: "live cdp listener" };
    }

    // Layer 2: Check cli_runs for active status
    if (this.db && record.runId != null) {
      try {
        const row = this.db
          .prepare("SELECT status FROM cli_runs WHERE id = ?")
          .get(record.runId as string) as { status: string } | undefined;
        if (row?.status === "running") {
          return { pid: record.pid, command: record.command, action: "spared", reason: "active cli_run" };
        }
      } catch { /* proceed */ }
    }

    // Layer 3: Check scheduled_job_state
    if (this.db && record.jobId != null) {
      try {
        const row = this.db
          .prepare("SELECT is_running FROM scheduled_job_state WHERE job_id = ?")
          .get(record.jobId as string) as { is_running: number } | undefined;
        if (row?.is_running === 1) {
          return { pid: record.pid, command: record.command, action: "spared", reason: "active scheduled job" };
        }
      } catch { /* proceed */ }
    }

    // Layer 4: lsof for active connections (skip — expensive, rely on other checks)

    // Layer 5: Recent activity
    const idleMs = Date.now() - record.lastActivity;
    if (idleMs < RECENT_ACTIVITY_MS) {
      return { pid: record.pid, command: record.command, action: "spared", reason: "recent activity" };
    }

    // All checks passed — kill (or log in monitor mode)
    if (this.enforce) {
      processRegistry.killProcess(record, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(record.pid, 0);
          processRegistry.killProcess(record, "SIGKILL");
        } catch { /* already dead */ }
        processRegistry.unregister(record.pid);
      }, 5000);
      return { pid: record.pid, command: record.command, action: "killed", reason };
    }

    logger.warn(
      { pid: record.pid, command: record.command, reason },
      "MONITOR: Would kill process (cleanup enforcement disabled)"
    );
    return { pid: record.pid, command: record.command, action: "spared", reason: `monitor-only: ${reason}` };
  }

  /**
   * Safety checks for orphan processes (not in registry).
   * - tty-less HOMER-pattern process > 6h → kill
   * - TTY-attached `claude` where etime > 6h AND TTY idle > 6h → kill (process group)
   * - otherwise spare
   */
  private isSafeToKillOrphan(pid: number, cmdline: string): boolean {
    if (pid <= 1 || pid === process.pid) return false;

    try {
      const info = execSync(`ps -o ppid=,pgid=,tty=,etime= -p ${pid}`, { encoding: "utf-8", timeout: 2000 }).trim();
      const parts = info.split(/\s+/);
      const ppid = parseInt(parts[0] ?? "", 10);
      const pgid = parseInt(parts[1] ?? "", 10);
      const tty = parts[2] ?? "";
      const etime = parts[3] ?? "";
      const ageMs = parseEtime(etime);

      if (tty && tty !== "?" && tty !== "??") {
        // Only reap abandoned interactive `claude` sessions. Codex/gemini/kimi TTY
        // processes are short-lived and exit on their own.
        if (!/\bclaude\b/.test(cmdline)) return false;
        if (ageMs <= ORPHAN_AGE_KILL_MS) return false;
        const ttyIdleMs = getTtyIdleMs(tty);
        if (ttyIdleMs <= ORPHAN_AGE_KILL_MS) return false;
        logger.info(
          {
            pid,
            pgid,
            ageHours: (ageMs / 3600_000).toFixed(1),
            ttyIdleHours: (ttyIdleMs / 3600_000).toFixed(1),
          },
          "Stale TTY claude session, safe to kill"
        );
        return true;
      }

      // Always safe to kill tty-less if parent is init (1) or our daemon
      if (ppid === 1 || ppid === process.pid) return true;

      // Age-based: kill any tty-less HOMER process older than 6 hours regardless of parent
      if (ageMs > ORPHAN_AGE_KILL_MS) {
        logger.info(
          { pid, ppid, ageHours: (ageMs / 3600_000).toFixed(1) },
          "Orphan process exceeds age threshold, safe to kill"
        );
        return true;
      }

      // Young tty-less process with non-daemon parent — spare it
      return false;
    } catch {
      return false;
    }
  }

  private handleOrphan(pid: number, command: string): CleanupAction {
    if (this.enforce) {
      try {
        // If PID is its own process-group leader, signal the whole group so
        // MCP/tool children (mcp-remote, notebooklm-mcp, tsserver, etc.) die too.
        // Otherwise fall back to PID-only to avoid hitting the wrong group.
        const target = isProcessGroupLeader(pid) ? -pid : pid;
        process.kill(target, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(target, 0);
            process.kill(target, "SIGKILL");
          } catch { /* already dead */ }
        }, 5000);
        return { pid, command, action: "killed", reason: "orphan: not in registry" };
      } catch {
        return { pid, command, action: "spared", reason: "orphan: kill failed" };
      }
    }

    logger.warn(
      { pid, command },
      "MONITOR: Would kill orphan process (cleanup enforcement disabled)"
    );
    return { pid, command, action: "spared", reason: "monitor-only: orphan" };
  }

  private logRun(
    trigger: string,
    scanned: number,
    killed: number,
    spared: number,
    actions: CleanupAction[]
  ): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO process_cleanup_runs (trigger, processes_scanned, processes_killed, processes_spared, details)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(trigger, scanned, killed, spared, JSON.stringify(actions));
    } catch {
      // Best effort
    }
  }
}

/**
 * TTY device activity on macOS/devfs: atime moves on input read, mtime on output write.
 * Use max of the two so we capture both directions of terminal I/O.
 */
function getTtyIdleMs(tty: string): number {
  try {
    const dev = `/dev/${tty}`;
    const s = statSync(dev);
    return Date.now() - Math.max(s.atimeMs, s.mtimeMs);
  } catch {
    return 0; // unreadable → treat as active (spare)
  }
}

function isProcessGroupLeader(pid: number): boolean {
  try {
    const pgid = parseInt(
      execSync(`ps -o pgid= -p ${pid}`, { encoding: "utf-8", timeout: 2000 }).trim(),
      10
    );
    return pgid === pid;
  } catch {
    return false;
  }
}

/**
 * Parse ps etime format (DD-HH:MM:SS, HH:MM:SS, or MM:SS) into milliseconds.
 */
function parseEtime(etime: string): number {
  let days = 0;
  let rest = etime.trim();

  // Handle DD- prefix
  const dayMatch = rest.match(/^(\d+)-(.+)$/);
  if (dayMatch) {
    days = parseInt(dayMatch[1]!, 10);
    rest = dayMatch[2]!;
  }

  const parts = rest.split(":").map((p) => parseInt(p, 10));
  let hours = 0, minutes = 0, seconds = 0;

  if (parts.length === 3) {
    [hours, minutes, seconds] = parts as [number, number, number];
  } else if (parts.length === 2) {
    [minutes, seconds] = parts as [number, number];
  } else if (parts.length === 1) {
    seconds = parts[0] ?? 0;
  }

  return ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
}

export const cleanupScheduler = new CleanupScheduler();
