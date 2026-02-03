import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";

const HOME = process.env.HOME || "/Users/yj";

/**
 * Core memory files to load at session start
 * Claude reads these to understand who it is and the user's context
 */
const MEMORY_FILES = [
  join(HOME, "memory/me.md"),
  join(HOME, "memory/work.md"),
  join(HOME, "memory/preferences.md"),
];

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
 * Called at session start to give Claude context
 */
export async function loadBootstrapFiles(): Promise<string | null> {
  const sections: string[] = [];

  for (const path of MEMORY_FILES) {
    const content = await loadMemoryFile(path);
    if (content) {
      const filename = path.split("/").pop() || path;
      sections.push(`## ${filename}\n${content}`);
    }
  }

  if (sections.length === 0) {
    return null;
  }

  const combined = sections.join("\n\n---\n\n");
  return `# Memory Context\n\n${combined}`;
}

/**
 * Get list of memory file paths
 */
export function getMemoryFilePaths(): string[] {
  return MEMORY_FILES;
}
