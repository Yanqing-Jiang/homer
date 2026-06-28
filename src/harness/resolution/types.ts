/**
 * Resolution types — the data the single resolver reads and emits. The key invariant:
 * a baseline is a PROFILE (cwd/timeout/options/fallback), NEVER a selector. Harness+model
 * selection lives only in harness_selection rows, ordered by scope precedence.
 */

import type {
  CapabilityRequirement,
  HarnessId,
  InvocationProfile,
  OutputContract,
} from "../types.js";

export type HarnessScopeType = "global" | "job" | "lane" | "conversation" | "turn";

export interface HarnessScopeRef {
  type: HarnessScopeType;
  id: string; // global uses ""
}

export interface HarnessSelector {
  harness: HarnessId;
  model: string | null;
  profileId?: string | null;
}

/** Executor-agnostic infra a job carries regardless of which harness runs it. */
export interface HarnessProfile {
  profileId?: string;
  cwdOverride?: string;
  timeoutOverride?: number;
  executorOptions?: {
    codex?: { reasoningEffort?: string };
    opencode?: {
      forceOpenCode?: boolean;
      researchOnly?: boolean;
      browserOnly?: boolean;
      agent?: string;
      yolo?: boolean;
      sandbox?: boolean;
    };
    kimi?: { yolo?: boolean };
  };
  invocation?: Partial<InvocationProfile>;
  requiredCapabilities?: CapabilityRequirement[];
  fallbackPolicy?: HarnessFallbackPolicy;
  outputContract?: OutputContract;
}

export interface HarnessFallbackPolicy {
  allowDegradation: boolean;
  /** Behavior-neutral bridge: today's chain order, fed to the negotiator during Push 1. */
  preserveCurrentOrder?: HarnessId[];
  maxAttempts?: number;
}

export type SelectionSource =
  | "turn"
  | "conversation"
  | "lane"
  | "job"
  | "global"
  | "explicit"
  | "system-default";

export interface HarnessResolutionAuditStep {
  source: SelectionSource | "profile" | "capability";
  scope?: HarnessScopeRef;
  found: boolean;
  harness?: HarnessId | null;
  model?: string | null;
  profileId?: string | null;
  reason: string;
}

export interface ResolvedHarnessSelection {
  harness: HarnessId;
  model: string | null;
  source: SelectionSource;
  scope: HarnessScopeRef;
}

export interface ResolvedHarnessPlan {
  requestId: string;
  selection: ResolvedHarnessSelection;
  profile: HarnessProfile;
  requiredCapabilities: CapabilityRequirement[];
  outputContract?: OutputContract;
  audit: HarnessResolutionAuditStep[];
}
