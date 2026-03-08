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

export interface ToolDeps {
  getSharedStateManager: () => StateManager;
  indexer: MemoryIndexer;
  getAzureBlob: () => Promise<typeof import("../../integrations/azure-blob.js")>;
  canonicalMemory: CanonicalMemoryService;
}

export interface ToolModule {
  definitions: ToolDefinition[];
  handle: (name: string, args: Record<string, unknown>, deps: ToolDeps) => Promise<ToolResult | null>;
}
