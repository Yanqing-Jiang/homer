import type { RepairHandler, WatchdogAction, WatchdogSignature } from "./types.js";

export interface DeterministicPlan {
  action: WatchdogAction;
  repairHandler: RepairHandler | null;
}

const REPAIR_HANDLERS_BY_SIGNATURE: Partial<Record<WatchdogSignature, RepairHandler>> = {
  native_module_abi_mismatch: "repair_native_modules",
  launchd_runtime_mismatch: "repair_launchd_runtime",
  stale_lock_holder: "repair_stale_lock",
};

const DETERMINISTIC_PLANS: Partial<Record<WatchdogSignature, DeterministicPlan>> = {
  daemon_missing: { action: "restart", repairHandler: null },
  stale_lock_holder: { action: "force_kill", repairHandler: null },
  port_conflict: { action: "force_kill", repairHandler: null },
  native_module_abi_mismatch: { action: "repair", repairHandler: "repair_native_modules" },
  launchd_runtime_mismatch: { action: "repair", repairHandler: "repair_launchd_runtime" },
  health_timeout_with_live_pid: { action: "restart", repairHandler: null },
  build_failure: { action: "escalate", repairHandler: null },
  llm_parse_failure: { action: "escalate", repairHandler: null },
  llm_quota_exhausted: { action: "escalate", repairHandler: null },
};

export function getRepairHandlerForSignature(signature: WatchdogSignature): RepairHandler | null {
  return REPAIR_HANDLERS_BY_SIGNATURE[signature] ?? null;
}

export function getDeterministicPlan(signature: WatchdogSignature): DeterministicPlan | null {
  return DETERMINISTIC_PLANS[signature] ?? null;
}

export function isUnknownSignature(signature: WatchdogSignature): boolean {
  return signature === "unknown_startup_crash" || signature === "unknown_runtime_failure";
}
