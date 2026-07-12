/**
 * Capability negotiator — turns a resolved selection into an ordered list of attempts,
 * degrading by CAPABILITY rather than by a hardcoded hop to Claude. When the selected
 * harness lacks a required capability, the next attempt is the nearest harness that HAS it,
 * chosen from the descriptor matrix. No rule may name Claude as a special target.
 *
 * A `compatibilityOrder` (today's DEFAULT_FALLBACK_ORDER / MEMORY_FALLBACK_ORDER, or a per-job
 * fallbackChain) ranks otherwise capability-equivalent candidates without ever overriding a
 * capability decision, and `maxAttempts` (default: compatibilityOrder depth + 1) bounds the chain.
 *
 * CUTOVER (2026-06-28): wired into the live scheduler fallback path — runJobHarness now builds its
 * chain via negotiatedSchedulerChain() instead of a hardcoded list. With zero required capabilities
 * (the common scheduler case) this reduces to buildChain(primary, compatibilityOrder), so it is
 * behavior-neutral today.
 * DEBT: derive the fallback ranking from capability descriptors + per-job fallback data so the
 * transitional *_FALLBACK_ORDER lists can be deleted; route queue/worker, cli-runner, router through
 * this negotiator too. Upgrade when descriptors rank degradation targets without a hardcoded order.
 */

import { getHarnessDescriptor, missingCapabilities } from "./capabilities.js";
import { HARNESS_IDS, HARNESS_REGISTRY, RETIRED_HARNESS_IDS } from "./registry.js";
import type {
  Capability,
  HarnessHealth,
  HarnessId,
  InvocationMode,
  InvocationProfile,
} from "./types.js";
import type { HarnessProfile, ResolvedHarnessPlan, HarnessResolutionAuditStep } from "./resolution/types.js";

export type CapabilityMissKind = "capability" | "health" | "model" | "output_contract";

export interface HarnessAttempt {
  harness: HarnessId;
  model: string | null;
  invocation: InvocationProfile;
  profile: HarnessProfile;
  reason: string;
  degradedFrom?: HarnessId;
  missing?: Array<{ capability: Capability; kind: CapabilityMissKind; detail: string }>;
}

export interface NegotiateHarnessAttemptsInput {
  resolved: ResolvedHarnessPlan;
  mode: InvocationMode;
  health?: Partial<Record<HarnessId, HarnessHealth>>;
  /** Behavior-neutral bridge: today's chain order. Orders candidates; never overrides capability. */
  compatibilityOrder?: HarnessId[];
  allowDegradation?: boolean;
}

export interface HarnessAttemptPlan {
  primary: HarnessAttempt;
  attempts: HarnessAttempt[];
  audit: HarnessResolutionAuditStep[];
}

function invocationFor(mode: InvocationMode, profile: HarnessProfile): InvocationProfile {
  const opts = profile.executorOptions ?? {};
  return {
    mode,
    reasoningEffort: opts.codex?.reasoningEffort,
    forceOpenCode: opts.opencode?.forceOpenCode,
    researchOnly: opts.opencode?.researchOnly,
    browserOnly: opts.opencode?.browserOnly,
    agent: opts.opencode?.agent,
    yolo: opts.opencode?.yolo ?? opts.kimi?.yolo,
    sandbox: opts.opencode?.sandbox,
    ...profile.invocation,
  };
}

function isHealthy(harness: HarnessId, health?: NegotiateHarnessAttemptsInput["health"]): boolean {
  const h = health?.[harness];
  if (!h) return true;
  if (h.healthy) return true;
  if (h.disabledUntil && h.disabledUntil < Date.now()) return true;
  return false;
}

/** Rank capability-satisfying candidates: same-harness alt profile first, then compat order, then registry order. */
function candidateOrder(primary: HarnessId, compatibilityOrder?: HarnessId[]): HarnessId[] {
  const seen = new Set<HarnessId>();
  const ordered: HarnessId[] = [];
  const push = (h: HarnessId) => {
    if (!seen.has(h)) {
      seen.add(h);
      ordered.push(h);
    }
  };
  push(primary);
  for (const h of compatibilityOrder ?? []) {
    if (!RETIRED_HARNESS_IDS.has(h)) push(h);
  }
  for (const h of HARNESS_IDS) {
    if (!RETIRED_HARNESS_IDS.has(h)) push(h);
  }
  return ordered;
}

export function negotiateHarnessAttempts(input: NegotiateHarnessAttemptsInput): HarnessAttemptPlan {
  const { resolved, mode } = input;
  const audit: HarnessResolutionAuditStep[] = [];
  const required = resolved.requiredCapabilities;
  const allowDegradation =
    input.allowDegradation ?? resolved.profile.fallbackPolicy?.allowDegradation ?? true;
  const compatibilityOrder =
    input.compatibilityOrder ?? resolved.profile.fallbackPolicy?.preserveCurrentOrder;

  const selected = resolved.selection.harness;
  const primaryInvocation = invocationFor(mode, resolved.profile);
  const primaryDescriptor = getHarnessDescriptor(selected, primaryInvocation);
  const primaryMissing = missingCapabilities(primaryDescriptor, required);

  const primary: HarnessAttempt = {
    harness: selected,
    model: resolved.selection.model,
    invocation: primaryInvocation,
    profile: resolved.profile,
    reason: `resolved selection (${resolved.selection.source})`,
    missing: primaryMissing.map((r) => ({
      capability: r.capability,
      kind: "capability" as const,
      detail: r.reason,
    })),
  };

  audit.push({
    source: "capability",
    found: primaryMissing.length === 0,
    harness: selected,
    model: resolved.selection.model,
    reason:
      primaryMissing.length === 0
        ? "selected harness satisfies all required capabilities"
        : `selected harness missing: ${primaryMissing.map((r) => r.capability).join(", ")}`,
  });

  // If the primary satisfies everything and is healthy, attempts are just degradation fallbacks
  // (capability-equivalent harnesses) in compatibility/registry order.
  const attempts: HarnessAttempt[] = [primary];

  if (!allowDegradation) {
    return { primary, attempts, audit };
  }

  // Bound the attempt list: honor an explicit policy, else the compatibility-order depth + the
  // primary (behavior-neutral vs the pre-cutover fixed chains), else a small default. Without
  // this a generic no-required-capability job would try every registry harness.
  const maxAttempts =
    resolved.profile.fallbackPolicy?.maxAttempts
    ?? (compatibilityOrder ? compatibilityOrder.length + 1 : 3);

  for (const harness of candidateOrder(selected, compatibilityOrder)) {
    if (attempts.length >= maxAttempts) break;
    if (harness === selected) continue;
    if (!isHealthy(harness, input.health)) continue;

    const invocation = invocationFor(mode, resolved.profile);
    const descriptor = getHarnessDescriptor(harness, invocation);
    const stillMissing = missingCapabilities(descriptor, required);
    if (stillMissing.length > 0) continue; // can't satisfy requirements → not a valid degradation

    // Model: a degraded harness uses its own default (the resolved model belongs to `selected`).
    const adapter = HARNESS_REGISTRY[harness];
    const modelCheck = adapter.validateModel(null, invocation);
    const model = modelCheck.ok ? modelCheck.model : null;

    const reasonForSwitch =
      primaryMissing.length > 0
        ? `degraded from ${selected} (lacks ${primaryMissing.map((r) => r.capability).join(", ")})`
        : `fallback after ${selected}`;

    attempts.push({
      harness,
      model,
      invocation,
      profile: resolved.profile,
      reason: reasonForSwitch,
      degradedFrom: selected,
    });
  }

  // If the primary itself can't satisfy requirements, promote the first satisfying degradation
  // to be the de-facto primary while keeping the full ordered attempt list for the runner.
  const effectivePrimary =
    primaryMissing.length === 0 ? primary : attempts.find((a) => a.harness !== selected) ?? primary;

  if (effectivePrimary !== primary) {
    audit.push({
      source: "capability",
      found: true,
      harness: effectivePrimary.harness,
      reason: `promoted ${effectivePrimary.harness} as primary: ${selected} cannot satisfy required capabilities`,
    });
  }

  return { primary: effectivePrimary, attempts, audit };
}
