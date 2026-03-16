import type { ClassificationResult, DockerWatchdogContext, WatchdogContext, WatchdogSignature } from "./types.js";

function normalizeText(...parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join("\n");
}

function hasAll(text: string, patterns: RegExp[]): boolean {
  return patterns.every((pattern) => pattern.test(text));
}

function extractNodePaths(launchdPrint: string): string[] {
  const matches = launchdPrint.match(/\/[^\s"'<>]+\/node\b/g) ?? [];
  return [...new Set(matches)];
}

function hasSourceEvidence(text: string): boolean {
  return (
    /(?:uncaughtException|unhandledRejection|TypeError|ReferenceError|SyntaxError|Error:)/i.test(text) &&
    /(?:\/Users\/[^/\s]+\/homer\/src\/|\/Users\/[^/\s]+\/homer\/dist\/.+:\d+:\d+)/i.test(text)
  );
}

export function classifyContext(context: WatchdogContext): ClassificationResult {
  const combinedLogs = normalizeText(
    context.recentStdout,
    context.recentStderr,
    context.recentFatalLog,
    context.launchdPrint,
    context.processSnapshot,
  );
  const sourceEvidenceText = normalizeText(
    context.recentStdout,
    context.recentStderr,
    context.recentFatalLog,
  );

  if (
    hasAll(combinedLogs, [
      /ERR_DLOPEN_FAILED/i,
      /NODE_MODULE_VERSION|compiled against a different Node\.js version/i,
    ])
  ) {
    return {
      signature: "native_module_abi_mismatch",
      summary: "Native module ABI mismatch detected in daemon logs.",
      clearSourceEvidence: false,
    };
  }

  const nodePaths = extractNodePaths(context.launchdPrint);
  if (
    nodePaths.length > 0 &&
    !nodePaths.includes(context.expectedNodePath) &&
    nodePaths.some((candidate) => candidate !== context.expectedNodePath)
  ) {
    return {
      signature: "launchd_runtime_mismatch",
      summary: `launchd is using ${nodePaths[0]} instead of ${context.expectedNodePath}.`,
      clearSourceEvidence: false,
    };
  }

  if (
    context.lockHolders.length > 0 &&
    (context.launchdPid === null || !context.lockHolders.some((holder) => holder.pid === context.launchdPid))
  ) {
    return {
      signature: "stale_lock_holder",
      summary: "Lock file is held by a process that is not the active launchd daemon.",
      clearSourceEvidence: false,
    };
  }

  if (
    context.portOwnerPid !== null &&
    (context.launchdPid === null || context.portOwnerPid !== context.launchdPid)
  ) {
    return {
      signature: "port_conflict",
      summary: `Port ${context.port} is owned by PID ${context.portOwnerPid}, not the launchd daemon.`,
      clearSourceEvidence: false,
    };
  }

  if (context.launchdPid === null && context.portOwnerPid === null) {
    return {
      signature: "daemon_missing",
      summary: "launchd reports no daemon PID and the health port is free.",
      clearSourceEvidence: false,
    };
  }

  if (
    context.healthTimedOut &&
    context.launchdPid !== null &&
    context.portOwnerPid !== null &&
    context.portOwnerPid === context.launchdPid
  ) {
    return {
      signature: "health_timeout_with_live_pid",
      summary: "Daemon PID is still holding the port, but the health endpoint timed out.",
      clearSourceEvidence: false,
    };
  }

  const clearSourceEvidence = hasSourceEvidence(sourceEvidenceText);
  if (context.launchdPid === null) {
    return {
      signature: "unknown_startup_crash",
      summary: "Daemon exited without matching a deterministic watchdog signature.",
      clearSourceEvidence,
    };
  }

  return {
    signature: "unknown_runtime_failure",
    summary: "Runtime failure could not be matched to a deterministic watchdog signature.",
    clearSourceEvidence,
  };
}

export function classifyDockerContext(context: DockerWatchdogContext): ClassificationResult | null {
  if (!context.dockerDaemonRunning) {
    return {
      signature: "docker_daemon_down",
      summary: "Docker Desktop / dockerd is not running.",
      clearSourceEvidence: false,
    };
  }

  for (const service of context.services) {
    if (service.containerState === "stopped" || service.containerState === "not_found") {
      return {
        signature: "docker_container_stopped",
        summary: `Docker container '${service.name}' is ${service.containerState}.`,
        clearSourceEvidence: false,
      };
    }
  }

  for (const service of context.services) {
    if (service.healthStatus === "unhealthy" || (service.httpStatus !== null && service.httpStatus !== 200)) {
      return {
        signature: "docker_container_unhealthy",
        summary: `Docker container '${service.name}' is unhealthy (health=${service.healthStatus}, http=${service.httpStatus}).`,
        clearSourceEvidence: false,
      };
    }
  }

  return null;
}

export function summarizeSignature(signature: WatchdogSignature): string {
  switch (signature) {
    case "native_module_abi_mismatch":
      return "Native module ABI mismatch";
    case "launchd_runtime_mismatch":
      return "launchd runtime mismatch";
    case "stale_lock_holder":
      return "Stale lock holder";
    case "port_conflict":
      return "Port conflict";
    case "daemon_missing":
      return "Daemon missing";
    case "health_timeout_with_live_pid":
      return "Health timeout with live daemon PID";
    case "build_failure":
      return "Build failed after source fix";
    case "llm_parse_failure":
      return "Claude output was malformed";
    case "llm_quota_exhausted":
      return "Claude quota exhausted";
    case "unknown_startup_crash":
      return "Unknown startup crash";
    case "unknown_runtime_failure":
      return "Unknown runtime failure";
    case "docker_daemon_down":
      return "Docker daemon not running";
    case "docker_container_stopped":
      return "Docker container stopped";
    case "docker_container_unhealthy":
      return "Docker container unhealthy";
  }
}
