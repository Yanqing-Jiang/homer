/**
 * Harness registry — the ONLY module that imports concrete adapter files. After Push 1,
 * the scheduler may import registry/execute/resolver APIs but must never import the raw
 * executeXCommand wrappers directly (enforced by harness-lint).
 */

import type { HarnessAdapter, HarnessDescriptor, HarnessId, InvocationProfile } from "./types.js";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import { geminiAdapter } from "./adapters/gemini.js";
import { kimiAdapter } from "./adapters/kimi.js";

/** Stable registry order — also the deterministic tie-break for system-default selection. */
export const HARNESS_IDS: readonly HarnessId[] = ["claude", "codex", "opencode", "gemini", "kimi"] as const;

export const HARNESS_REGISTRY: Readonly<Record<HarnessId, HarnessAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  gemini: geminiAdapter,
  kimi: kimiAdapter,
};

export function getHarnessAdapter(id: HarnessId): HarnessAdapter {
  const adapter = HARNESS_REGISTRY[id];
  if (!adapter) throw new Error(`No harness adapter registered for "${id}"`);
  return adapter;
}

export function getDescriptor(id: HarnessId, profile: InvocationProfile): HarnessDescriptor {
  return getHarnessAdapter(id).descriptor(profile);
}

export function allDescriptors(profile: InvocationProfile): HarnessDescriptor[] {
  return HARNESS_IDS.map((id) => getDescriptor(id, profile));
}
