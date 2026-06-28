/**
 * Harness contract — the single interface every harness (claude | codex | opencode |
 * gemini | kimi) implements. Downstream code depends on this contract, never a concrete
 * harness. Push 1 introduces the contract + descriptors; the scheduler routes SELECTION
 * through the resolver while still dispatching execution via the legacy execute*Job ladder
 * (behavior-neutral). Adapter execute()/prepare() wrap the raw executors and are exercised
 * by conformance tests; the live-chat/router push later moves runtime dispatch onto them.
 *
 * Spec: ~/homer/output/codex/harness-push1-backend-spec-2026-06-28.md
 */

import type { StreamStepEvent } from "../executors/claude.js";
import type { HarnessExecutor } from "../commands/harness-catalog.js";

/** The five CLI harnesses. Aliased to the catalog's HarnessExecutor so the two never drift. */
export type HarnessId = HarnessExecutor;

/**
 * HOW Homer invokes a harness. The SAME harness has different capabilities depending on
 * invocation mode (e.g. opencode in research-only mode can't edit files; gemini direct-CLI
 * has no MCP while gemini-via-opencode does). Descriptors are keyed by (harness, mode).
 */
export type InvocationMode =
  | "scheduler-job"
  | "scheduler-internal"
  | "runtime-turn"
  | "router"
  | "diagnostic"
  | "completion-checkup"
  | "browser-scrape"
  | "idea-analysis";

export interface InvocationProfile {
  mode: InvocationMode;
  forceOpenCode?: boolean;
  researchOnly?: boolean;
  browserOnly?: boolean;
  agent?: "build" | "plan" | string;
  sandbox?: boolean;
  yolo?: boolean;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | string;
  /** gemini adapter: true → native Gemini API (JSON/grounding); false/undefined → direct CLI. */
  nativeGeminiApi?: boolean;
}

export type Capability =
  | "text.generate"
  | "stream.text.delta"
  | "stream.text.cumulative"
  | "stream.events.structured"
  | "output.structured.json"
  | "context.inject.system"
  | "context.inject.prompt"
  | "context.inject.files"
  | "session.resume"
  | "session.pool"
  | "vision.image"
  | "tools.shell"
  | "tools.files.read"
  | "tools.files.write"
  | "tools.mcp.native"
  | "tools.mcp.logical"
  | "memory.read"
  | "memory.write"
  | "web.search"
  | "browser.agent"
  | "code.edit"
  | "long_context.200k"
  | "long_context.1m";

/**
 * How well a harness provides a capability, ordered weakest→strongest:
 *  none      — absent.
 *  prompted  — achievable by asking; output must be validated by Node (e.g. JSON shape).
 *  sidecar   — Node provides it outside the harness (e.g. memory injected into context).
 *  native    — first-class harness/wrapper mechanism.
 *  preferred — native AND the best available for this capability.
 */
export type CapabilityLevel = "none" | "prompted" | "sidecar" | "native" | "preferred";

export const CAPABILITY_LEVEL_ORDER: Record<CapabilityLevel, number> = {
  none: 0,
  prompted: 1,
  sidecar: 2,
  native: 3,
  preferred: 4,
};

export interface CapabilityDescriptor {
  capability: Capability;
  level: CapabilityLevel;
  notes?: string;
}

export interface CapabilityRequirement {
  capability: Capability;
  required: boolean;
  /** Minimum acceptable level; defaults to "prompted" (anything better than "none"). */
  minLevel?: Exclude<CapabilityLevel, "none">;
  reason: string;
}

export type StreamingMode = "none" | "delta_text" | "cumulative_text" | "structured_events";
export type SessionMode = "none" | "resume" | "pooled";

export interface ModelDescriptor {
  id: string | null;
  label: string;
  default?: boolean;
  maxContextTokens?: number;
}

export interface HarnessDescriptor {
  harness: HarnessId;
  invocation: InvocationProfile;
  label: string;
  defaultModel: string | null;
  models: ModelDescriptor[];
  capabilities: CapabilityDescriptor[];
  streamingMode: StreamingMode;
  sessionMode: SessionMode;
  /** Media types accepted as attachments (e.g. ["image/png"]); empty = text-only. */
  supportsAttachments: string[];
}

export type OutputContract =
  | { kind: "text" }
  | { kind: "json"; schemaName?: string; strict?: boolean };

export interface HarnessContextPayload {
  system?: string;
  promptPrefix?: string;
  files?: Array<{ path: string; content: string }>;
  /** Memory retrieved by Node and injected as text for harnesses lacking native MCP. */
  logicalMemory?: string;
}

export interface HarnessAttachment {
  path: string;
  mediaType?: string;
}

export interface HarnessSessionRef {
  lane?: string;
  sessionId: string;
  accountId?: number | null;
  harness: HarnessId;
  model: string | null;
}

export interface HarnessStreamHandlers {
  onPartial?: (text: string) => void;
  onMessageChunk?: (chunk: { id?: string; phase: string; delta: string }) => void;
  onEvent?: (event: StreamStepEvent) => void;
}

export interface HarnessRequest {
  requestId: string;
  source: "scheduler" | "runtime" | "router" | "queue" | "system";
  harness: HarnessId;
  invocation: InvocationProfile;
  prompt: string;
  cwd: string;
  model: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  context?: HarnessContextPayload;
  attachments?: HarnessAttachment[];
  requiredCapabilities: CapabilityRequirement[];
  outputContract?: OutputContract;
  session?: HarnessSessionRef | null;
  stream?: HarnessStreamHandlers;
  /** Homer run identifier propagated into ProcessRegistry. */
  runId?: string;
  options?: Record<string, unknown>;
}

export interface PreparedHarnessRequest extends HarnessRequest {
  /** Prompt after context/memory injection — what the adapter actually sends. */
  finalPrompt: string;
}

export interface HarnessResult {
  output: string;
  exitCode: number;
  duration: number;
  harness: HarnessId;
  model: string | null;
  session?: HarnessSessionRef | null;
  stderr?: string;
  /** Name of the concrete executor function that ran (for trace/audit). */
  rawExecutor?: string;
}

export type ModelValidation =
  | { ok: true; model: string | null }
  | { ok: false; code: "unknown_model" | "model_not_allowed"; message: string };

export interface HarnessHealth {
  healthy: boolean;
  disabledUntil?: number;
  reason?: string;
}

/**
 * Every harness implements this. The scheduler/runtime/router depend on HarnessAdapter,
 * never on executeClaudeCommand/executeCodexCLI/etc directly.
 */
export interface HarnessAdapter {
  id: HarnessId;
  descriptor(profile: InvocationProfile): HarnessDescriptor;
  validateModel(model: string | null | undefined, profile: InvocationProfile): ModelValidation;
  prepare(req: HarnessRequest): Promise<PreparedHarnessRequest>;
  execute(req: PreparedHarnessRequest): Promise<HarnessResult>;
  resume?(session: HarnessSessionRef, req: PreparedHarnessRequest): Promise<HarnessResult>;
  health?(profile: InvocationProfile): Promise<HarnessHealth>;
}
