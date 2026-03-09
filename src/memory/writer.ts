import { logger } from "../utils/logger.js";
import type { StateManager } from "../state/manager.js";
import { memoryEvents } from "../events/memory-events.js";

// Module-level reference, wired at startup via setWriterStateManager()
let stateManagerRef: StateManager | null = null;

export function setWriterStateManager(sm: StateManager): void {
  stateManagerRef = sm;
}

/**
 * Map target to a project label for session_summaries
 */
function targetToProject(target: string): string {
  switch (target) {
    case "work":
      return "work";
    case "life":
      return "life";
    case "global":
    case "default":
    default:
      return "general";
  }
}

/**
 * Write memory update to session_summaries via stateManager.insertDaemonEvent.
 * Replaces the old appendDailyLog path — data now flows through the same
 * pipeline as session-harvester output.
 */
async function appendToMemoryFile(target: string, content: string): Promise<void> {
  const project = targetToProject(target);

  if (!stateManagerRef) {
    logger.warn({ target }, "Writer stateManager not wired — memory update dropped");
    return;
  }

  try {
    stateManagerRef.insertDaemonEvent(
      `memory-update [${project}]`,
      content,
      project,
    );
    stateManagerRef.markPipelineDirty("embeddings", "writer");
    memoryEvents.emitDirty("embeddings", "writer");
    logger.info({ target, project, contentLength: content.length }, "Memory update written to session_summaries");
  } catch (error) {
    logger.error({ error, target }, "Failed to write memory update to session_summaries");
    throw error;
  }
}

export interface MemoryUpdateResult {
  cleanedResponse: string;
  updatesWritten: number;
  targets: string[];
}

/**
 * Parse and process memory update tags from Claude response
 *
 * Tags format:
 * <memory-update>content</memory-update>           - writes to context memory
 * <memory-update target="work">content</memory-update>  - writes to work memory
 * <memory-update target="life">content</memory-update>  - writes to life memory
 * <memory-update target="global">content</memory-update> - writes to global memory
 */
export async function processMemoryUpdates(
  response: string,
  context: string
): Promise<MemoryUpdateResult> {
  const regex = /<memory-update(?:\s+target="(work|life|global)")?>([\s\S]*?)<\/memory-update>/g;
  let match;
  let updatesWritten = 0;
  let cleanedResponse = response;
  const targets: string[] = [];

  // Collect all matches first to avoid regex state issues
  const matches: Array<{ full: string; target: string; content: string }> = [];
  while ((match = regex.exec(response)) !== null) {
    const content = match[2];
    matches.push({
      full: match[0],
      target: match[1] || context,
      content: content ? content.trim() : "",
    });
  }

  // Process each match
  for (const m of matches) {
    if (m.content) {
      try {
        await appendToMemoryFile(m.target, m.content);
        updatesWritten++;
        targets.push(m.target);
      } catch {
        // Error already logged in appendToMemoryFile
      }
    }
    // Remove the tag from the response
    cleanedResponse = cleanedResponse.replace(m.full, "");
  }

  // Clean up any extra whitespace from removed tags
  cleanedResponse = cleanedResponse.replace(/\n{3,}/g, "\n\n").trim();

  return {
    cleanedResponse,
    updatesWritten,
    targets,
  };
}
