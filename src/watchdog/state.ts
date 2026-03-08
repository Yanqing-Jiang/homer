import fs from "fs";
import path from "path";
import { getRuntimePaths } from "../utils/runtime-paths.js";
import type {
  ActionRecord,
  BudgetSnapshot,
  RecordOutcomeParams,
  SignatureState,
  WatchdogAction,
  WatchdogSignature,
  WatchdogState,
} from "./types.js";

const STATE_VERSION = 1;
const MAX_RECENT_ACTIONS = 200;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

function dayStamp(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

function hoursAgo(referenceIso: string, hoursMs: number): number {
  return new Date(referenceIso).getTime() - hoursMs;
}

export function createDefaultState(): WatchdogState {
  return {
    version: STATE_VERSION,
    lastHealthyAt: null,
    consecutiveHealthFailures: 0,
    currentIncident: null,
    signatures: {},
    recentActions: [],
    llmFailures: {
      parseFailures: 0,
      quotaExhaustions: 0,
      lastFailureAt: null,
    },
    legacy: {
      migratedAt: null,
      legacyStateBackupPath: null,
    },
  };
}

export function getDefaultStateFile(): string {
  const runtimePaths = getRuntimePaths();
  return path.join(runtimePaths.libraryApplicationSupportDir, "Homer", "watchdog-state.json");
}

export function getLegacyStateFile(): string {
  const runtimePaths = getRuntimePaths();
  return path.join(runtimePaths.libraryLogsDir, "watchdog.state");
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseLegacyKeyValueState(content: string): Record<string, string> {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes("="))
    .reduce<Record<string, string>>((accumulator, line) => {
      const separatorIndex = line.indexOf("=");
      const key = line.slice(0, separatorIndex);
      const value = line.slice(separatorIndex + 1);
      accumulator[key] = value;
      return accumulator;
    }, {});
}

function migrateLegacyState(rawContent: string, legacySourcePath: string, targetPath: string): WatchdogState {
  const state = createDefaultState();
  const parsed = parseLegacyKeyValueState(rawContent);
  const today = new Date().toISOString();
  const backupPath = `${legacySourcePath}.bak`;

  state.legacy.migratedAt = today;
  state.legacy.legacyStateBackupPath = backupPath;

  const legacyFailures = parsed.consecutive_failures;
  if (legacyFailures && /^\d+$/.test(legacyFailures)) {
    state.consecutiveHealthFailures = Number.parseInt(legacyFailures, 10);
  }

  try {
    ensureParentDir(targetPath);
    fs.renameSync(legacySourcePath, backupPath);
  } catch {
    if (!fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(legacySourcePath, backupPath);
      } catch {
        // best effort
      }
    }
  }

  return state;
}

function normalizeState(raw: Partial<WatchdogState>): WatchdogState {
  return {
    ...createDefaultState(),
    ...raw,
    version: STATE_VERSION,
    signatures: raw.signatures ?? {},
    recentActions: Array.isArray(raw.recentActions) ? raw.recentActions : [],
    llmFailures: {
      ...createDefaultState().llmFailures,
      ...raw.llmFailures,
    },
    legacy: {
      ...createDefaultState().legacy,
      ...raw.legacy,
    },
  };
}

export function loadState(stateFile = getDefaultStateFile()): WatchdogState {
  if (fs.existsSync(stateFile)) {
    const rawContent = fs.readFileSync(stateFile, "utf8");
    try {
      return normalizeState(JSON.parse(rawContent) as Partial<WatchdogState>);
    } catch {
      return normalizeState(migrateLegacyState(rawContent, stateFile, stateFile));
    }
  }

  const legacyStateFile = getLegacyStateFile();
  if (fs.existsSync(legacyStateFile)) {
    const rawContent = fs.readFileSync(legacyStateFile, "utf8");
    return normalizeState(migrateLegacyState(rawContent, legacyStateFile, stateFile));
  }

  return createDefaultState();
}

export function saveState(state: WatchdogState, stateFile = getDefaultStateFile()): void {
  ensureParentDir(stateFile);
  fs.writeFileSync(stateFile, `${JSON.stringify(pruneRecentActions(state), null, 2)}\n`, "utf8");
}

function createSignatureState(occurredAt: string): SignatureState {
  return {
    day: dayStamp(occurredAt),
    firstSeenAt: occurredAt,
    lastSeenAt: occurredAt,
    occurrencesToday: 1,
    restartAttempts: 0,
    forceKillAttempts: 0,
    repairAttempts: 0,
    sourceFixAttempts: 0,
    lastRepairOutcome: null,
    lastHealthyAt: null,
    lastAction: null,
    lastActionAt: null,
    lastOutcome: null,
  };
}

export function touchSignature(
  state: WatchdogState,
  signature: WatchdogSignature,
  occurredAt: string,
): SignatureState {
  const existing = state.signatures[signature];
  const signatureState = existing ? { ...existing } : createSignatureState(occurredAt);
  const currentDay = dayStamp(occurredAt);

  if (signatureState.day !== currentDay) {
    signatureState.day = currentDay;
    signatureState.occurrencesToday = 0;
    signatureState.restartAttempts = 0;
    signatureState.forceKillAttempts = 0;
    signatureState.repairAttempts = 0;
    signatureState.sourceFixAttempts = 0;
  }

  if (signatureState.lastSeenAt !== occurredAt) {
    signatureState.occurrencesToday += 1;
  }
  signatureState.lastSeenAt = occurredAt;
  state.signatures[signature] = signatureState;
  return signatureState;
}

function countRecentActions(
  state: WatchdogState,
  signature: WatchdogSignature,
  action: WatchdogAction,
  cutoffMs: number,
  occurredAt: string,
): number {
  const threshold = hoursAgo(occurredAt, cutoffMs);
  return state.recentActions.filter((entry) =>
    entry.signature === signature &&
    entry.action === action &&
    new Date(entry.at).getTime() >= threshold,
  ).length;
}

function countSourceFixesToday(
  state: WatchdogState,
  signature: WatchdogSignature,
  occurredAt: string,
): { globalCount: number; signatureCount: number } {
  const today = dayStamp(occurredAt);
  let globalCount = 0;
  let signatureCount = 0;

  for (const entry of state.recentActions) {
    if (entry.action !== "source_fix" || dayStamp(entry.at) !== today) {
      continue;
    }
    globalCount += 1;
    if (entry.signature === signature) {
      signatureCount += 1;
    }
  }

  return { globalCount, signatureCount };
}

export function computeBudgetSnapshot(
  state: WatchdogState,
  signature: WatchdogSignature,
  occurredAt: string,
): BudgetSnapshot {
  const sourceFixCounts = countSourceFixesToday(state, signature, occurredAt);
  return {
    restartInWindow: countRecentActions(state, signature, "restart", TWO_HOURS_MS, occurredAt),
    forceKillInWindow: countRecentActions(state, signature, "force_kill", TWO_HOURS_MS, occurredAt),
    repairsInWindow: countRecentActions(state, signature, "repair", TWELVE_HOURS_MS, occurredAt),
    sourceFixesTodayGlobal: sourceFixCounts.globalCount,
    sourceFixesTodaySignature: sourceFixCounts.signatureCount,
  };
}

function addActionRecord(state: WatchdogState, entry: ActionRecord): void {
  state.recentActions.push(entry);
  if (state.recentActions.length > MAX_RECENT_ACTIONS) {
    state.recentActions = state.recentActions.slice(-MAX_RECENT_ACTIONS);
  }
}

function incrementActionCounter(signatureState: SignatureState, action: WatchdogAction): void {
  switch (action) {
    case "restart":
      signatureState.restartAttempts += 1;
      break;
    case "force_kill":
      signatureState.forceKillAttempts += 1;
      break;
    case "repair":
      signatureState.repairAttempts += 1;
      break;
    case "source_fix":
      signatureState.sourceFixAttempts += 1;
      break;
    case "escalate":
      break;
  }
}

export function recordOutcome({
  state,
  decision,
  executed,
  occurredAt,
  outcome,
  validationSignature,
}: RecordOutcomeParams): WatchdogState {
  const signatureState = state.signatures[decision.signature] ?? touchSignature(state, decision.signature, occurredAt);
  signatureState.lastOutcome = outcome;
  signatureState.lastAction = decision.action;
  signatureState.lastActionAt = occurredAt;
  if (decision.action === "repair") {
    signatureState.lastRepairOutcome = outcome;
  }

  if (validationSignature !== null && state.currentIncident) {
    state.currentIncident.lastValidationSignature = validationSignature;
  }
  if (validationSignature !== null) {
    const validationState = touchSignature(state, validationSignature, occurredAt);
    validationState.lastOutcome = outcome;
    validationState.lastSeenAt = occurredAt;
  }

  if (state.currentIncident) {
    state.currentIncident.lastAction = decision.action;
    state.currentIncident.lastActionAt = occurredAt;
    state.currentIncident.lastOutcome = outcome;
  }

  if (!executed) {
    return pruneRecentActions(state, occurredAt);
  }

  addActionRecord(state, {
    at: occurredAt,
    signature: decision.signature,
    action: decision.action,
    repairHandler: decision.repairHandler,
    outcome,
  });
  incrementActionCounter(signatureState, decision.action);

  if (decision.signature === "llm_parse_failure") {
    state.llmFailures.parseFailures += 1;
    state.llmFailures.lastFailureAt = occurredAt;
  }
  if (decision.signature === "llm_quota_exhausted") {
    state.llmFailures.quotaExhaustions += 1;
    state.llmFailures.lastFailureAt = occurredAt;
  }

  if (outcome === "health_recovered") {
    state.lastHealthyAt = occurredAt;
    signatureState.lastHealthyAt = occurredAt;
    state.consecutiveHealthFailures = 0;
    state.currentIncident = null;
  }

  return pruneRecentActions(state, occurredAt);
}

export function pruneRecentActions(state: WatchdogState, referenceTime = new Date().toISOString()): WatchdogState {
  const cutoff = hoursAgo(referenceTime, 14 * 24 * 60 * 60 * 1000);
  state.recentActions = state.recentActions.filter((entry) => new Date(entry.at).getTime() >= cutoff);
  if (state.recentActions.length > MAX_RECENT_ACTIONS) {
    state.recentActions = state.recentActions.slice(-MAX_RECENT_ACTIONS);
  }
  return state;
}
