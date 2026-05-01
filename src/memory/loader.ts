import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";
import { PATHS } from "../config/paths.js";
import { ensureSessionBootstrap } from "./session-bootstrap.js";

/**
 * Session bootstrap: a tiny generated file (~1.5 KB) that names current top
 * priorities and paused items. Replaces broad injection of me.md + work.md +
 * preferences.md (~22 KB) at session start. The full memory files remain
 * available on demand via memory_read / memory_search.
 *
 * See ~/homer/src/memory/session-bootstrap.ts for the parser/generator.
 */
const MEMORY_FILES = [PATHS.sessionBootstrap];

/**
 * Load a single memory file if it exists
 */
export async function loadMemoryFile(path: string): Promise<string | null> {
  if (!existsSync(path)) {
    logger.debug({ path }, "Memory file does not exist");
    return null;
  }

  try {
    const content = await readFile(path, "utf-8");
    if (content.trim()) {
      logger.debug({ path, length: content.length }, "Loaded memory file");
      return content.trim();
    }
    return null;
  } catch (error) {
    logger.warn({ path, error }, "Failed to read memory file");
    return null;
  }
}

/**
 * Load project-specific CLAUDE.md from {cwd}/.claude/CLAUDE.md
 */
export async function loadProjectContext(cwd: string): Promise<string | null> {
  const projectClaudeMd = join(cwd, ".claude", "CLAUDE.md");
  const content = await loadMemoryFile(projectClaudeMd);

  if (content) {
    logger.debug({ path: projectClaudeMd, length: content.length }, "Loaded project CLAUDE.md");
    return `## Project Instructions\n${content}`;
  }

  return null;
}

/**
 * Load all bootstrap memory files
 * Called at session start to give Claude context. Best-effort regenerates the
 * session-bootstrap projection first; on regen failure, falls back to:
 *   1. the existing session-bootstrap.md (stale but usable)
 *   2. ~/memory/emergency-bootstrap.md (the documented MCP-down recovery card)
 *   3. null (caller decides — typically means "no bootstrap context this session")
 */
export async function loadBootstrapFiles(): Promise<string | null> {
  await ensureSessionBootstrap();

  // Tier 1: the generated bootstrap.
  for (const path of MEMORY_FILES) {
    const content = await loadMemoryFile(path);
    if (content) return content;
  }

  // Tier 2 fallback: the hand-maintained emergency card. Present whenever the
  // generator has never run (fresh install) or the generated file was deleted.
  const emergency = `${PATHS.memory}/emergency-bootstrap.md`;
  const fallback = await loadMemoryFile(emergency);
  if (fallback) {
    logger.warn({ emergency }, "loadBootstrapFiles: session-bootstrap missing; using emergency-bootstrap.md");
    return fallback;
  }

  return null;
}

/**
 * Get list of memory file paths
 */
export function getMemoryFilePaths(): string[] {
  return MEMORY_FILES;
}
