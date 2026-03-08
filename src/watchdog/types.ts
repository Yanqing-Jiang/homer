export const WATCHDOG_SIGNATURES = [
  "native_module_abi_mismatch",
  "launchd_runtime_mismatch",
  "stale_lock_holder",
  "port_conflict",
  "daemon_missing",
  "health_timeout_with_live_pid",
  "build_failure",
  "llm_parse_failure",
  "llm_quota_exhausted",
  "unknown_startup_crash",
  "unknown_runtime_failure",
] as const;

export type WatchdogSignature =
  | "native_module_abi_mismatch"
  | "launchd_runtime_mismatch"
  | "stale_lock_holder"
  | "port_conflict"
  | "daemon_missing"
  | "health_timeout_with_live_pid"
  | "build_failure"
  | "llm_parse_failure"
  | "llm_quota_exhausted"
  | "unknown_startup_crash"
  | "unknown_runtime_failure";

export const WATCHDOG_ACTIONS = [
  "restart",
  "force_kill",
  "repair",
  "source_fix",
  "escalate",
] as const;

export type WatchdogAction =
  | "restart"
  | "force_kill"
  | "repair"
  | "source_fix"
  | "escalate";

export const REPAIR_HANDLERS = [
  "repair_native_modules",
  "repair_launchd_runtime",
  "repair_stale_lock",
] as const;

export type RepairHandler =
  | "repair_native_modules"
  | "repair_launchd_runtime"
  | "repair_stale_lock";

export type DecisionSource = "local_policy" | "claude";

export type OutcomeStatus =
  | "health_recovered"
  | "same_signature_recurred"
  | "new_signature_recurred"
  | "validation_failed"
  | "action_skipped_by_policy";

export interface LockHolder {
  pid: number;
  command: string;
}

export interface WatchdogContext {
  timestamp: string;
  failureCount: number;
  healthUrl: string;
  port: number;
  expectedNodePath: string;
  launchdDomain: string;
  homerLabel: string;
  launchdPid: number | null;
  portOwnerPid: number | null;
  portOwnerCommand: string | null;
  lockFile: string;
  lockHolders: LockHolder[];
  launchdPrint: string;
  recentStdout: string;
  recentStderr: string;
  recentFatalLog: string;
  processSnapshot: string;
  healthTimedOut: boolean;
}

export interface ClassificationResult {
  signature: WatchdogSignature;
  summary: string;
  clearSourceEvidence: boolean;
}

export interface SignatureState {
  day: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrencesToday: number;
  restartAttempts: number;
  forceKillAttempts: number;
  repairAttempts: number;
  sourceFixAttempts: number;
  lastRepairOutcome: OutcomeStatus | null;
  lastHealthyAt: string | null;
  lastAction: WatchdogAction | null;
  lastActionAt: string | null;
  lastOutcome: OutcomeStatus | null;
}

export interface IncidentState {
  id: string;
  startedAt: string;
  signature: WatchdogSignature;
  summary: string;
  launchdPid: number | null;
  portOwnerPid: number | null;
  lockHolders: number[];
  lastAction: WatchdogAction | null;
  lastActionAt: string | null;
  lastOutcome: OutcomeStatus | null;
  lastValidationSignature: WatchdogSignature | null;
}

export interface ActionRecord {
  at: string;
  signature: WatchdogSignature;
  action: WatchdogAction;
  repairHandler: RepairHandler | null;
  outcome: OutcomeStatus;
}

export interface LlmFailureState {
  parseFailures: number;
  quotaExhaustions: number;
  lastFailureAt: string | null;
}

export interface WatchdogState {
  version: 1;
  lastHealthyAt: string | null;
  consecutiveHealthFailures: number;
  currentIncident: IncidentState | null;
  signatures: Partial<Record<WatchdogSignature, SignatureState>>;
  recentActions: ActionRecord[];
  llmFailures: LlmFailureState;
  legacy: {
    migratedAt: string | null;
    legacyStateBackupPath: string | null;
  };
}

export interface BudgetSnapshot {
  restartInWindow: number;
  forceKillInWindow: number;
  repairsInWindow: number;
  sourceFixesTodayGlobal: number;
  sourceFixesTodaySignature: number;
}

export interface WatchdogDecision {
  incidentId: string;
  signature: WatchdogSignature;
  action: WatchdogAction;
  repairHandler: RepairHandler | null;
  reason: string;
  decisionSource: DecisionSource;
  needsLlm: boolean;
  budgetSnapshot: BudgetSnapshot;
}

export interface ParsedLlmDecision {
  action: WatchdogAction;
  signature: WatchdogSignature;
  repairHandler: RepairHandler | null;
  reason: string;
}

export interface RecordOutcomeParams {
  state: WatchdogState;
  decision: WatchdogDecision;
  executed: boolean;
  occurredAt: string;
  outcome: OutcomeStatus;
  validationSignature: WatchdogSignature | null;
}

export function isWatchdogSignature(value: string): value is WatchdogSignature {
  return WATCHDOG_SIGNATURES.includes(value as WatchdogSignature);
}

export function isWatchdogAction(value: string): value is WatchdogAction {
  return WATCHDOG_ACTIONS.includes(value as WatchdogAction);
}

export function isRepairHandler(value: string): value is RepairHandler {
  return REPAIR_HANDLERS.includes(value as RepairHandler);
}
