import { mkdirSync, readFileSync, writeFileSync } from "fs";
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
