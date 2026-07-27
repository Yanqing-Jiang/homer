/**
 * Homer Memory MCP — shared server factory.
 *
 * Builds the MCP `Server` (tool list + dispatch + result budgeting) for the one
 * transport that exists: local stdio (src/mcp/index.ts), full toolset. The HTTP
 * transport and its allowlist/RemotePolicy machinery were deleted with the
 * work-laptop path — no remote caller reaches this server.
 *
 * The heavy deps (StateManager, MemoryIndexer, CanonicalMemoryService) are built
 * once as module singletons and shared across every server instance, so creating
 * a fresh Server stays cheap. Callers pass only options; they never construct
 * Homer's concrete types.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getMemoryIndexer } from "../memory/indexer.js";
import { StateManager } from "../state/manager.js";
import { PATHS } from "../config/paths.js";
import type { ToolDeps, ToolModule } from "./tools/types.js";
import { getCanonicalMemoryService } from "../memory/canonical-service.js";
import { runMigrations } from "../state/migrations/index.js";

// Tool modules
import * as memoryTools from "./tools/memory.js";
import * as todoTools from "./tools/todos.js";
import * as blobTools from "./tools/blob.js";
import * as sessionTools from "./tools/sessions.js";
import * as callTools from "./tools/calls.js";

// All tool modules in dispatch order
const toolModules: ToolModule[] = [
  memoryTools, todoTools, blobTools, sessionTools, callTools,
];

export interface HomerMcpServerOptions {
  /**
   * Explicit SQLite path. REQUIRED when hosting inside another process whose
   * HOMER_ROOT differs from homer's — otherwise homer's PATHS.db resolves
   * relative to the host's root and opens the wrong DB. Defaults to PATHS.db
   * (correct for the local stdio server running under homer's own root).
   */
  dbPath?: string;
  /** Server identity advertised over MCP. */
  name?: string;
  version?: string;
}

// Lazy-load azure-blob so a missing optional dep doesn't break startup.
let azureBlobModule: typeof import("../integrations/azure-blob.js") | null = null;
async function getAzureBlob() {
  if (!azureBlobModule) {
    try {
      azureBlobModule = await import("../integrations/azure-blob.js");
    } catch {
      throw new Error("Azure Blob Storage not available. Install @azure/storage-blob: npm install @azure/storage-blob");
    }
  }
  return azureBlobModule;
}

// ── Shared deps singletons, keyed by DB path ─────────────────────────────────
// Built once per DB path and reused across all server instances on that path.
// Keying by path lets the local stdio server (PATHS.db) and an embedded host
// (explicit canonical path) coexist without clobbering each other.
const depsByPath = new Map<string, ToolDeps>();
function getSharedDeps(dbPath: string): ToolDeps {
  let base = depsByPath.get(dbPath);
  if (!base) {
    const stateManager = new StateManager(dbPath);
    runMigrations(stateManager.getDb());
    const indexer = getMemoryIndexer(dbPath);
    const canonicalMemory = getCanonicalMemoryService(stateManager, indexer);
    const getSharedStateManager = () => stateManager;
    base = { getSharedStateManager, indexer, getAzureBlob, canonicalMemory };
    depsByPath.set(dbPath, base);
  }
  return base;
}

/** Eagerly initialise shared state (DB dir + schema) before serving. */
export function initMcpState(dbPath: string = PATHS.db): void {
  getSharedDeps(dbPath);
}

// ── Result size budgeting ────────────────────────────────────────────────────
const RESULT_SIZE_BUDGET = {
  maxCharsPerResult: 100_000,
  previewSize: 1_500,
  // memory_search needs no exemption: mode='fetch' self-caps at 96 KB, under maxCharsPerResult.
  exempt: new Set(["memory_context"]),
};

function applyResultBudget(
  toolName: string,
  result: { content: Array<{ type: string; text?: string }> }
): typeof result {
  if (RESULT_SIZE_BUDGET.exempt.has(toolName)) return result;
  for (const item of result.content) {
    if (item && item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > RESULT_SIZE_BUDGET.maxCharsPerResult) {
      const originalLength = item.text.length;
      const preview = item.text.slice(0, RESULT_SIZE_BUDGET.previewSize);
      (item as { type: string; text: string }).text = `${preview}\n\n--- TRUNCATED (${Math.round(originalLength / 1024)}KB → ${Math.round(RESULT_SIZE_BUDGET.previewSize / 1024)}KB) ---\nFull result exceeded ${Math.round(RESULT_SIZE_BUDGET.maxCharsPerResult / 1024)}KB budget. Use more specific queries or filters to reduce result size.`;
    }
  }
  return result;
}

/**
 * Build an MCP Server wired to the shared Homer tool modules. Cheap to call —
 * only the lightweight Server object is created; the DB/indexer deps are shared
 * singletons.
 */
export function createHomerMcpServer(options: HomerMcpServerOptions = {}): Server {
  const deps = getSharedDeps(options.dbPath ?? PATHS.db);

  const server = new Server(
    { name: options.name ?? "homer-memory", version: options.version ?? "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolModules.flatMap(m => m.definitions),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      for (const mod of toolModules) {
        const result = await mod.handle(name, (args ?? {}) as Record<string, unknown>, deps);
        if (result !== null) return applyResultBudget(name, result);
      }
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  });

  return server;
}
