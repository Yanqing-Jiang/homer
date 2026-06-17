/**
 * Shared types and dependencies for MCP tool modules.
 */

import type { StateManager } from "../../state/manager.js";
import type { MemoryIndexer } from "../../memory/indexer.js";
import type { CanonicalMemoryService } from "../../memory/canonical-service.js";

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Policy applied when the MCP server is exposed to an untrusted remote caller
 * (the work-laptop over HTTP). Absent for the local stdio server. Tool handlers
 * read this to clamp/stamp writes and narrow read surface; the server factory
 * separately enforces the tool allowlist at the transport layer.
 */
export interface RemotePolicy {
  /** Force this origin_device on any candidate written by the remote caller. */
  originDevice?: string;
  /** Clamp memory_suggest confidence to at most this (keeps it below auto-approve). */
  maxSuggestConfidence?: number;
  /** If set, memory_read may only read these canonical file keys (no daily/archive). */
  readableFiles?: string[];
  /**
   * When true, memory_search returns ONLY durable memory (md chunks) + approved
   * knowledge_claims — no session summaries, threads, takeovers, scrapes, ideas,
   * YouTube, transcripts, candidate/archived claims. Keeps operational/personal
   * stores off an untrusted (e.g. corp-inspected) remote path.
   */
  durableReadOnly?: boolean;
}

export interface ToolDeps {
  getSharedStateManager: () => StateManager;
  indexer: MemoryIndexer;
  getAzureBlob: () => Promise<typeof import("../../integrations/azure-blob.js")>;
  canonicalMemory: CanonicalMemoryService;
  /** Present only when serving an untrusted remote caller. Undefined = local stdio. */
  remotePolicy?: RemotePolicy;
}

export interface ToolModule {
  definitions: ToolDefinition[];
  handle: (name: string, args: Record<string, unknown>, deps: ToolDeps) => Promise<ToolResult | null>;
}
