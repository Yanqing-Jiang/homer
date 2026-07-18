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
import {
  copyFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
} from "fs";
import { basename, dirname, join } from "path";
import { processRegistry } from "./registry.js";
import type { ProcessRecord } from "./registry.js";
import { logger } from "../utils/logger.js";
import { teardownIdleSession, getLastCdpUseAt } from "../scraping/chrome-launcher.js";
import { getRuntimePaths } from "../utils/runtime-paths.js";
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
// DEBT: substring ORPHAN_PATTERNS + registry lacks protected-PID concept; upgrade when next cleanup false-positive is observed (see output/codex/outage-fixplan-review-2026-07-15-1425.md P1-4)

// CDP scraping Chrome lifecycle. These are matched by a dedicated predicate
// (isCdpChromeCmdline) rather than a bare ORPHAN_PATTERNS regex, because a loose
// "chrome-cdp-profile" string also matches unrelated command lines (e.g. an agent
// prompt that merely mentions the path). The live :9222 listener is always spared.
const CDP_PORT = 9222;
const CDP_PROFILE_PREFIX = "/tmp/chrome-cdp-profile-";
const CDP_PROFILE_MIN_AGE_MS = 30 * 60 * 1000; // grace period before sweeping a /tmp profile dir
// Idle-teardown of the long-lived CDP Chrome (it is spared by every other path by
// design). Gated on a long idle window — scrapes are seconds-long, so a 2h-idle
// instance has nothing mid-flight — AND a tab-count floor so a healthy reused
// single-tab session is left warm; only an actual tab pile-up triggers teardown.
const CDP_IDLE_TEARDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const CDP_MAX_IDLE_TABS = 3;
const MIB = 1024 * 1024;
const LOG_RETENTION_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const LOG_RETENTION_MAX_FILES = 200;

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

interface LogMaintenanceSummary {
  rotated: number;
  pruned: number;
  errors: string[];
}

interface CleanupRunSummary {
  scanned: number;
  killed: number;
  spared: number;
  logMaintenance: LogMaintenanceSummary;
}

interface RotationTarget {
  path: string;
  maxBytes: number;
  generations: number;
}

interface RetentionTarget {
  dir: string;
  maxAgeMs: number;
  maxFiles: number;
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

interface ProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

interface ProtectedTopology {
  ancestors: Set<number>;
  pgids: Set<number>;
}

type GuardedSignalResult = "signaled" | "gone" | "pid-reuse" | "protected" | "failed";

export class CleanupScheduler {
  private db: Database.Database | null = null;
  private enforce: boolean;
  /** CDP process/profile snapshot for the current run (rebuilt each cycle). */
  private cdp: CdpState = { listenerPids: new Set(), liveProfileDirs: new Set(), referencedProfileDirs: new Set(), trusted: false };
  /** Daemon ancestry and process groups protected for the current cleanup cycle. */
  private protectedTopology: ProtectedTopology | null = null;

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
  async run(trigger: "scheduled" | "shutdown" | "manual" = "scheduled"): Promise<CleanupRunSummary> {
    const actions: CleanupAction[] = [];
    let scanned = 0;
    let killed = 0;
    let spared = 0;
    let logMaintenance = emptyLogMaintenanceSummary();

    try {
      // Build the signal fence before any phase can decide to kill a process.
      this.protectedTopology = this.buildProtectedTopology();
      if (!this.protectedTopology) {
        logger.warn("Skipping orphan-kill phase — daemon process topology could not be read");
      }

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

      // D: Tear down the long-lived CDP Chrome if it is idle with piled-up tabs.
      await this.maybeTeardownIdleCdp(actions);

      // E: Log lifecycle maintenance. Copy-truncate keeps launchd/cloudflared
      // file descriptors valid without booting anything.
      logMaintenance = this.maintainLogs();

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

    return { scanned, killed, spared, logMaintenance };
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

    // Fail closed: without a complete ancestry/PGID snapshot, no orphan can be
    // proven independent of the daemon and its launchd supervisor.
    if (!this.protectedTopology) return actions;

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
        if (pid === process.pid || this.protectedTopology.ancestors.has(pid)) continue;

        // Pre-filter on the snapshot cmdline so the per-PID `ps` identity read
        // only runs for actual candidates — one execSync per PID across ~700
        // processes blocks the event loop ~15s, which the heartbeat probe
        // converts into an emergency restart (2026-07-18 restart storm).
        const snapshotCmdline = cols.slice(10).join(" ");
        const matchesHomer = (cmd: string) =>
          isCdpChromeCmdline(cmd) || ORPHAN_PATTERNS.some((p) => new RegExp(p).test(cmd));
        if (!matchesHomer(snapshotCmdline)) continue;

        const identity = this.readProcessIdentity(pid);
        if (!identity) continue;
        const cmdline = identity.command;
        // Fail closed on PID reuse: the authoritative identity must still match.
        if (!matchesHomer(cmdline)) continue;
        const isCdpChrome = isCdpChromeCmdline(cmdline);

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
        if (!this.isSafeToKillOrphan(identity)) {
          actions.push({
            pid,
            command: cmdline.slice(0, 100),
            action: "spared",
            reason: "orphan: failed safety checks",
          });
          continue;
        }

        actions.push(
          this.handleOrphan(identity, cmdline.slice(0, 100))
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
   * D: Tear down the long-lived CDP scraping Chrome when it is idle AND its tabs
   * have piled up. The live :9222 listener is spared by every other path (by
   * design, so an in-flight scrape is never killed); this is the one sanctioned
   * reaper. The checks here are a cheap pre-filter — the AUTHORITATIVE idle
   * re-check happens inside teardownIdleSession under the CDP op lock, which also
   * closes the race with a scrape that starts after this pre-filter passes.
   */
  private async maybeTeardownIdleCdp(actions: CleanupAction[]): Promise<void> {
    try {
      // Need trusted process/listener state and an actual Homer-owned live
      // listener (liveProfileDirs is only populated for cmdline-verified CDP
      // Chromes — a non-Homer listener on :9222 never lands here).
      if (!this.cdp.trusted) return;
      if (this.cdp.liveProfileDirs.size === 0) return;

      const idleMs = Date.now() - getLastCdpUseAt();
      if (idleMs < CDP_IDLE_TEARDOWN_MS) return;

      const pid = [...this.cdp.listenerPids][0] ?? 0;
      const idleMin = Math.round(idleMs / 60000);
      const pageProbe = await countCdpPages(CDP_PORT);
      if (!pageProbe.ok) {
        logger.warn({ pid, idleMin, reason: pageProbe.reason }, "MONITOR: CDP page probe failed; skipping idle teardown");
        actions.push({ pid, command: "chrome-cdp", action: "spared", reason: `cdp page probe failed: ${pageProbe.reason}` });
        return;
      }

      const tabs = pageProbe.pages;
      if (tabs === 0) {
        logger.warn({ pid, idleMin }, "MONITOR: Idle CDP Chrome has no page targets; empty-session teardown disabled");
        actions.push({ pid, command: "chrome-cdp", action: "spared", reason: `monitor-only: idle ${idleMin}min, 0 tabs; empty teardown disabled` });
        return;
      }

      if (tabs <= CDP_MAX_IDLE_TABS) return;

      if (!this.enforce) {
        logger.warn({ pid, tabs, idleMin }, "MONITOR: Would tear down idle CDP Chrome");
        actions.push({ pid, command: "chrome-cdp", action: "spared", reason: `monitor-only: idle ${idleMin}min, ${tabs} tabs` });
        return;
      }

      const outcome = await teardownIdleSession(CDP_IDLE_TEARDOWN_MS, CDP_PORT);
      if (outcome === "torn-down") {
        logger.info({ pid, tabs, idleMin }, "Tore down idle CDP Chrome with tab pile-up");
        actions.push({ pid, command: "chrome-cdp", action: "killed", reason: `idle ${idleMin}min, ${tabs} tabs` });
      } else {
        // "busy" (a scrape stamped lastCdpUseAt before we got the lock) or
        // "absent" (already gone) — both benign, just record it.
        actions.push({ pid, command: "chrome-cdp", action: "spared", reason: `idle teardown skipped: ${outcome}` });
      }
    } catch (err) {
      logger.debug({ error: err }, "Idle CDP teardown check failed");
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

    const identity = this.readProcessIdentity(record.pid);
    if (!identity) {
      return { pid: record.pid, command: record.command, action: "spared", reason: "process no longer exists" };
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
      const groupPgid = record.pgid === identity.pgid ? identity.pgid : undefined;
      const result = this.guardedSignal(identity, "SIGTERM", groupPgid);
      if (result !== "signaled") {
        return {
          pid: record.pid,
          command: record.command,
          action: "spared",
          reason: result === "pid-reuse" ? "pid-reuse guard" : `signal guard: ${result}`,
        };
      }
      setTimeout(() => {
        this.guardedSignal(identity, "SIGKILL", groupPgid);
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
  private isSafeToKillOrphan(identity: ProcessIdentity): boolean {
    const { pid, ppid, pgid, command: cmdline } = identity;
    if (pid <= 1 || pid === process.pid) return false;

    try {
      const info = execSync(`ps -o tty=,etime= -p ${pid}`, { encoding: "utf-8", timeout: 2000 }).trim();
      const parts = info.split(/\s+/);
      const tty = parts[0] ?? "";
      const etime = parts[1] ?? "";
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

  private handleOrphan(identity: ProcessIdentity, command: string): CleanupAction {
    const { pid } = identity;
    if (this.enforce) {
      // PID-only is the default. A process-group leader is the sole exception,
      // and the central guard still proves its PGID does not intersect the
      // daemon/ancestor protected PGID set immediately before each signal.
      const groupPgid = identity.pgid === pid ? identity.pgid : undefined;
      const result = this.guardedSignal(identity, "SIGTERM", groupPgid);
      if (result === "signaled") {
        setTimeout(() => {
          this.guardedSignal(identity, "SIGKILL", groupPgid);
        }, 5000);
        return { pid, command, action: "killed", reason: "orphan: not in registry" };
      }
      return {
        pid,
        command,
        action: "spared",
        reason: result === "pid-reuse" ? "pid-reuse guard" : `orphan: signal guard ${result}`,
      };
    }

    logger.warn(
      { pid, command },
      "MONITOR: Would kill orphan process (cleanup enforcement disabled)"
    );
    return { pid, command, action: "spared", reason: "monitor-only: orphan" };
  }

  /**
   * Snapshot the daemon's complete ancestor chain and every PGID containing the
   * daemon or an ancestor. Any unreadable/malformed link makes the fence unusable.
   */
  private buildProtectedTopology(): ProtectedTopology | null {
    const ancestors = new Set<number>();
    const pgids = new Set<number>();
    const visited = new Set<number>();
    let pid = process.pid;

    while (pid > 0) {
      if (visited.has(pid)) return null;
      visited.add(pid);

      try {
        const raw = execSync(`ps -o ppid=,pgid= -p ${pid}`, {
          encoding: "utf-8",
          timeout: 2000,
        }).trim();
        const [ppidRaw, pgidRaw] = raw.split(/\s+/);
        const ppid = Number(ppidRaw);
        const pgid = Number(pgidRaw);
        if (!Number.isInteger(ppid) || ppid < 0 || !Number.isInteger(pgid) || pgid < 1) return null;

        pgids.add(pgid);
        if (pid !== process.pid) ancestors.add(pid);
        if (pid === 1) break;
        if (ppid <= 0) return null;
        pid = ppid;
      } catch (err) {
        logger.warn({ err, pid }, "Failed to read daemon process topology");
        return null;
      }
    }

    return ancestors.has(1) ? { ancestors, pgids } : null;
  }

  /** Read the identity fields that must remain stable between scan and signal. */
  private readProcessIdentity(pid: number): ProcessIdentity | null {
    try {
      const raw = execSync(`ps -ww -o ppid=,pgid=,command= -p ${pid}`, {
        encoding: "utf-8",
        timeout: 2000,
      }).trim();
      const match = raw.match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/);
      if (!match) return null;
      const ppid = Number(match[1]);
      const pgid = Number(match[2]);
      const command = match[3] ?? "";
      if (!Number.isInteger(ppid) || ppid < 0 || !Number.isInteger(pgid) || pgid < 1 || !command) return null;
      return { pid, ppid, pgid, command };
    } catch {
      return null;
    }
  }

  /**
   * The only process.kill call in this module. Re-check identity and topology
   * immediately before every PID or process-group signal, including escalation.
   */
  private guardedSignal(
    expected: ProcessIdentity,
    signal: NodeJS.Signals,
    groupPgid?: number
  ): GuardedSignalResult {
    const topology = this.protectedTopology;
    if (
      !topology ||
      expected.pid <= 1 ||
      expected.pid === process.pid ||
      topology.ancestors.has(expected.pid)
    ) {
      logger.warn({ pid: expected.pid, signal }, "Cleanup signal guard blocked protected PID");
      return "protected";
    }

    const current = this.readProcessIdentity(expected.pid);
    if (!current) return "gone";
    if (
      current.command !== expected.command ||
      current.ppid !== expected.ppid ||
      current.pgid !== expected.pgid
    ) {
      logger.warn(
        { pid: expected.pid, signal, expected, current },
        "pid-reuse guard"
      );
      return "pid-reuse";
    }

    if (topology.pgids.has(current.pgid)) {
      logger.warn(
        { pid: current.pid, pgid: current.pgid, signal },
        "Cleanup signal guard blocked protected PGID"
      );
      return "protected";
    }

    if (groupPgid !== undefined && (groupPgid <= 1 || groupPgid !== current.pgid)) {
      logger.warn(
        { pid: current.pid, expectedPgid: groupPgid, actualPgid: current.pgid, signal },
        "Cleanup signal guard could not prove process-group identity"
      );
      return "protected";
    }

    try {
      process.kill(groupPgid === undefined ? current.pid : -groupPgid, signal);
      return "signaled";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return "gone";
      logger.warn(
        { err, pid: current.pid, pgid: groupPgid, signal },
        "Cleanup signal failed"
      );
      return "failed";
    }
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

  private maintainLogs(): LogMaintenanceSummary {
    const summary = emptyLogMaintenanceSummary();
    const runtimePaths = getRuntimePaths();
    const homerWebRoot = process.env.HOMER_WEB_ROOT ?? join(runtimePaths.homeDir, "homer-web");

    const rotationTargets: RotationTarget[] = [
      { path: join(runtimePaths.homerLogsDir, "cloudflared.log"), maxBytes: 10 * MIB, generations: 5 },
      { path: join(runtimePaths.homerLogsDir, "hooks.log"), maxBytes: 2 * MIB, generations: 5 },
      { path: join(runtimePaths.libraryLogsDir, "fatal.log"), maxBytes: 1 * MIB, generations: 5 },
      { path: join(homerWebRoot, "logs", "stdout.log"), maxBytes: 10 * MIB, generations: 5 },
      { path: join(homerWebRoot, "logs", "stderr.log"), maxBytes: 10 * MIB, generations: 5 },
    ];

    for (const target of rotationTargets) {
      try {
        if (rotateLogIfNeeded(target)) summary.rotated++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.errors.push(`${target.path}: ${message}`);
        logger.warn({ err, path: target.path }, "Log rotation failed");
      }
    }

    const retentionTargets: RetentionTarget[] = [
      { dir: join(runtimePaths.homerLogsDir, "fallback"), maxAgeMs: LOG_RETENTION_AGE_MS, maxFiles: LOG_RETENTION_MAX_FILES },
      { dir: join(runtimePaths.libraryLogsDir, "crash-reports"), maxAgeMs: LOG_RETENTION_AGE_MS, maxFiles: LOG_RETENTION_MAX_FILES },
    ];

    for (const target of retentionTargets) {
      try {
        summary.pruned += sweepRetainedFiles(target);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        summary.errors.push(`${target.dir}: ${message}`);
        logger.warn({ err, dir: target.dir }, "Log retention sweep failed");
      }
    }

    if (summary.rotated > 0 || summary.pruned > 0) {
      logger.info(summary, "Log lifecycle maintenance complete");
    }

    return summary;
  }
}

function emptyLogMaintenanceSummary(): LogMaintenanceSummary {
  return { rotated: 0, pruned: 0, errors: [] };
}

function rotateLogIfNeeded(target: RotationTarget): boolean {
  if (!existsSync(target.path)) return false;
  const st = statSync(target.path);
  if (!st.isFile() || st.size < target.maxBytes) return false;

  const bzip2 = existsSync("/usr/bin/bzip2") ? "/usr/bin/bzip2" : "bzip2";
  const tmpBase = join(dirname(target.path), `.${basename(target.path)}.${process.pid}.${Date.now()}.rotate`);
  copyFileSync(target.path, tmpBase);
  truncateSync(target.path, 0);

  const result = spawnSync(bzip2, ["-f", tmpBase], { encoding: "utf-8", timeout: 120_000 });
  if (result.error || result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(stderr || result.error?.message || `bzip2 exited ${result.status}`);
  }

  shiftCompressedGenerations(target.path, target.generations);
  renameSync(`${tmpBase}.bz2`, `${target.path}.0.bz2`);
  logger.info(
    { path: target.path, sizeBytes: st.size, maxBytes: target.maxBytes, generations: target.generations },
    "Rotated log with copy-truncate"
  );
  return true;
}

function shiftCompressedGenerations(filePath: string, generations: number): void {
  for (let i = generations - 1; i >= 0; i--) {
    const from = `${filePath}.${i}.bz2`;
    if (!existsSync(from)) continue;
    if (i === generations - 1) {
      rmSync(from, { force: true });
      continue;
    }
    renameSync(from, `${filePath}.${i + 1}.bz2`);
  }
}

function sweepRetainedFiles(target: RetentionTarget): number {
  if (!existsSync(target.dir)) return 0;
  const now = Date.now();
  const entries = readdirSync(target.dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => {
      const path = join(target.dir, entry.name);
      const st = statSync(path);
      return { path, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  let pruned = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const tooOld = now - entry.mtimeMs > target.maxAgeMs;
    const beyondCount = i >= target.maxFiles;
    if (!tooOld && !beyondCount) continue;
    rmSync(entry.path, { force: true });
    pruned++;
  }
  return pruned;
}

/**
 * Count open page targets on the CDP port via its /json endpoint. Probe failures
 * stay distinct from "0 pages" so callers can fail closed.
 */
type CdpPageProbe =
  | { ok: true; pages: number }
  | { ok: false; reason: string };

async function countCdpPages(port: number): Promise<CdpPageProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const resp = await fetch(`http://localhost:${port}/json`, { signal: controller.signal });
    if (!resp.ok) return { ok: false, reason: `http ${resp.status}` };
    const list = (await resp.json()) as unknown;
    if (!Array.isArray(list)) return { ok: false, reason: "non-array response" };
    return { ok: true, pages: list.filter((t): t is { type?: string } => typeof t === "object" && t !== null && (t as { type?: unknown }).type === "page").length };
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    return { ok: false, reason: name === "AbortError" ? "timeout" : name };
  } finally {
    clearTimeout(timer);
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
