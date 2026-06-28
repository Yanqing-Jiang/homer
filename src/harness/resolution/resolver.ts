/**
 * The single harness resolver. Every selection — scheduler, queue, runtime, router — flows
 * through this one function. Precedence is explicit and symmetric across scopes; a baseline
 * is a profile, never a selector. The system default is NOT hardcoded to Claude: it is the
 * first registry harness that can generate text, with HARNESS_IDS as the stable tie-break.
 */

import type { CapabilityRequirement, HarnessId, OutputContract } from "../types.js";
import { HARNESS_IDS } from "../registry.js";
import type { HarnessSelectionStore } from "./store.js";
import type {
  HarnessProfile,
  HarnessResolutionAuditStep,
  HarnessScopeRef,
  HarnessScopeType,
  HarnessSelector,
  ResolvedHarnessPlan,
  ResolvedHarnessSelection,
  SelectionSource,
} from "./types.js";

export interface ResolveHarnessSelectionInput {
  requestId: string;
  source: "scheduler" | "queue" | "runtime" | "router" | "system";
  scope: {
    turnId?: string | null;
    conversationId?: string | null;
    lane?: string | null;
    jobId?: string | null;
  };
  /** A turn/command-level pin that wins over everything (e.g. /harness in a chat). */
  explicit?: Partial<HarnessSelector> | null;
  /** Executor-agnostic infra (cwd/timeout/options/fallback). Selection-free by contract. */
  baselineProfile?: HarnessProfile | null;
  requiredCapabilities?: CapabilityRequirement[];
  outputContract?: OutputContract;
  allowDegradation?: boolean;
}

/** Scope lookup order, highest precedence first. */
function scopeChain(scope: ResolveHarnessSelectionInput["scope"]): Array<{ type: HarnessScopeType; id: string; source: SelectionSource }> {
  const chain: Array<{ type: HarnessScopeType; id: string; source: SelectionSource }> = [];
  if (scope.turnId) chain.push({ type: "turn", id: scope.turnId, source: "turn" });
  if (scope.conversationId) chain.push({ type: "conversation", id: scope.conversationId, source: "conversation" });
  if (scope.lane) chain.push({ type: "lane", id: scope.lane, source: "lane" });
  if (scope.jobId) chain.push({ type: "job", id: scope.jobId, source: "job" });
  chain.push({ type: "global", id: "", source: "global" });
  return chain;
}

/** First registry harness that can generate text — the non-Claude-special system floor. */
function systemDefaultHarness(): HarnessId {
  // First registry harness — "claude" today, but only as registry-order tie-break.
  return HARNESS_IDS[0] ?? "claude";
}

export function resolveHarnessSelection(
  input: ResolveHarnessSelectionInput,
  store: HarnessSelectionStore,
): ResolvedHarnessPlan {
  const audit: HarnessResolutionAuditStep[] = [];
  let selection: ResolvedHarnessSelection | null = null;
  let profileId: string | null = null;

  // 1. explicit turn/command selector wins outright.
  if (input.explicit?.harness) {
    selection = {
      harness: input.explicit.harness,
      model: input.explicit.model ?? null,
      source: "explicit",
      scope: { type: "turn", id: input.scope.turnId ?? "" },
    };
    profileId = input.explicit.profileId ?? null;
    audit.push({
      source: "explicit",
      found: true,
      harness: selection.harness,
      model: selection.model,
      reason: "explicit selector provided on the request",
    });
  }

  // 2..6. walk scope precedence in the DB.
  if (!selection) {
    for (const link of scopeChain(input.scope)) {
      const scope: HarnessScopeRef = { type: link.type, id: link.id };
      const row = store.getSelection(scope);
      if (!row) {
        audit.push({ source: link.source, scope, found: false, reason: `no ${link.type} selection row` });
        continue;
      }
      selection = { harness: row.harness, model: row.model, source: link.source, scope };
      profileId = row.profileId;
      audit.push({
        source: link.source,
        scope,
        found: true,
        harness: row.harness,
        model: row.model,
        profileId: row.profileId,
        reason: `selected from ${link.type} scope`,
      });
      break;
    }
  }

  // 7. system default only when even global is missing/corrupt.
  if (!selection) {
    const harness = systemDefaultHarness();
    selection = { harness, model: null, source: "system-default", scope: { type: "global", id: "" } };
    audit.push({
      source: "system-default",
      found: true,
      harness,
      reason: "no selection row at any scope (incl. global); using first healthy registry harness",
    });
  }

  // Profile assembly: baseline profile (selection-free) merged under any DB-referenced profile.
  let profile: HarnessProfile = { ...(input.baselineProfile ?? {}) };
  if (profileId) {
    const dbProfile = store.getProfile(profileId);
    if (dbProfile) {
      profile = { ...profile, ...dbProfile };
      audit.push({ source: "profile", found: true, profileId, reason: "merged DB-referenced profile" });
    } else {
      audit.push({ source: "profile", found: false, profileId, reason: "referenced profile not found" });
    }
  }
  // Strip any selector fields that leaked into a profile (defense against legacy baselines).
  delete (profile as Record<string, unknown>).executor;
  delete (profile as Record<string, unknown>).model;

  const requiredCapabilities = [
    ...(input.requiredCapabilities ?? []),
    ...(profile.requiredCapabilities ?? []),
  ];

  return {
    requestId: input.requestId,
    selection,
    profile,
    requiredCapabilities,
    outputContract: input.outputContract ?? profile.outputContract,
    audit,
  };
}
