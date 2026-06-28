/**
 * Shared adapter helpers: deterministic context injection (prepare) and result
 * normalization. Keeping injection in one place means every harness composes its
 * finalPrompt identically — the "effect-purity" property: Node assembles context,
 * the harness only generates.
 */

import type {
  HarnessId,
  HarnessRequest,
  HarnessResult,
  ModelValidation,
  PreparedHarnessRequest,
} from "../types.js";
import type { ExecutorResult } from "../../executors/types.js";
import { getCatalogEntry } from "../../commands/harness-catalog.js";

/**
 * Compose the final prompt from the request's context payload. `system` is NOT folded in
 * here — adapters route it natively where the harness supports it (claude appendSystemPrompt)
 * and inline it otherwise. promptPrefix, injected logical memory, and file blocks are
 * prepended deterministically so the same request yields the same prompt on any harness.
 */
export function composeFinalPrompt(req: HarnessRequest): string {
  const parts: string[] = [];
  if (req.context?.promptPrefix) parts.push(req.context.promptPrefix.trim());
  if (req.context?.logicalMemory) {
    parts.push(`# Retrieved memory\n${req.context.logicalMemory.trim()}`);
  }
  for (const file of req.context?.files ?? []) {
    parts.push(`# File: ${file.path}\n${file.content}`);
  }
  parts.push(req.prompt);
  return parts.filter(Boolean).join("\n\n");
}

export function prepareRequest(req: HarnessRequest): PreparedHarnessRequest {
  return { ...req, finalPrompt: composeFinalPrompt(req) };
}

/** Normalize any executor wrapper result into the harness contract's HarnessResult. */
export function toHarnessResult(
  harness: HarnessId,
  model: string | null,
  raw: ExecutorResult & { stderr?: string },
  rawExecutor: string,
): HarnessResult {
  return {
    output: raw.output,
    exitCode: raw.exitCode,
    duration: raw.duration,
    harness,
    model,
    stderr: raw.stderr,
    rawExecutor,
  };
}

/**
 * Validate a model against the catalog for a harness. Shared by every adapter's
 * validateModel() so the contract and the catalog never disagree.
 */
export function validateModelAgainstCatalog(
  harness: HarnessId,
  model: string | null | undefined,
): ModelValidation {
  const entry = getCatalogEntry(harness);
  if (!entry) return { ok: false, code: "unknown_model", message: `Unknown harness "${harness}"` };
  const m = model ?? null;
  if (entry.modelMode === "none") {
    if (m) {
      return { ok: false, code: "model_not_allowed", message: `${harness} is CLI-managed and takes no model` };
    }
    return { ok: true, model: null };
  }
  if (!m) return { ok: true, model: entry.defaultModel };
  if (!entry.models.some((x) => x.id === m)) {
    return { ok: false, code: "unknown_model", message: `Model "${m}" is not valid for ${harness}` };
  }
  return { ok: true, model: m };
}
