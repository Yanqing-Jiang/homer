import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";

/**
 * Memory file locations
 */
const GLOBAL_MEMORY_FILES = [
  "/Users/yj/memory/user.md",
  "/Users/yj/memory/facts.md",
  "/Users/yj/memory/preferences.md",
];

const CONTEXT_MEMORY_FILES: Record<string, string[]> = {
  work: ["/Users/yj/work/memory.md"],
  life: ["/Users/yj/life/memory.md"],
  default: [],
};

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
 * Load all bootstrap files for a given context
 * @param context - The context (work/life/default)
 * @param cwd - Optional working directory for project-specific context
 * Returns formatted context string or null if no files found
 */
export async function loadBootstrapFiles(
  context: string,
  cwd?: string
): Promise<string | null> {
  const sections: string[] = [];

  // Load global memory files first
  for (const path of GLOBAL_MEMORY_FILES) {
    const content = await loadMemoryFile(path);
    if (content) {
      const filename = path.split("/").pop() || path;
      sections.push(`## ${filename}\n${content}`);
    }
  }

  // Load context-specific memory files
  const contextFiles = CONTEXT_MEMORY_FILES[context] || [];
  for (const path of contextFiles) {
    const content = await loadMemoryFile(path);
    if (content) {
      const filename = path.split("/").pop() || path;
      sections.push(`## ${context}/${filename}\n${content}`);
    }
  }

  // Load project-specific CLAUDE.md if cwd is provided
  if (cwd) {
    const projectContext = await loadProjectContext(cwd);
    if (projectContext) {
      sections.push(projectContext);
    }
  }

  if (sections.length === 0) {
    return null;
  }

  // Format as bootstrap context
  const combined = sections.join("\n\n---\n\n");
  return `# Memory Context\n\n${combined}`;
}

/**
 * Get a list of all memory files that would be loaded for a context
 */
export function getMemoryFilePaths(context: string): string[] {
  const contextFiles = CONTEXT_MEMORY_FILES[context] || [];
  return [...GLOBAL_MEMORY_FILES, ...contextFiles];
}
