import { readFileSync } from "fs";
import path from "path";
import { getRuntimePaths } from "./runtime-paths.js";

export interface BuildInfo {
  sha: string | null;
  time: string | null;
}

let runtimeBuildInfo: BuildInfo | null = null;

function normalizeBuildInfo(raw: unknown): BuildInfo | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const shape = raw as { sha?: unknown; time?: unknown };
  const sha = typeof shape.sha === "string" && shape.sha.trim().length > 0
    ? shape.sha.trim()
    : null;
  const time = typeof shape.time === "string" && shape.time.trim().length > 0
    ? shape.time.trim()
    : null;

  if (!sha && !time) {
    return null;
  }

  return { sha, time };
}

export function setRuntimeBuildInfo(info: unknown): void {
  runtimeBuildInfo = normalizeBuildInfo(info);
}

export function getRuntimeBuildInfo(): BuildInfo | null {
  return runtimeBuildInfo;
}

export function readDiskBuildInfo(): BuildInfo | null {
  try {
    const runtimePaths = getRuntimePaths();
    const versionPath = path.join(runtimePaths.homerRoot, "dist", ".build-version");
    return normalizeBuildInfo(JSON.parse(readFileSync(versionPath, "utf-8")));
  } catch {
    return null;
  }
}
