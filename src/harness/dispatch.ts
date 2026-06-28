/**
 * Shared single-attempt dispatch — the one path a feature call should take to run "whatever
 * harness is currently selected" without naming Claude (or any harness) at the call site.
 *
 * executeResolvedHarness() resolves selection from the DB (scope → global → system-default),
 * builds the executor-agnostic HarnessRequest, and runs it through the selected adapter's
 * prepare/execute. Callers that need retry/fallback (scheduler, queue, router) must NOT use this
 * helper — they go resolver + negotiator + runWithFallbackChain directly so the fallback
 * mechanics stay intact. This is for the formerly-hardcoded `executeClaudeCommand(...)` feature
 * sites: they migrate here and start following the global selection.
 *
 * DEBT: opens a readonly better-sqlite3 connection per default-store call (cached as a module
 * singleton on the default DB path). Upgrade to thread the daemon's shared StateManager DB in
 * when a feature path runs hot enough for the extra handle to matter.
 */

// @ts-ignore — better-sqlite3 ships `export =`; type-only default import trips noUnusedLocals.
import type Database from "better-sqlite3";
// @ts-ignore — runtime default import of the CJS module for the readonly fallback connection.
import BetterSqlite3 from "better-sqlite3";

import { config } from "../config/index.js";
import { getHarnessAdapter } from "./registry.js";
import { negotiateHarnessAttempts, type HarnessAttempt } from "./negotiation.js";
import { resolveHarnessSelection } from "./resolution/resolver.js";
import { createSqliteHarnessSelectionStore, type HarnessSelectionStore } from "./resolution/store.js";
import type {
  CapabilityRequirement,
  HarnessContextPayload,
  HarnessId,
  HarnessRequest,
  HarnessResult,
  HarnessSessionRef,
  HarnessStreamHandlers,
  InvocationMode,
  OutputContract,
} from "./types.js";
import type {
  HarnessProfile,
  HarnessSelector,
  ResolvedHarnessPlan,
  SelectionSource,
} from "./resolution/types.js";
import type { ExecutorResult } from "../executors/types.js";

export interface ExecuteResolvedHarnessInput {
  requestId?: string;
  source: "scheduler" | "queue" | "runtime" | "router" | "system";
  mode: InvocationMode;
  prompt: string;

  scope?: {
    turnId?: string | null;
    conversationId?: string | null;
    lane?: string | null;
    jobId?: string | null;
  };

  explicit?: Partial<HarnessSelector> | null;
  baselineProfile?: HarnessProfile | null;
  requiredCapabilities?: CapabilityRequirement[];
  outputContract?: OutputContract;
  allowDegradation?: boolean;

  /** convenience: becomes explicit.model only when an explicit harness is supplied. */
  model?: string | null;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  runId?: string;
  session?: HarnessSessionRef | null;
  context?: HarnessContextPayload;
  stream?: HarnessStreamHandlers;

  store?: HarnessSelectionStore;
  db?: Database.Database;
}

export interface ExecuteResolvedHarnessResult extends HarnessResult {
  resolved: ResolvedHarnessPlan;
  selectionSource: SelectionSource;
}

let defaultStore: HarnessSelectionStore | null = null;
function getDefaultStore(): HarnessSelectionStore {
  if (!defaultStore) {
    const db = new BetterSqlite3(config.paths.database, { readonly: true }) as Database.Database;
    defaultStore = createSqliteHarnessSelectionStore(db);
  }
  return defaultStore;
}

/**
 * Resolve (DB scope → global → default) then NEGOTIATE: when the selected harness can't satisfy
 * the request's required capabilities, the negotiator promotes the nearest harness that can. This
 * is what makes `requiredCapabilities` live — a code-editing call won't silently run on a harness
 * that can't edit. With no required capabilities (the common case) the negotiated primary is just
 * the resolved selection, so this is behavior-neutral.
 */
function resolvePlan(input: ExecuteResolvedHarnessInput): {
  resolved: ResolvedHarnessPlan;
  attempt: HarnessAttempt;
  requestId: string;
} {
  const requestId = input.requestId ?? `dispatch_${input.mode}_${input.source}`;
  const store = input.store ?? (input.db ? createSqliteHarnessSelectionStore(input.db) : getDefaultStore());

  // A convenience `model` only takes effect when paired with an explicit harness pin.
  const explicit: Partial<HarnessSelector> | null =
    input.explicit?.harness
      ? { ...input.explicit, model: input.explicit.model ?? input.model ?? null }
      : input.explicit ?? null;

  const resolved = resolveHarnessSelection(
    {
      requestId,
      source: input.source,
      scope: {
        turnId: input.scope?.turnId ?? null,
        conversationId: input.scope?.conversationId ?? null,
        lane: input.scope?.lane ?? null,
        jobId: input.scope?.jobId ?? null,
      },
      explicit,
      baselineProfile: input.baselineProfile ?? null,
      requiredCapabilities: input.requiredCapabilities,
      outputContract: input.outputContract,
      allowDegradation: input.allowDegradation,
    },
    store,
  );

  const { primary } = negotiateHarnessAttempts({
    resolved,
    mode: input.mode,
    allowDegradation: input.allowDegradation,
  });
  return { resolved, attempt: primary, requestId };
}

/** The harness a dispatch call would actually run on (post-capability-negotiation), without executing. */
export function resolvedPrimaryHarness(input: ExecuteResolvedHarnessInput): HarnessId {
  return resolvePlan(input).attempt.harness;
}

export async function executeResolvedHarness(
  input: ExecuteResolvedHarnessInput,
): Promise<ExecuteResolvedHarnessResult> {
  const { resolved, attempt, requestId } = resolvePlan(input);

  const harness: HarnessId = attempt.harness;
  const adapter = getHarnessAdapter(harness);
  const invocation = attempt.invocation;

  // Final model: the negotiated attempt's model (resolved selection model, or the promoted
  // harness's default), else the adapter's own default if it requires one.
  // DEBT: non-null models are passed through UNVALIDATED. We deliberately skip validateModel here
  // because the semantic OpenCode pins target provider-passthrough models (e.g. google/gemini-3.5-flash)
  // that are NOT in opencode's catalog — strict validation would reject those working pins. DB model
  // rows come from validated writers (seed/switch-all/UI), so the residual risk is a hand-edited row.
  // Upgrade: add a sanctioned provider-model allowlist, then validate non-null DB-sourced models.
  let model = attempt.model;
  if (model == null) {
    const check = adapter.validateModel(null, invocation);
    model = check.ok ? check.model : null;
  }

  const req: HarnessRequest = {
    requestId,
    source: input.source,
    harness,
    invocation,
    prompt: input.prompt,
    cwd: input.cwd ?? resolved.profile.cwdOverride ?? process.env.HOME ?? config.paths.homerRoot,
    model,
    timeoutMs: input.timeoutMs ?? resolved.profile.timeoutOverride ?? 900_000,
    signal: input.signal,
    context: input.context,
    session: input.session ?? null,
    stream: input.stream,
    runId: input.runId,
    requiredCapabilities: resolved.requiredCapabilities,
    outputContract: input.outputContract ?? resolved.outputContract,
  };

  const prepared = await adapter.prepare(req);
  const result = await adapter.execute(prepared);

  return { ...result, resolved, selectionSource: resolved.selection.source };
}

/** Bridge HarnessResult → the ExecutorResult shape legacy callers parse (adds `error`). */
export function toExecutorLike(result: HarnessResult): ExecutorResult & { error?: string } {
  return {
    output: result.output,
    exitCode: result.exitCode,
    duration: result.duration,
    executor: result.harness,
    error: result.exitCode === 0 ? undefined : result.stderr ?? result.output,
  };
}
