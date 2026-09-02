/**
 * CleanupScheduler — Periodic orphan/idle process cleanup.
 *
 * Runs every 2 hours. Three-pronged detection:
 * A) Registry scan for over-timeout / idle processes.
 * B) OS orphan scan via `ps` for known HOMER patterns not in registry.
 * C) Structural browser-automation scan with a 30-minute zombie grace.
 *
 * 6-layer safety before any kill. Enforcement ON by default (set PROCESS_CLEANUP_ENFORCE=0 to disable).
 * Age-based kill: tty-less HOMER-pattern process > 6h; or TTY-attached `claude` > 6h with TTY idle > 6h.
 */

import { execSync, spawnSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { processRegistry } from "./registry.js";
import type { ProcessRecord } from "./registry.js";
import {
  decideBrowserAutomationCleanup,
  extractUserDataDir,
  isAgentBrowserArtifactFilename,
  isAgentBrowserDaemonCmdline,
  isChromeFamilyCmdline,
  isTempBrowserProfileDir,
  isTempProfileHeadlessChromeCmdline,
  normalizeBrowserProfileDir,
  type BrowserAutomationCleanupDecision,
  type BrowserAutomationKind,
} from "./browser-zombie-classifier.js";
import { logger } from "../utils/logger.js";
import { teardownIdleSession, getLastCdpUseAt, isResidentChromeSupervisionActive, probeCdp, RESIDENT_CDP_PROFILE, type CdpProbe } from "../scraping/chrome-launcher.js";
import { BROWSER_STATUS_PATH } from "../scraping/browser-control.js";
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
// DEBT: browser automation now has structural classifiers plus a protected-PID
// fence. General CLI ORPHAN_PATTERNS remain substring-based; replace them with
// executable/argv ownership checks when that scanner is next revised (P1-4).

// Browser Chrome lifecycle uses structural executable/profile predicates rather
// than ORPHAN_PATTERNS, so prompt text that mentions a profile never authorizes a
// signal. The live :9222 listener and broker status PIDs are always spared.
const CDP_PORT = 9222;
const CDP_PROFILE_MIN_AGE_MS = 30 * 60 * 1000; // shared grace for browser processes and artifacts
const AGENT_BROWSER_FALLBACK_SOCKET_DIR = "/tmp/ab";
// Idle-teardown of the long-lived CDP Chrome (it is spared by every other path by
// design). Gated on a long idle window — scrapes are seconds-long, so a 2h-idle
// instance has nothing mid-flight — AND a tab-count floor so a healthy reused
// single-tab session is left warm; only an actual tab pile-up triggers teardown.
const CDP_IDLE_TEARDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const CDP_MAX_IDLE_TABS = 3;
const MIB = 1024 * 1024;
const LOG_RETENTION_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const LOG_RETENTION_MAX_FILES = 200;

interface ConfiguredGuiCleanupTarget {
  label: string;
  bundleId: string;
  executablePath: string;
  quitScript: string;
  /** Finder is a desktop-shell refresh: launchservices normally relaunches it. */
  relaunches: boolean;
}

// User-approved GUI apps that should not remain resident between manual uses.
// Exact executable paths are required so cleanup cannot signal a similarly named
// process. The frontmost app is always spared to avoid interrupting active work.
const CONFIGURED_GUI_CLEANUP_TARGETS: readonly ConfiguredGuiCleanupTarget[] = [
  {
    label: "Microsoft Azure Storage Explorer",
    bundleId: "com.microsoft.StorageExplorer",
    executablePath: "/Applications/Microsoft Azure Storage Explorer.app/Contents/MacOS/Microsoft Azure Storage Explorer",
    quitScript: 'tell application id "com.microsoft.StorageExplorer" to quit',
    relaunches: false,
  },
  {
    label: "Pages",
    bundleId: "com.apple.iWork.Pages",
    executablePath: "/Applications/Pages.app/Contents/MacOS/Pages",
    quitScript: 'tell application id "com.apple.iWork.Pages" to quit saving yes',
    relaunches: false,
  },
  {
    label: "Finder",
    bundleId: "com.apple.finder",
    executablePath: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
    quitScript: 'tell application id "com.apple.finder" to quit',
    relaunches: true,
  },
];

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

interface BrokerProtectionState {
  protectedPids: Set<number>;
  profileDirs: Set<string>;
}

interface AgentSocketState {
  livePaths: Set<string>;
  ownerPids: Set<number>;
  trusted: boolean;
}

interface ProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

interface ProcessSnapshot extends ProcessIdentity {
  ageMs: number;
}

interface ProcessTableState {
  processes: Map<number, ProcessSnapshot>;
  trusted: boolean;
}

interface BrowserAutomationCandidate {
  kind: BrowserAutomationKind;
  ageMs: number;
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
  /** Explicit no-signal fence: daemon topology, registry, broker status and :9222. */
  private protectedPids = new Set<number>();
  private broker: BrokerProtectionState = { protectedPids: new Set(), profileDirs: new Set([RESIDENT_CDP_PROFILE]) };
  private agentSockets: AgentSocketState = { livePaths: new Set(), ownerPids: new Set(), trusted: false };

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
      this.broker = this.readBrokerProtectionState();
      this.agentSockets = this.buildAgentSocketState();
      this.rebuildProtectedPidFence();

      // A: Registry scan
      const registryActions = this.scanRegistry();
      actions.push(...registryActions);

      // B: OS orphan scan
      const orphanActions = this.scanOrphans();
      actions.push(...orphanActions);

      // C: Browser-automation zombies have their own structural classifiers and
      // shorter grace window; the general CLI orphan policy above is unchanged.
      const browserActions = this.scanBrowserAutomation();
      actions.push(...browserActions);

      // D: Disk sweep of leaked throwaway Chrome profiles and dead AB sockets.
      this.sweepCdpProfileDirs();
      this.sweepAgentBrowserArtifacts();

      // E: Tear down the long-lived CDP Chrome if it is idle with piled-up tabs.
      await this.maybeTeardownIdleCdp(actions);

      // F: Log lifecycle maintenance. Copy-truncate keeps launchd/cloudflared
      // file descriptors valid without booting anything.
      logMaintenance = this.maintainLogs();

      // G: Terminate user-approved GUI apps that are only opened on demand.
      // Finder is included as a refresh target and is expected to relaunch.
      actions.push(...this.cleanupConfiguredGuiApps());

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
        if (this.protectedPids.has(pid) || this.protectedTopology.ancestors.has(pid)) continue;

        // Pre-filter on the snapshot cmdline so the per-PID `ps` identity read
        // only runs for actual candidates — one execSync per PID across ~700
        // processes blocks the event loop ~15s, which the heartbeat probe
        // converts into an emergency restart (2026-07-18 restart storm).
        const snapshotCmdline = cols.slice(10).join(" ");
        const matchesHomer = (cmd: string) =>
          ORPHAN_PATTERNS.some((p) => new RegExp(p).test(cmd));
        if (!matchesHomer(snapshotCmdline)) continue;

        const identity = this.readProcessIdentity(pid);
        if (!identity) continue;
        const cmdline = identity.command;
        // Fail closed on PID reuse: the authoritative identity must still match.
        if (!matchesHomer(cmdline)) continue;
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
   * C: Structurally classify browser-automation processes. These candidates use
   * the existing 30-minute profile grace, then pass the category-specific guard
   * again immediately before every TERM/KILL signal.
   */
  private scanBrowserAutomation(): CleanupAction[] {
    const actions: CleanupAction[] = [];
    if (!this.protectedTopology) return actions;

    const table = this.readProcessTable();
    if (!table.trusted) {
      logger.debug("Skipping browser-automation scan — process table unavailable");
      return actions;
    }

    for (const snapshot of table.processes.values()) {
      const kind: BrowserAutomationKind | null = isTempProfileHeadlessChromeCmdline(snapshot.command)
        ? "temp-profile-chrome"
        : isAgentBrowserDaemonCmdline(snapshot.command)
          ? "agent-browser-daemon"
          : null;
      if (!kind) continue;

      const authoritative = this.readProcessIdentity(snapshot.pid);
      if (!authoritative || authoritative.command !== snapshot.command || authoritative.ppid !== snapshot.ppid) continue;
      const candidate = { kind, ageMs: snapshot.ageMs } satisfies BrowserAutomationCandidate;
      const decision = this.evaluateBrowserCandidate(authoritative, candidate, table, this.cdp, this.broker, this.agentSockets);
      if (decision.action === "spare") {
        actions.push({ pid: snapshot.pid, command: snapshot.command.slice(0, 100), action: "spared", reason: decision.reason });
        continue;
      }
      actions.push(this.handleBrowserAutomation(authoritative, candidate, decision.reason));
    }

    return actions;
  }

  private evaluateBrowserCandidate(
    identity: ProcessIdentity,
    candidate: BrowserAutomationCandidate,
    table: ProcessTableState,
    cdp: CdpState,
    broker: BrokerProtectionState,
    sockets: AgentSocketState,
  ): BrowserAutomationCleanupDecision {
    const browserProtectedPids = new Set(this.protectedPids);
    for (const record of processRegistry.getActive()) browserProtectedPids.add(record.pid);
    const parent = table.processes.get(identity.ppid);
    const liveAncestor = identity.ppid > 1 && parent !== undefined;
    let owningToolGone = identity.ppid === 1;
    if (!owningToolGone && parent && isAgentBrowserDaemonCmdline(parent.command)) {
      // A reparented daemon with no listening session socket no longer owns its
      // fallback Chrome, even though the native daemon process still exists.
      owningToolGone = parent.ppid === 1 && sockets.trusted && !sockets.ownerPids.has(parent.pid);
    }

    return decideBrowserAutomationCleanup({
      kind: candidate.kind,
      pid: identity.pid,
      ppid: identity.ppid,
      command: identity.command,
      ageMs: candidate.ageMs,
      graceMs: CDP_PROFILE_MIN_AGE_MS,
      protectedPids: browserProtectedPids,
      listenerPids: cdp.listenerPids,
      listenerStateTrusted: cdp.trusted,
      brokerProfileDirs: broker.profileDirs,
      owningToolGone,
      sessionSocketAlive: sockets.ownerPids.has(identity.pid),
      liveAncestor,
      socketStateTrusted: sockets.trusted,
    });
  }

  private handleBrowserAutomation(
    identity: ProcessIdentity,
    candidate: BrowserAutomationCandidate,
    reason: string,
  ): CleanupAction {
    if (!this.enforce) {
      logger.warn({ pid: identity.pid, reason }, "MONITOR: Would kill browser-automation zombie");
      return { pid: identity.pid, command: identity.command.slice(0, 100), action: "spared", reason: `monitor-only: ${reason}` };
    }

    const result = this.guardedBrowserSignal(identity, candidate, "SIGTERM");
    if (result !== "signaled") {
      return {
        pid: identity.pid,
        command: identity.command.slice(0, 100),
        action: "spared",
        reason: `${candidate.kind}: signal guard ${result}`,
      };
    }
    setTimeout(() => {
      this.guardedBrowserSignal(identity, candidate, "SIGKILL");
    }, 5000);
    return { pid: identity.pid, command: identity.command.slice(0, 100), action: "killed", reason };
  }

  /** Refresh every browser-specific rail immediately before TERM and escalation. */
  private guardedBrowserSignal(
    expected: ProcessIdentity,
    candidate: BrowserAutomationCandidate,
    signal: NodeJS.Signals,
  ): GuardedSignalResult {
    const current = this.readProcessIdentity(expected.pid);
    if (!current) return "gone";
    if (current.command !== expected.command || current.ppid !== expected.ppid || current.pgid !== expected.pgid) return "pid-reuse";

    const table = this.readProcessTable();
    if (!table.trusted || !table.processes.has(current.pid)) return "protected";
    this.cdp = this.buildCdpState();
    this.broker = this.readBrokerProtectionState();
    this.agentSockets = this.buildAgentSocketState();
    this.rebuildProtectedPidFence();
    const decision = this.evaluateBrowserCandidate(current, candidate, table, this.cdp, this.broker, this.agentSockets);
    if (decision.action !== "kill") {
      logger.warn({ pid: current.pid, signal, reason: decision.reason }, "Browser cleanup safety guard spared process");
      return "protected";
    }
    return this.guardedSignal(expected, signal);
  }

  private readProcessTable(): ProcessTableState {
    const processes = new Map<number, ProcessSnapshot>();
    try {
      const output = execSync("ps -axo pid=,ppid=,pgid=,etime=,command= -ww", { encoding: "utf-8", timeout: 5000 });
      for (const line of output.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\s\S]+)$/);
        if (!match) continue;
        const pid = Number(match[1]);
        const ppid = Number(match[2]);
        const pgid = Number(match[3]);
        const etime = match[4] ?? "";
        const command = match[5] ?? "";
        if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || !Number.isInteger(pgid) || !command) continue;
        processes.set(pid, { pid, ppid, pgid, command, ageMs: parseEtime(etime) });
      }
      return { processes, trusted: true };
    } catch (err) {
      logger.debug({ error: err }, "Browser process-table scan failed");
      return { processes, trusted: false };
    }
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

    // Any running Chrome-family process referencing a recognized throwaway
    // profile dir. Helpers count too, so disk removal waits for the whole tree.
    try {
      const psOutput = execSync("ps auxww", { encoding: "utf-8", timeout: 5000 });
      for (const line of psOutput.split("\n").slice(1)) {
        const cmdline = line.trim().split(/\s+/).slice(10).join(" ");
        if (!isChromeFamilyCmdline(cmdline)) continue;
        const dir = extractUserDataDir(cmdline);
        if (dir && isTempBrowserProfileDir(dir)) referencedProfileDirs.add(normalizeBrowserProfileDir(dir));
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
    if (r.error || r.status === null || ![0, 1].includes(r.status)) {
      logger.debug({ error: r.error, signal: r.signal }, "CDP lsof scan failed (untrusted)");
    } else {
      for (const raw of (r.stdout ?? "").trim().split("\n").filter(Boolean)) {
        const pid = Number(raw);
        if (!Number.isFinite(pid) || pid <= 1) continue;
        listenerPids.add(pid);
        const dir = extractUserDataDir(this.getCmdline(pid));
        if (dir) liveProfileDirs.add(normalizeBrowserProfileDir(dir));
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

  private readBrokerProtectionState(): BrokerProtectionState {
    const protectedPids = new Set<number>();
    const profileDirs = new Set<string>([normalizeBrowserProfileDir(RESIDENT_CDP_PROFILE)]);
    const statusPath = process.env.HOMER_BROWSER_STATUS_FILE ?? BROWSER_STATUS_PATH;
    try {
      const raw = JSON.parse(readFileSync(statusPath, "utf-8")) as {
        supervisorPid?: unknown;
        chromePid?: unknown;
        profilePath?: unknown;
        surfaces?: Record<string, { lease?: { owner?: unknown } | null }>;
      };
      for (const pid of [raw.supervisorPid, raw.chromePid]) {
        if (Number.isInteger(pid) && Number(pid) > 1) protectedPids.add(Number(pid));
      }
      if (typeof raw.profilePath === "string" && raw.profilePath.trim()) {
        profileDirs.add(normalizeBrowserProfileDir(raw.profilePath));
      }
      for (const surface of Object.values(raw.surfaces ?? {})) {
        const owner = surface.lease?.owner;
        if (typeof owner !== "string") continue;
        // Owner-shape agnostic, matching the broker's own liveness rule
        // (browser-control.ts ownerIsDead). Matching only `browserctl-agent:<pid>` left the pid
        // behind an `abvp-refresh:<pid>:<run_id>` lease unprotected, even though the broker now
        // treats that shape as a first-class holder identity. Protecting more pids is the safe
        // direction for a cleanup fence.
        const match = owner.match(/^[^:]+:(\d+)(?::|$)/);
        if (match && Number(match[1]) > 1) protectedPids.add(Number(match[1]));
      }
    } catch (err) {
      // The immutable broker profile and live listener fence still apply even
      // when the additive status-file PID fence is unavailable.
      logger.debug({ error: err, statusPath }, "Browser broker status unreadable");
    }
    return { protectedPids, profileDirs };
  }

  private buildAgentSocketState(): AgentSocketState {
    const livePaths = new Set<string>();
    const ownerPids = new Set<number>();
    const socketDirs = new Set([AGENT_BROWSER_FALLBACK_SOCKET_DIR]);
    const configured = process.env.AGENT_BROWSER_SOCKET_DIR?.trim();
    if (configured?.startsWith("/")) socketDirs.add(configured.replace(/\/+$/, ""));

    const result = spawnSync("lsof", ["-nP", "-U", "-Fpn"], { encoding: "utf-8", timeout: 5000 });
    if (result.error || result.status === null || ![0, 1].includes(result.status)) {
      logger.debug({ error: result.error, status: result.status }, "Agent-browser socket scan failed (untrusted)");
      return { livePaths, ownerPids, trusted: false };
    }

    let ownerPid = 0;
    for (const line of (result.stdout ?? "").split("\n")) {
      if (line.startsWith("p")) {
        ownerPid = Number(line.slice(1));
        continue;
      }
      if (!line.startsWith("n") || ownerPid <= 1) continue;
      const socketPath = line.slice(1);
      if (![...socketDirs].some((dir) => socketPath.startsWith(`${dir}/`))) continue;
      livePaths.add(socketPath);
      ownerPids.add(ownerPid);
    }
    return { livePaths, ownerPids, trusted: true };
  }

  private rebuildProtectedPidFence(): void {
    const protectedPids = new Set<number>([process.pid]);
    for (const pid of this.protectedTopology?.ancestors ?? []) protectedPids.add(pid);
    for (const pid of this.cdp.listenerPids) protectedPids.add(pid);
    for (const pid of this.broker.protectedPids) protectedPids.add(pid);
    this.protectedPids = protectedPids;
  }

  /** Delete recognized throwaway Chrome profiles after process/listener re-checks. */
  private sweepCdpProfileDirs(): void {
    // Fail closed: if process/listener discovery failed this cycle, we cannot
    // prove any dir is dead — skip the sweep entirely rather than risk the live one.
    if (!this.cdp.trusted) {
      logger.debug("Skipping CDP profile sweep — CDP state untrusted (ps/lsof failed)");
      return;
    }

    const now = Date.now();
    for (const dir of this.discoverTempBrowserProfileDirs()) {
      try {
        const st = lstatSync(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        const ageMs = now - Math.max(st.birthtimeMs || 0, st.mtimeMs);
        if (ageMs < CDP_PROFILE_MIN_AGE_MS) continue;
        const normalized = normalizeBrowserProfileDir(dir);
        if (this.cdp.liveProfileDirs.has(normalized) || this.cdp.referencedProfileDirs.has(normalized)) continue;
        if ([...this.broker.profileDirs].some((profile) => normalizeBrowserProfileDir(profile) === normalized)) continue;

        // Fresh re-check just before deletion — guards the launch race where a
        // brand-new profile dir exists before Chrome starts listening. Also
        // fail-closed: an untrusted re-check must not authorize deletion.
        const fresh = this.buildCdpState();
        if (!fresh.trusted) continue;
        const freshBroker = this.readBrokerProtectionState();
        if (fresh.liveProfileDirs.has(normalized) || fresh.referencedProfileDirs.has(normalized)) continue;
        if ([...freshBroker.profileDirs].some((profile) => normalizeBrowserProfileDir(profile) === normalized)) continue;

        if (this.enforce) {
          rmSync(dir, { recursive: true, force: true });
          logger.info({ dir }, "Swept stale browser-automation temp profile");
        } else {
          logger.warn({ dir }, "MONITOR: Would delete stale browser-automation temp profile");
        }
      } catch {
        // Best effort — dir may have vanished between readdir and stat.
      }
    }
  }

  private discoverTempBrowserProfileDirs(): Set<string> {
    const roots = new Set<string>(["/tmp", tmpdir()]);
    // tmpdir() covers the current user; this bounded two-level walk also finds
    // leftovers from older macOS temp buckets without recursing arbitrary trees.
    try {
      for (const shard of readdirSync("/var/folders", { withFileTypes: true })) {
        if (!shard.isDirectory()) continue;
        const shardPath = join("/var/folders", shard.name);
        try {
          for (const bucket of readdirSync(shardPath, { withFileTypes: true })) {
            if (bucket.isDirectory()) roots.add(join(shardPath, bucket.name, "T"));
          }
        } catch { /* inaccessible bucket */ }
      }
    } catch { /* non-macOS or inaccessible temp root */ }

    const profiles = new Set<string>();
    for (const root of roots) {
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const path = join(root, entry.name);
          if (isTempBrowserProfileDir(path)) profiles.add(normalizeBrowserProfileDir(path));
        }
      } catch { /* best effort */ }
    }
    return profiles;
  }

  /** Remove only old, paired, dead session sockets and their matching PID file. */
  private sweepAgentBrowserArtifacts(): void {
    if (!this.agentSockets.trusted) {
      logger.debug("Skipping agent-browser artifact sweep — socket state untrusted");
      return;
    }
    let names: Set<string>;
    try {
      names = new Set(readdirSync(AGENT_BROWSER_FALLBACK_SOCKET_DIR).filter(isAgentBrowserArtifactFilename));
    } catch {
      return;
    }

    const now = Date.now();
    for (const sockName of names) {
      if (!sockName.endsWith(".sock")) continue;
      const base = sockName.slice(0, -".sock".length);
      const pidName = `${base}.pid`;
      if (!names.has(pidName)) continue;
      const socketPath = join(AGENT_BROWSER_FALLBACK_SOCKET_DIR, sockName);
      const pidPath = join(AGENT_BROWSER_FALLBACK_SOCKET_DIR, pidName);
      try {
        const socketStat = lstatSync(socketPath);
        const pidStat = lstatSync(pidPath);
        // The .sock must truly be a Unix socket and its paired .pid a regular
        // file. This is the guard that excludes screenshots and all other files.
        if (!socketStat.isSocket() || !pidStat.isFile() || pidStat.isSymbolicLink()) continue;
        const newestMs = Math.max(socketStat.birthtimeMs || 0, socketStat.mtimeMs, pidStat.birthtimeMs || 0, pidStat.mtimeMs);
        if (now - newestMs < CDP_PROFILE_MIN_AGE_MS) continue;
        if (this.agentSockets.livePaths.has(socketPath)) continue;

        const recordedPid = Number(readFileSync(pidPath, "utf-8").trim());
        if (Number.isInteger(recordedPid) && recordedPid > 1) {
          const identity = this.readProcessIdentity(recordedPid);
          if (identity && isAgentBrowserDaemonCmdline(identity.command)) continue;
        }

        // Fresh lsof immediately before unlink closes the scan/delete race.
        const fresh = this.buildAgentSocketState();
        if (!fresh.trusted || fresh.livePaths.has(socketPath)) continue;
        if (this.enforce) {
          unlinkSync(socketPath);
          unlinkSync(pidPath);
          logger.info({ socketPath, pidPath }, "Swept dead agent-browser socket pair");
        } else {
          logger.warn({ socketPath, pidPath }, "MONITOR: Would delete dead agent-browser socket pair");
        }
      } catch {
        // Best effort — a daemon may remove its own pair between checks.
      }
    }
  }

  /**
   * D: Tear down the long-lived CDP scraping Chrome when it is idle AND either has
   * zero page targets or its tabs have piled up. The live :9222 listener is spared by every other path (by
   * design, so an in-flight scrape is never killed); this is the one sanctioned
   * reaper. The checks here are a cheap pre-filter — the AUTHORITATIVE idle
   * re-check happens inside teardownIdleSession under the CDP op lock, which also
   * closes the race with a scrape that starts after this pre-filter passes.
   */
  private async maybeTeardownIdleCdp(actions: CleanupAction[]): Promise<void> {
    try {
      // DEBT: dead path kept until step 7 post-soak deletion, upgrade when 7-day durable-profile soak completes
      if (isResidentChromeSupervisionActive()) return;
      // Need trusted process/listener state and an actual Homer-owned live
      // listener (liveProfileDirs is only populated for cmdline-verified CDP
      // Chromes — a non-Homer listener on :9222 never lands here).
      if (!this.cdp.trusted) return;
      if (this.cdp.liveProfileDirs.size === 0) return;

      // lastCdpUseAt === 0 means no scrape has touched CDP since daemon start, so
      // idleness is genuinely UNKNOWN — Date.now() - 0 logged epoch-sized minutes
      // (~29.7M). A session we never used still predates this process, so unknown
      // stays teardown-eligible (the zero-target reap exception is unaffected); it
      // is only labelled honestly.
      const lastUse = getLastCdpUseAt();
      const idleMs = lastUse === 0 ? CDP_IDLE_TEARDOWN_MS : Date.now() - lastUse;
      if (idleMs < CDP_IDLE_TEARDOWN_MS) return;

      const pid = [...this.cdp.listenerPids][0] ?? 0;
      const idleLabel = lastUse === 0 ? "idle unknown since daemon start" : `idle ${Math.round(idleMs / 60000)}min`;
      const decision = decideIdleCdpTeardown(await probeCdp(CDP_PORT));
      if (decision.action === "skip") return;
      if (decision.action === "spare") {
        logger.warn({ pid, idle: idleLabel, reason: decision.reason }, "MONITOR: CDP idle teardown skipped");
        actions.push({ pid, command: "chrome-cdp", action: "spared", reason: decision.reason });
        return;
      }

      const tabs = decision.tabs;
      if (!this.enforce) {
        logger.warn({ pid, tabs, idle: idleLabel }, "MONITOR: Would tear down idle CDP Chrome");
        actions.push({ pid, command: "chrome-cdp", action: "spared", reason: `monitor-only: ${idleLabel}, ${tabs} tabs` });
        return;
      }

      const outcome = await teardownIdleSession(CDP_IDLE_TEARDOWN_MS, CDP_PORT);
      if (outcome === "torn-down") {
        logger.info({ pid, tabs, idle: idleLabel }, tabs === 0 ? "Tore down idle CDP Chrome with no page targets" : "Tore down idle CDP Chrome with tab pile-up");
        actions.push({ pid, command: "chrome-cdp", action: "killed", reason: `${idleLabel}, ${tabs} tabs` });
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
    if (record.pid <= 1 || this.protectedPids.has(record.pid)) {
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
   * The only general process-tree signal path in this module. Re-check identity
   * and topology before every PID or process-group signal, including escalation.
   * User-approved exact-path GUI targets use graceful Apple Events instead.
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
      this.protectedPids.has(expected.pid) ||
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

  private cleanupConfiguredGuiApps(): CleanupAction[] {
    const actions: CleanupAction[] = [];
    const processTable = readProcessCommands();
    const frontmostBundleId = readFrontmostBundleIdentifier();

    if (!processTable) {
      logger.warn("Skipping configured GUI cleanup — process table could not be read");
      return actions;
    }

    for (const target of CONFIGURED_GUI_CLEANUP_TARGETS) {
      const pids = [...processTable.entries()]
        .filter(([, command]) => command === target.executablePath)
        .map(([pid]) => pid);

      for (const pid of pids) {
        if (!frontmostBundleId) {
          actions.push({
            pid,
            command: target.executablePath,
            action: "spared",
            reason: `Configured GUI target spared: could not verify frontmost app (${target.label})`,
          });
          continue;
        }

        if (frontmostBundleId === target.bundleId) {
          actions.push({
            pid,
            command: target.executablePath,
            action: "spared",
            reason: `Configured GUI target spared while frontmost (${target.label})`,
          });
          continue;
        }

        // Re-read the exact command immediately before signaling to close the
        // PID-reuse window between the table snapshot and this action.
        if (readCommandForPid(pid) !== target.executablePath) {
          actions.push({
            pid,
            command: target.executablePath,
            action: "spared",
            reason: `Configured GUI target spared after identity changed (${target.label})`,
          });
          continue;
        }

        const quit = spawnSync("/usr/bin/osascript", ["-e", target.quitScript], {
          encoding: "utf-8",
          timeout: 10_000,
        });
        if (quit.error || quit.status !== 0 || readCommandForPid(pid) === target.executablePath) {
          const detail = quit.stderr?.trim() || quit.error?.message || `exit ${quit.status}`;
          actions.push({
            pid,
            command: target.executablePath,
            action: "spared",
            reason: `Configured GUI target did not quit (${target.label}): ${detail}`,
          });
          continue;
        }

        actions.push({
          pid,
          command: target.executablePath,
          action: "killed",
          reason: target.relaunches
            ? `Configured GUI refresh target quit; relaunch expected (${target.label})`
            : `Configured on-demand GUI target quit (${target.label})`,
        });
      }
    }

    return actions;
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

function readProcessCommands(): Map<number, string> | null {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return null;

  const processes = new Map<number, string>();
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    processes.set(Number(match[1]), match[2]!.trim());
  }
  return processes;
}

function readCommandForPid(pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf-8",
    timeout: 2000,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function readFrontmostBundleIdentifier(): string | null {
  const front = spawnSync("/usr/bin/lsappinfo", ["front"], {
    encoding: "utf-8",
    timeout: 2000,
  });
  const asn = front.stdout?.trim();
  if (front.error || front.status !== 0 || !asn) return null;

  const info = spawnSync("/usr/bin/lsappinfo", ["info", "-only", "bundleid", asn], {
    encoding: "utf-8",
    timeout: 2000,
  });
  if (info.error || info.status !== 0) return null;
  return info.stdout.match(/"CFBundleIdentifier"="([^"]+)"/)?.[1] ?? null;
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

export type IdleCdpDecision =
  | { action: "skip" }
  | { action: "spare"; reason: string }
  | { action: "teardown"; tabs: number };

/**
 * Pure teardown decision for an already-idle, Homer-owned CDP session, given the
 * shared probe. Zero page targets is LESS usable than a tab pile-up (agent-browser
 * connect times out on an empty list), so both take the teardown path. An
 * unreadable list always spares — the probe is intermittently flaky under its 2s
 * budget and reaping on it would kill healthy sessions.
 */
export function decideIdleCdpTeardown(probe: CdpProbe, maxIdleTabs: number = CDP_MAX_IDLE_TABS): IdleCdpDecision {
  if (probe.reason) return { action: "spare", reason: `cdp page probe failed: ${probe.reason}` };
  if (probe.state === "absent") return { action: "spare", reason: "cdp listener stopped answering /json/version" };
  if (probe.pages > 0 && probe.pages <= maxIdleTabs) return { action: "skip" };
  return { action: "teardown", tabs: probe.pages };
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
