import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

export interface BuildInfo {
  sha: string | null;
  dirty: boolean | null;
  builtAt: string | null;
  sourceFingerprint: string | null;
  maxSourceMtimeMs: number | null;
  time: string | null;
}

export interface RuntimeBuildStamp {
  service: string;
  pid: number;
  processStartedAt: string;
  stampedAt: string;
  build: BuildInfo | null;
}

export interface BuildDrift {
  runtimeBuild: BuildInfo;
  diskBuild: BuildInfo;
}

export interface RestartRequestResult {
  path: string;
  status: "written" | "already-pending";
}

export interface BuildDriftSelfExitContext {
  exitCode: number;
  consecutiveChecks: number;
  diskFingerprint: string;
  diskBuildAgeMs: number;
  processUptimeMs: number;
  activeWorkCount: number;
}

let runtimeBuildInfo: BuildInfo | null = null;

function normalizeBuildInfo(raw: unknown): BuildInfo | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const shape = raw as {
    sha?: unknown;
    dirty?: unknown;
    builtAt?: unknown;
    sourceFingerprint?: unknown;
    maxSourceMtimeMs?: unknown;
    time?: unknown;
  };
  const sha = typeof shape.sha === "string" && shape.sha.trim().length > 0
    ? shape.sha.trim()
    : null;
  const dirty = typeof shape.dirty === "boolean" ? shape.dirty : null;
  const builtAt = typeof shape.builtAt === "string" && shape.builtAt.trim().length > 0
    ? shape.builtAt.trim()
    : null;
  const sourceFingerprint = typeof shape.sourceFingerprint === "string" && shape.sourceFingerprint.trim().length > 0
    ? shape.sourceFingerprint.trim()
    : null;
  const maxSourceMtimeMs = typeof shape.maxSourceMtimeMs === "number" && Number.isFinite(shape.maxSourceMtimeMs)
    ? shape.maxSourceMtimeMs
    : null;
  const time = typeof shape.time === "string" && shape.time.trim().length > 0
    ? shape.time.trim()
    : builtAt;

  if (!sha && dirty === null && !builtAt && !sourceFingerprint && maxSourceMtimeMs === null && !time) {
    return null;
  }

  return { sha, dirty, builtAt, sourceFingerprint, maxSourceMtimeMs, time };
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function buildInfoPath(): string {
  return path.join(repoRoot(), "dist", ".build-version");
}

function runtimeStampPath(): string {
  return path.join(repoRoot(), "run", "daemon-build.json");
}

function defaultRestartRequestPath(): string {
  const homeDir = process.env.HOMER_HOME ?? process.env.HOME ?? os.homedir();
  const appSupportName = path.basename(repoRoot()) === "homer-web" ? "HomerWeb" : "Homer";
  const appSupportDir =
    process.env.APP_SUPPORT_DIR ??
    path.join(homeDir, "Library", "Application Support", appSupportName);
  return process.env.RESTART_REQUEST ?? path.join(appSupportDir, "restart.request");
}

function normalizeRuntimeStamp(raw: unknown): RuntimeBuildStamp | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const shape = raw as {
    service?: unknown;
    pid?: unknown;
    processStartedAt?: unknown;
    stampedAt?: unknown;
    build?: unknown;
  };
  const service = typeof shape.service === "string" && shape.service.trim().length > 0
    ? shape.service.trim()
    : null;
  const pid = typeof shape.pid === "number" && Number.isFinite(shape.pid) ? shape.pid : null;
  const processStartedAt = typeof shape.processStartedAt === "string" && shape.processStartedAt.trim().length > 0
    ? shape.processStartedAt.trim()
    : null;
  const stampedAt = typeof shape.stampedAt === "string" && shape.stampedAt.trim().length > 0
    ? shape.stampedAt.trim()
    : null;
  if (!service || pid === null || !processStartedAt || !stampedAt) {
    return null;
  }
  return {
    service,
    pid,
    processStartedAt,
    stampedAt,
    build: normalizeBuildInfo(shape.build),
  };
}

function comparableBuild(info: BuildInfo | null): Record<string, unknown> | null {
  if (!info) {
    return null;
  }
  return {
    sha: info.sha,
    dirty: info.dirty,
    builtAt: info.builtAt,
    sourceFingerprint: info.sourceFingerprint,
    maxSourceMtimeMs: info.maxSourceMtimeMs,
  };
}

function diskBuildFingerprint(info: BuildInfo): string {
  return JSON.stringify(comparableBuild(info));
}

function diskBuildTimestampMs(info: BuildInfo): number | null {
  try {
    const mtimeMs = statSync(buildInfoPath()).mtimeMs;
    if (Number.isFinite(mtimeMs)) return mtimeMs;
  } catch {
    // Fall through to the embedded build timestamp.
  }

  const timestamp = info.builtAt ?? info.time;
  if (!timestamp) return null;

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function diskBuildAgeMs(info: BuildInfo): number | null {
  const timestampMs = diskBuildTimestampMs(info);
  return timestampMs === null ? null : Date.now() - timestampMs;
}

export function buildInfoMatches(a: BuildInfo | null, b: BuildInfo | null): boolean {
  return JSON.stringify(comparableBuild(a)) === JSON.stringify(comparableBuild(b));
}

export function describeBuildInfo(info: BuildInfo | null): string {
  if (!info) {
    return "unknown";
  }
  const sha = info.sha ?? "unknown-sha";
  const state = info.dirty === true ? "dirty" : info.dirty === false ? "clean" : "unknown";
  const builtAt = info.builtAt ?? info.time ?? "unknown-time";
  const fingerprint = info.sourceFingerprint ? ` fp=${info.sourceFingerprint.slice(0, 12)}` : "";
  return `${sha} ${state} builtAt=${builtAt}${fingerprint}`;
}

export function setRuntimeBuildInfo(info: unknown): void {
  runtimeBuildInfo = normalizeBuildInfo(info);
}

export function getRuntimeBuildInfo(): BuildInfo | null {
  return runtimeBuildInfo;
}

export function readDiskBuildInfo(): BuildInfo | null {
  try {
    return normalizeBuildInfo(JSON.parse(readFileSync(buildInfoPath(), "utf-8")));
  } catch {
    return null;
  }
}

export function writeRuntimeBuildStamp(service = "homer-daemon"): RuntimeBuildStamp | null {
  const build = getRuntimeBuildInfo() ?? readDiskBuildInfo();
  const stamp: RuntimeBuildStamp = {
    service,
    pid: process.pid,
    processStartedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    stampedAt: new Date().toISOString(),
    build,
  };
  try {
    const outPath = runtimeStampPath();
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(stamp, null, 2)}\n`);
    return stamp;
  } catch {
    return null;
  }
}

export function readRuntimeBuildStamp(): RuntimeBuildStamp | null {
  try {
    return normalizeRuntimeStamp(JSON.parse(readFileSync(runtimeStampPath(), "utf-8")));
  } catch {
    return null;
  }
}

export function getBuildDrift(): BuildDrift | null {
  const runtimeBuild = getRuntimeBuildInfo();
  const diskBuild = readDiskBuildInfo();
  if (!runtimeBuild || !diskBuild || buildInfoMatches(runtimeBuild, diskBuild)) {
    return null;
  }
  return { runtimeBuild, diskBuild };
}

export function requestBuildDriftRestart(service = "homer-daemon", reason = "build-drift"): RestartRequestResult | null {
  const drift = getBuildDrift();
  if (!drift) return null;

  const requestPath = defaultRestartRequestPath();
  const buildFingerprint =
    drift.diskBuild.sourceFingerprint ??
    drift.diskBuild.builtAt ??
    drift.diskBuild.time ??
    "unknown";

  try {
    if (existsSync(requestPath)) {
      const existing = readFileSync(requestPath, "utf-8");
      if (
        existing.includes(`service=${service}\n`) &&
        existing.includes(`reason=${reason}\n`) &&
        existing.includes(`build_fingerprint=${buildFingerprint}\n`)
      ) {
        return { path: requestPath, status: "already-pending" };
      }
    }
  } catch {
    // Rewrite below if the pending request cannot be read.
  }

  const lines = [
    `requested_at=${new Date().toISOString()}`,
    `reason=${reason}`,
    `service=${service}`,
    `pid=${process.pid}`,
    `runtime_build=${describeBuildInfo(drift.runtimeBuild)}`,
    `disk_build=${describeBuildInfo(drift.diskBuild)}`,
    `build_fingerprint=${buildFingerprint}`,
    "",
  ];

  try {
    mkdirSync(path.dirname(requestPath), { recursive: true });
    const tmpPath = `${requestPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, lines.join("\n"));
    renameSync(tmpPath, requestPath);
    return { path: requestPath, status: "written" };
  } catch {
    return null;
  }
}

export function startBuildDriftRestartGuard(options: {
  service?: string;
  reason?: string;
  intervalMs?: number;
  onDrift?: (drift: BuildDrift, request: RestartRequestResult | null) => void;
  selfExit?: {
    exitCode: number;
    getActiveWorkCount: () => number | Promise<number>;
    onExit: (
      drift: BuildDrift,
      request: RestartRequestResult | null,
      context: BuildDriftSelfExitContext
    ) => void | Promise<void>;
    minConsecutiveChecks?: number;
    minDiskBuildAgeMs?: number;
    minProcessUptimeMs?: number;
  };
} = {}): () => void {
  const service = options.service ?? "homer-daemon";
  const reason = options.reason ?? "build-drift";
  const intervalMs = options.intervalMs ?? 60_000;
  const minConsecutiveChecks = options.selfExit?.minConsecutiveChecks ?? 3;
  const minDiskBuildAgeMs = options.selfExit?.minDiskBuildAgeMs ?? 60_000;
  const minProcessUptimeMs = options.selfExit?.minProcessUptimeMs ?? 10 * 60_000;
  let lastNotifiedKey: string | null = null;
  let stableDiskFingerprint: string | null = null;
  let consecutiveDriftChecks = 0;
  let checkInProgress = false;
  let selfExitStarted = false;

  const check = async (): Promise<void> => {
    if (checkInProgress || selfExitStarted) return;
    checkInProgress = true;
    try {
      const drift = getBuildDrift();
      if (!drift) {
        stableDiskFingerprint = null;
        consecutiveDriftChecks = 0;
        return;
      }
      const request = requestBuildDriftRestart(service, reason);
      const key = JSON.stringify({
        runtime: describeBuildInfo(drift.runtimeBuild),
        disk: describeBuildInfo(drift.diskBuild),
        request: request?.status ?? "failed",
      });
      if (key !== lastNotifiedKey) {
        lastNotifiedKey = key;
        options.onDrift?.(drift, request);
      }

      const diskFingerprint = diskBuildFingerprint(drift.diskBuild);
      if (diskFingerprint === stableDiskFingerprint) {
        consecutiveDriftChecks++;
      } else {
        stableDiskFingerprint = diskFingerprint;
        consecutiveDriftChecks = 1;
      }

      const selfExit = options.selfExit;
      if (!selfExit || consecutiveDriftChecks < minConsecutiveChecks) return;

      const buildAgeMs = diskBuildAgeMs(drift.diskBuild);
      if (buildAgeMs === null || buildAgeMs < minDiskBuildAgeMs) return;

      const processUptimeMs = process.uptime() * 1000;
      if (processUptimeMs <= minProcessUptimeMs) return;

      let activeWorkCount: number;
      try {
        activeWorkCount = await selfExit.getActiveWorkCount();
      } catch {
        return;
      }
      if (!Number.isFinite(activeWorkCount) || activeWorkCount !== 0) return;

      selfExitStarted = true;
      await selfExit.onExit(drift, request, {
        exitCode: selfExit.exitCode,
        consecutiveChecks: consecutiveDriftChecks,
        diskFingerprint,
        diskBuildAgeMs: buildAgeMs,
        processUptimeMs,
        activeWorkCount,
      });
    } finally {
      checkInProgress = false;
    }
  };

  // Swallow check() rejections: an uncaught throw inside setInterval would
  // crash the daemon and turn the guard into a 60s crash loop under KeepAlive.
  const safeCheck = (): void => void check().catch(() => {});
  const timer = setInterval(safeCheck, intervalMs);
  timer.unref?.();
  safeCheck();
  return () => clearInterval(timer);
}
