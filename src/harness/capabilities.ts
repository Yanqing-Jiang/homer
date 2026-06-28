/**
 * Capability matrix — what each harness can do, keyed by (harness, invocation mode/profile).
 * This is the data the negotiator reads to degrade by CAPABILITY rather than by a hardcoded
 * hop to Claude. Seeded from the spec's Push-1 matrix; grounded in the executor wrappers.
 *
 * Correction baked in (vs prior docs): Homer's codex executor wrapper does NOT pass
 * --ignore-user-config (src/executors/codex-cli.ts), so codex DOES reach homer-memory MCP
 * in scheduler/runtime modes. Only an explicitly ignoreUserConfig profile would strip it.
 */

import {
  type Capability,
  type CapabilityDescriptor,
  type CapabilityLevel,
  type CapabilityRequirement,
  type HarnessDescriptor,
  type HarnessId,
  type InvocationProfile,
  type ModelDescriptor,
  type SessionMode,
  type StreamingMode,
  CAPABILITY_LEVEL_ORDER,
} from "./types.js";
import { getCatalogEntry } from "../commands/harness-catalog.js";

type CapMap = Partial<Record<Capability, CapabilityLevel>>;

/** Capabilities shared by every harness invocation unless a profile downgrades them. */
const UNIVERSAL: CapMap = {
  "text.generate": "native",
  "context.inject.prompt": "native",
  "context.inject.files": "native",
  "tools.mcp.logical": "sidecar",
  "memory.read": "sidecar",
  "memory.write": "sidecar",
};

/** Base per-harness capability levels (scheduler-job mode is the reference invocation). */
const BASE: Record<HarnessId, CapMap> = {
  claude: {
    "output.structured.json": "prompted",
    "stream.text.cumulative": "native",
    "stream.events.structured": "native",
    "context.inject.system": "native",
    "session.resume": "native",
    "vision.image": "preferred",
    "tools.shell": "native",
    "tools.files.read": "native",
    "tools.files.write": "native",
    "tools.mcp.native": "preferred",
    "tools.mcp.logical": "native",
    "memory.read": "preferred",
    "memory.write": "preferred",
    "web.search": "native",
    "code.edit": "native",
    "long_context.200k": "native",
    "long_context.1m": "native",
  },
  codex: {
    "output.structured.json": "prompted",
    "stream.text.cumulative": "native",
    "stream.events.structured": "native",
    "context.inject.system": "prompted",
    "session.resume": "native",
    "vision.image": "none",
    "tools.shell": "native",
    "tools.files.read": "native",
    "tools.files.write": "native",
    // Homer's codex wrapper keeps user config → homer-memory MCP is reachable.
    "tools.mcp.native": "native",
    "tools.mcp.logical": "native",
    "memory.read": "native",
    "memory.write": "native",
    "code.edit": "native",
    "long_context.1m": "native",
    "long_context.200k": "native",
  },
  opencode: {
    "output.structured.json": "prompted",
    "stream.text.cumulative": "native",
    "stream.events.structured": "none",
    "context.inject.system": "prompted",
    "session.resume": "native",
    "vision.image": "none", // GLM-5.2 default is text-only
    "tools.shell": "native",
    "tools.files.read": "native",
    "tools.files.write": "native",
    "tools.mcp.native": "native",
    "tools.mcp.logical": "native",
    "memory.read": "native",
    "memory.write": "native",
    "web.search": "native",
    "code.edit": "native",
    "long_context.1m": "native",
    "long_context.200k": "native",
  },
  gemini: {
    "output.structured.json": "prompted",
    "stream.text.cumulative": "none",
    "context.inject.system": "prompted",
    "vision.image": "none",
    "tools.shell": "prompted",
    "code.edit": "prompted",
    "long_context.200k": "native",
  },
  kimi: {
    "output.structured.json": "prompted",
    "context.inject.system": "prompted",
    "tools.shell": "prompted",
    "code.edit": "prompted",
    "long_context.200k": "native",
  },
};

const STREAMING: Record<HarnessId, StreamingMode> = {
  claude: "structured_events",
  codex: "structured_events",
  opencode: "cumulative_text",
  gemini: "none",
  kimi: "none",
};

const SESSION: Record<HarnessId, SessionMode> = {
  claude: "resume",
  codex: "resume",
  opencode: "resume",
  gemini: "none",
  kimi: "none",
};

const ATTACHMENTS: Record<HarnessId, string[]> = {
  claude: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  codex: [],
  opencode: [],
  gemini: [],
  kimi: [],
};

/**
 * Apply invocation-profile adjustments to a base capability map. This is where the
 * (harness × mode) divergence lives — e.g. opencode researchOnly loses file writes,
 * gemini native-API gains structured JSON, an ignoreUserConfig profile strips native MCP.
 */
function applyProfile(harness: HarnessId, base: CapMap, profile: InvocationProfile): CapMap {
  const caps: CapMap = { ...base };

  if (harness === "opencode") {
    if (profile.researchOnly) {
      caps["tools.files.write"] = "none";
      caps["code.edit"] = "none";
      caps["web.search"] = "preferred";
    }
    if (profile.browserOnly) {
      caps["browser.agent"] = "native";
    }
  }

  if (harness === "gemini") {
    if (profile.forceOpenCode) {
      // gemini routed through opencode's backend gains opencode's MCP + streaming.
      caps["tools.mcp.native"] = "native";
      caps["memory.read"] = "native";
      caps["memory.write"] = "native";
      caps["stream.text.cumulative"] = "native";
      caps["session.resume"] = "native";
    } else if (profile.nativeGeminiApi) {
      caps["output.structured.json"] = "native";
      caps["web.search"] = "native";
    }
  }

  // An explicit config-stripping profile removes native MCP (logical sidecar remains).
  if ((profile as { ignoreUserConfig?: boolean }).ignoreUserConfig) {
    caps["tools.mcp.native"] = "none";
    caps["memory.read"] = "sidecar";
    caps["memory.write"] = "sidecar";
  }

  return caps;
}

function toDescriptors(caps: CapMap): CapabilityDescriptor[] {
  return (Object.entries(caps) as Array<[Capability, CapabilityLevel]>)
    .filter(([, level]) => level !== "none")
    .map(([capability, level]) => ({ capability, level }));
}

function modelDescriptors(harness: HarnessId): { models: ModelDescriptor[]; defaultModel: string | null } {
  const entry = getCatalogEntry(harness);
  if (!entry) return { models: [], defaultModel: null };
  return {
    models: entry.models.map((m) => ({ id: m.id, label: m.label, default: m.default })),
    defaultModel: entry.defaultModel,
  };
}

/** Build the descriptor for a harness under a specific invocation profile. */
export function getHarnessDescriptor(
  harness: HarnessId,
  invocation: InvocationProfile,
): HarnessDescriptor {
  const merged: CapMap = { ...UNIVERSAL, ...BASE[harness] };
  const caps = applyProfile(harness, merged, invocation);
  const { models, defaultModel } = modelDescriptors(harness);
  const entry = getCatalogEntry(harness);
  return {
    harness,
    invocation,
    label: entry?.label ?? harness,
    defaultModel,
    models,
    capabilities: toDescriptors(caps),
    streamingMode: STREAMING[harness],
    sessionMode: SESSION[harness],
    supportsAttachments: ATTACHMENTS[harness],
  };
}

/** Level a descriptor provides for a capability ("none" if absent). */
export function capabilityLevel(descriptor: HarnessDescriptor, capability: Capability): CapabilityLevel {
  return descriptor.capabilities.find((c) => c.capability === capability)?.level ?? "none";
}

/** True if the descriptor satisfies a requirement at or above its minimum level. */
export function supportsCapability(
  descriptor: HarnessDescriptor,
  requirement: CapabilityRequirement,
): boolean {
  const have = capabilityLevel(descriptor, requirement.capability);
  const need = requirement.minLevel ?? "prompted";
  return CAPABILITY_LEVEL_ORDER[have] >= CAPABILITY_LEVEL_ORDER[need];
}

/** All requirements a descriptor fails to satisfy. */
export function missingCapabilities(
  descriptor: HarnessDescriptor,
  requirements: CapabilityRequirement[],
): CapabilityRequirement[] {
  return requirements.filter((r) => r.required && !supportsCapability(descriptor, r));
}
