import fs from "fs";
import { classifyContext, classifyDockerContext } from "./signature.js";
import { normalizeLlmDecision } from "./llm.js";
import { getDeterministicPlan, isUnknownSignature } from "./repair-plan.js";
import {
  computeBudgetSnapshot,
  loadState,
  recordOutcome,
  saveState,
  touchSignature,
  getDefaultStateFile,
} from "./state.js";
import type {
  DockerWatchdogContext,
  OutcomeStatus,
  RepairHandler,
  WatchdogAction,
  WatchdogContext,
  WatchdogDecision,
  WatchdogSignature,
  WatchdogState,
} from "./types.js";
import { isWatchdogSignature } from "./types.js";

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function parseArgs(argv: string[]): Map<string, string | boolean> {
  const args = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(token, true);
      continue;
    }
    args.set(token, next);
    index += 1;
  }
  return args;
}

function nextIncidentId(timestamp: string): string {
  return `wd-${timestamp.replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

interface IncidentDiagnostics {
  launchdPid: number | null;
  portOwnerPid: number | null;
  lockHolders: number[];
}

function contextDiagnostics(context: WatchdogContext): IncidentDiagnostics {
  return {
    launchdPid: context.launchdPid,
    portOwnerPid: context.portOwnerPid,
    lockHolders: context.lockHolders.map((holder) => holder.pid),
  };
}

const DOCKER_DIAGNOSTICS: IncidentDiagnostics = {
  launchdPid: null,
  portOwnerPid: null,
  lockHolders: [],
};

function setIncidentState(
  state: WatchdogState,
  diagnostics: IncidentDiagnostics,
  signature: WatchdogSignature,
  summary: string,
  timestamp: string,
): string {
  const incidentId =
    state.currentIncident?.signature === signature ? state.currentIncident.id : nextIncidentId(timestamp);

  state.currentIncident = {
    id: incidentId,
    startedAt: state.currentIncident?.signature === signature
      ? state.currentIncident.startedAt
      : timestamp,
    signature,
    summary,
    launchdPid: diagnostics.launchdPid,
    portOwnerPid: diagnostics.portOwnerPid,
    lockHolders: diagnostics.lockHolders,
    lastAction: state.currentIncident?.signature === signature ? state.currentIncident.lastAction : null,
    lastActionAt: state.currentIncident?.signature === signature ? state.currentIncident.lastActionAt : null,
    lastOutcome: state.currentIncident?.signature === signature ? state.currentIncident.lastOutcome : null,
    lastValidationSignature: state.currentIncident?.signature === signature
      ? state.currentIncident.lastValidationSignature
      : null,
  };

  return incidentId;
}

function buildDecision(
  state: WatchdogState,
  context: WatchdogContext,
  signature: WatchdogSignature,
  action: WatchdogAction,
  repairHandler: RepairHandler | null,
  reason: string,
  decisionSource: "local_policy" | "claude",
): WatchdogDecision {
  const incidentId = setIncidentState(state, contextDiagnostics(context), signature, reason, context.timestamp);
  return {
    incidentId,
    signature,
    action,
    repairHandler,
    reason,
    decisionSource,
    needsLlm: false,
    budgetSnapshot: computeBudgetSnapshot(state, signature, context.timestamp),
  };
}

function buildNeedsLlmDecision(
  state: WatchdogState,
  context: WatchdogContext,
  signature: WatchdogSignature,
  reason: string,
): WatchdogDecision {
  const incidentId = setIncidentState(state, contextDiagnostics(context), signature, reason, context.timestamp);
  return {
    incidentId,
    signature,
    action: "escalate",
    repairHandler: null,
    reason,
    decisionSource: "local_policy",
    needsLlm: true,
    budgetSnapshot: computeBudgetSnapshot(state, signature, context.timestamp),
  };
}

function chooseLocalDecision(state: WatchdogState, context: WatchdogContext): WatchdogDecision {
  const classification = classifyContext(context);
  state.consecutiveHealthFailures = context.failureCount;
  const signatureState = touchSignature(state, classification.signature, context.timestamp);
  const budgetSnapshot = computeBudgetSnapshot(state, classification.signature, context.timestamp);

  if (classification.signature === "build_failure") {
    return buildDecision(
      state,
      context,
      classification.signature,
      "escalate",
      null,
      "Build failed after a source fix, so the watchdog is escalating immediately.",
      "local_policy",
    );
  }

  const deterministicPlan = getDeterministicPlan(classification.signature);
  if (deterministicPlan) {
    if (
      deterministicPlan.action === "repair" &&
      (
        signatureState.lastRepairOutcome === "validation_failed" ||
        signatureState.lastOutcome === "same_signature_recurred"
      )
    ) {
      return buildDecision(
        state,
        context,
        classification.signature,
        "escalate",
        null,
        "The same signature recurred after a deterministic repair, so the watchdog is escalating.",
        "local_policy",
      );
    }

    if (
      classification.signature === "daemon_missing" &&
      budgetSnapshot.restartInWindow >= 2
    ) {
      return buildDecision(
        state,
        context,
        classification.signature,
        "escalate",
        null,
        "Restart budget for daemon_missing is exhausted for the last 2 hours.",
        "local_policy",
      );
    }

    if (
      classification.signature === "health_timeout_with_live_pid" &&
      budgetSnapshot.restartInWindow >= 1
    ) {
      return buildDecision(
        state,
        context,
        classification.signature,
        "escalate",
        null,
        "A restart already failed to clear the health timeout with a live PID.",
        "local_policy",
      );
    }

    if (
      (classification.signature === "port_conflict" || classification.signature === "stale_lock_holder") &&
      budgetSnapshot.forceKillInWindow >= 1
    ) {
      return buildDecision(
        state,
        context,
        classification.signature,
        "escalate",
        null,
        "Force-kill budget for this signature is exhausted for the last 2 hours.",
        "local_policy",
      );
    }

    if (deterministicPlan.action === "repair" && budgetSnapshot.repairsInWindow >= 1) {
      return buildDecision(
        state,
        context,
        classification.signature,
        "escalate",
        null,
        "Deterministic repair budget for this signature is exhausted for the last 12 hours.",
        "local_policy",
      );
    }

    return {
      ...buildDecision(
        state,
        context,
        classification.signature,
        deterministicPlan.action,
        deterministicPlan.repairHandler,
        classification.summary,
        "local_policy",
      ),
      budgetSnapshot,
    };
  }

  if (isUnknownSignature(classification.signature)) {
    return {
      ...buildNeedsLlmDecision(
        state,
        context,
        classification.signature,
        `${classification.summary} Claude triage is required for unknown failures.`,
      ),
      budgetSnapshot,
    };
  }

  return buildDecision(
    state,
    context,
    classification.signature,
    "escalate",
    null,
    classification.summary,
    "local_policy",
  );
}

function chooseClaudeDecision(
  state: WatchdogState,
  context: WatchdogContext,
  llmOutput: string,
): WatchdogDecision {
  const classification = classifyContext(context);
  touchSignature(state, classification.signature, context.timestamp);
  state.consecutiveHealthFailures = context.failureCount;

  const normalized = normalizeLlmDecision(llmOutput, classification.signature);
  if (normalized.failureSignature !== null || normalized.decision === null) {
    return buildDecision(
      state,
      context,
      normalized.failureSignature ?? "llm_parse_failure",
      "escalate",
      null,
      "Claude output was unusable, so the watchdog is escalating.",
      "local_policy",
    );
  }

  const signature = normalized.decision.signature;
  const budgetSnapshot = computeBudgetSnapshot(state, signature, context.timestamp);

  if (normalized.decision.action === "source_fix" && !classification.clearSourceEvidence) {
    return {
      ...buildDecision(
        state,
        context,
        signature,
        "escalate",
        null,
        "Source fixes are only allowed when logs clearly point to Homer source code.",
        "local_policy",
      ),
      budgetSnapshot,
    };
  }

  if (normalized.decision.action === "source_fix" && budgetSnapshot.sourceFixesTodayGlobal >= 2) {
    return {
      ...buildDecision(
        state,
        context,
        signature,
        "escalate",
        null,
        "Global source-fix budget is exhausted for today.",
        "local_policy",
      ),
      budgetSnapshot,
    };
  }

  if (normalized.decision.action === "source_fix" && budgetSnapshot.sourceFixesTodaySignature >= 1) {
    return {
      ...buildDecision(
        state,
        context,
        signature,
        "escalate",
        null,
        "Per-signature source-fix budget is exhausted for today.",
        "local_policy",
      ),
      budgetSnapshot,
    };
  }

  if (normalized.decision.action === "repair" && normalized.decision.repairHandler === null) {
    return {
      ...buildDecision(
        state,
        context,
        "llm_parse_failure",
        "escalate",
        null,
        "Claude requested a repair without a valid repair handler.",
        "local_policy",
      ),
      budgetSnapshot,
    };
  }

  if (normalized.decision.action === "repair" && budgetSnapshot.repairsInWindow >= 1) {
    return {
      ...buildDecision(
        state,
        context,
        signature,
        "escalate",
        null,
        "Repair budget is exhausted for this signature in the last 12 hours.",
        "local_policy",
      ),
      budgetSnapshot,
    };
  }

  if (normalized.decision.action === "restart" && budgetSnapshot.restartInWindow >= 2) {
    return {
      ...buildDecision(
        state,
        context,
        signature,
        "escalate",
        null,
        "Restart budget is exhausted for this signature in the last 2 hours.",
        "local_policy",
      ),
      budgetSnapshot,
    };
  }

  if (normalized.decision.action === "force_kill" && budgetSnapshot.forceKillInWindow >= 1) {
    return {
      ...buildDecision(
        state,
        context,
        signature,
        "escalate",
        null,
        "Force-kill budget is exhausted for this signature in the last 2 hours.",
        "local_policy",
      ),
      budgetSnapshot,
    };
  }

  return {
    ...buildDecision(
      state,
      context,
      signature,
      normalized.decision.action,
      normalized.decision.repairHandler,
      normalized.decision.reason,
      "claude",
    ),
    budgetSnapshot,
  };
}

export function decideWatchdogAction(
  state: WatchdogState,
  context: WatchdogContext,
  llmOutput?: string,
): WatchdogDecision {
  if (llmOutput && llmOutput.trim().length > 0) {
    return chooseClaudeDecision(state, context, llmOutput);
  }
  return chooseLocalDecision(state, context);
}

function getLastRepairHandler(state: WatchdogState, signature: WatchdogSignature): RepairHandler | null {
  for (let i = state.recentActions.length - 1; i >= 0; i--) {
    const entry = state.recentActions[i];
    if (entry && entry.signature === signature && entry.action === "repair") {
      return entry.repairHandler;
    }
  }
  return null;
}

const DOCKER_TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function countDockerRepairs(state: WatchdogState, signature: WatchdogSignature, timestamp: string): number {
  const cutoff = new Date(timestamp).getTime() - DOCKER_TWO_HOURS_MS;
  return state.recentActions.filter((entry) =>
    entry.signature === signature &&
    entry.action === "repair" &&
    new Date(entry.at).getTime() >= cutoff,
  ).length;
}

function buildDockerDecision(
  state: WatchdogState,
  timestamp: string,
  signature: WatchdogSignature,
  action: WatchdogAction,
  repairHandler: RepairHandler | null,
  reason: string,
): WatchdogDecision {
  const incidentId = setIncidentState(state, DOCKER_DIAGNOSTICS, signature, reason, timestamp);
  return {
    incidentId,
    signature,
    action,
    repairHandler,
    reason,
    decisionSource: "local_policy",
    needsLlm: false,
    budgetSnapshot: computeBudgetSnapshot(state, signature, timestamp),
  };
}

function chooseDockerDecision(
  state: WatchdogState,
  context: DockerWatchdogContext,
): WatchdogDecision | null {
  const classification = classifyDockerContext(context);
  if (!classification) return null;

  const signatureState = touchSignature(state, classification.signature, context.timestamp);
  const repairsInWindow = countDockerRepairs(state, classification.signature, context.timestamp);

  if (classification.signature === "docker_daemon_down" && repairsInWindow >= 1) {
    return buildDockerDecision(
      state, context.timestamp, classification.signature, "escalate", null,
      "Docker daemon repair budget exhausted (1 per 2h).",
    );
  }

  if (
    (classification.signature === "docker_container_stopped" ||
      classification.signature === "docker_container_unhealthy") &&
    repairsInWindow >= 2
  ) {
    return buildDockerDecision(
      state, context.timestamp, classification.signature, "escalate", null,
      "Docker container repair budget exhausted (2 per 2h).",
    );
  }

  if (
    classification.signature === "docker_container_stopped" ||
    classification.signature === "docker_container_unhealthy"
  ) {
    if (
      signatureState.lastOutcome === "same_signature_recurred" ||
      signatureState.lastOutcome === "validation_failed"
    ) {
      const lastHandler = getLastRepairHandler(state, classification.signature);
      if (lastHandler === "repair_docker_restart") {
        return buildDockerDecision(
          state, context.timestamp, classification.signature, "repair", "repair_docker_recreate",
          "Docker restart failed, escalating to recreate.",
        );
      }
      if (lastHandler === "repair_docker_recreate") {
        return buildDockerDecision(
          state, context.timestamp, classification.signature, "escalate", null,
          "Docker recreate also failed, escalating to user.",
        );
      }
    }
  }

  const deterministicPlan = getDeterministicPlan(classification.signature);
  if (!deterministicPlan) {
    return buildDockerDecision(
      state, context.timestamp, classification.signature, "escalate", null,
      classification.summary,
    );
  }

  return buildDockerDecision(
    state, context.timestamp, classification.signature,
    deterministicPlan.action, deterministicPlan.repairHandler,
    classification.summary,
  );
}

export function decideDockerAction(
  state: WatchdogState,
  context: DockerWatchdogContext,
): WatchdogDecision | null {
  return chooseDockerDecision(state, context);
}

function resolveValidationSignature(args: Map<string, string | boolean>): WatchdogSignature | null {
  const explicit = args.get("--result-signature");
  if (typeof explicit === "string" && isWatchdogSignature(explicit)) {
    return explicit;
  }

  const validationContextFile = args.get("--validation-context-file");
  if (typeof validationContextFile === "string") {
    const validationContext = readJsonFile<WatchdogContext>(validationContextFile);
    return classifyContext(validationContext).signature;
  }

  return null;
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (command !== "decide" && command !== "record-outcome" && command !== "classify" && command !== "docker-decide") {
    console.error("Usage: policy.js decide|record-outcome|classify|docker-decide [--flags]");
    process.exit(1);
  }

  const args = parseArgs(rest);
  if (command === "classify") {
    const contextFile = args.get("--context-file");
    if (typeof contextFile !== "string") {
      throw new Error("--context-file is required");
    }
    const context = readJsonFile<WatchdogContext>(contextFile);
    process.stdout.write(`${JSON.stringify(classifyContext(context))}\n`);
    return;
  }

  const stateFile = typeof args.get("--state-file") === "string"
    ? args.get("--state-file") as string
    : getDefaultStateFile();
  const state = loadState(stateFile);

  if (command === "decide") {
    const contextFile = args.get("--context-file");
    if (typeof contextFile !== "string") {
      throw new Error("--context-file is required");
    }
    const context = readJsonFile<WatchdogContext>(contextFile);
    const llmOutputFile = args.get("--llm-output-file");
    const llmOutput = typeof llmOutputFile === "string" ? fs.readFileSync(llmOutputFile, "utf8") : undefined;
    const decision = decideWatchdogAction(state, context, llmOutput);
    saveState(state, stateFile);
    process.stdout.write(`${JSON.stringify(decision)}\n`);
    return;
  }

  if (command === "docker-decide") {
    const dockerContextFile = args.get("--docker-context-file");
    if (typeof dockerContextFile !== "string") {
      throw new Error("--docker-context-file is required");
    }
    const dockerContext = readJsonFile<DockerWatchdogContext>(dockerContextFile);
    const decision = decideDockerAction(state, dockerContext);
    saveState(state, stateFile);
    process.stdout.write(`${JSON.stringify(decision)}\n`);
    return;
  }

  const decisionFile = args.get("--decision-file");
  const outcome = args.get("--outcome");
  const executed = args.get("--executed");
  const occurredAtArg = args.get("--occurred-at");
  if (typeof decisionFile !== "string") {
    throw new Error("--decision-file is required");
  }
  if (typeof outcome !== "string") {
    throw new Error("--outcome is required");
  }
  if (executed !== "true" && executed !== "false") {
    throw new Error("--executed must be true or false");
  }

  const decision = readJsonFile<WatchdogDecision>(decisionFile);
  const validationSignature = resolveValidationSignature(args);
  const updatedState = recordOutcome({
    state,
    decision,
    executed: executed === "true",
    occurredAt: typeof occurredAtArg === "string" ? occurredAtArg : new Date().toISOString(),
    outcome: outcome as OutcomeStatus,
    validationSignature,
  });
  saveState(updatedState, stateFile);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    currentIncident: updatedState.currentIncident?.id ?? null,
    validationSignature,
  })}\n`);
}

const isMainModule = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/policy.js");
if (isMainModule) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
