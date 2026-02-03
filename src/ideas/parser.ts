import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { logger } from "../utils/logger.js";

const MEMORY_PATH = process.env.MEMORY_PATH ?? "/Users/yj/memory";
const IDEAS_FILE = join(MEMORY_PATH, "ideas.md");
const IDEAS_DIR = join(MEMORY_PATH, "ideas");

export interface ParsedIdea {
  id: string;
  title: string;
  status: string;
  source: string;
  content: string;
  context?: string;
  link?: string;
  notes?: string;
  exploration?: string;
  tags: string[];
  timestamp: string;
  filePath?: string;
  contentHash?: string;
  linkedExplorationThreadId?: string;
  linkedPlanId?: string;
}

/**
 * Parse legacy ideas.md format
 */
export function parseIdeasMd(content: string): ParsedIdea[] {
  const ideas: ParsedIdea[] = [];
  const lines = content.split("\n");

  let currentIdea: Partial<ParsedIdea> | null = null;
  let currentSection = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Section headers (## Draft Ideas, ## Under Review, etc.)
    if (line.startsWith("## ")) {
      currentSection = line.slice(3).trim().toLowerCase();
      continue;
    }

    // Idea header: ### [2026-01-29 16:15] Title
    const ideaMatch = line.match(/^### \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (.+)$/);
    if (ideaMatch) {
      // Save previous idea if exists
      if (currentIdea?.id) {
        ideas.push(currentIdea as ParsedIdea);
      }

      const timestamp = ideaMatch[1] ?? "";
      const title = ideaMatch[2] ?? "";
      currentIdea = {
        id: "",
        title,
        timestamp,
        status: sectionToStatus(currentSection),
        source: "",
        content: "",
        tags: [],
      };
      continue;
    }

    if (!currentIdea) continue;

    // Parse metadata fields
    const fieldMatch = line.match(/^- \*\*(\w+):\*\* (.+)$/);
    if (fieldMatch) {
      const field = fieldMatch[1] ?? "";
      const value = fieldMatch[2] ?? "";
      switch (field.toLowerCase()) {
        case "id":
          currentIdea.id = value;
          break;
        case "source":
          currentIdea.source = value;
          break;
        case "status":
          currentIdea.status = value;
          break;
        case "content":
          currentIdea.content = value;
          break;
        case "context":
          currentIdea.context = value;
          break;
        case "link":
          currentIdea.link = value;
          break;
        case "notes":
          // Notes can span multiple lines, handle continuation
          currentIdea.notes = value;
          // Check for semicolon-separated notes
          if (value.includes(";")) {
            currentIdea.notes = value.split(";").map((n) => n.trim()).join("\n");
          }
          break;
      }
    }
  }

  // Don't forget the last idea
  if (currentIdea?.id) {
    ideas.push(currentIdea as ParsedIdea);
  }

  return ideas;
}

function sectionToStatus(section: string): string {
  if (section.includes("draft")) return "draft";
  if (section.includes("review")) return "review";
  if (section.includes("archived")) return "archived";
  return "draft";
}

/**
 * Parse YAML frontmatter format (new format)
 */
export function parseIdeaFile(filePath: string): ParsedIdea | null {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf-8");
  const hash = createHash("md5").update(content).digest("hex");

  // Parse YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    logger.warn({ filePath }, "Invalid idea file format (no frontmatter)");
    return null;
  }

  const frontmatter = frontmatterMatch[1] ?? "";
  const body = frontmatterMatch[2] ?? "";
  const idea: Partial<ParsedIdea> = {
    filePath,
    contentHash: hash,
    tags: [],
  };

  // Parse YAML (simple line-by-line)
  for (const yamlLine of frontmatter.split("\n")) {
    const match = yamlLine.match(/^(\w+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1] ?? "";
    const value = match[2] ?? "";
    switch (key.toLowerCase()) {
      case "id":
        idea.id = value;
        break;
      case "title":
        idea.title = value;
        break;
      case "status":
        idea.status = value;
        break;
      case "source":
        idea.source = value;
        break;
      case "created":
        idea.timestamp = value;
        break;
      case "tags":
        // Parse YAML array [tag1, tag2]
        const tagMatch = value.match(/\[([^\]]*)\]/);
        if (tagMatch && tagMatch[1]) {
          idea.tags = tagMatch[1].split(",").map((t) => t.trim());
        }
        break;
      case "link":
        idea.link = value;
        break;
      case "linkedexplorationthreadid":
        idea.linkedExplorationThreadId = value;
        break;
      case "linkedplanid":
        idea.linkedPlanId = value;
        break;
    }
  }

  // Body is the content
  idea.content = body.trim();

  // Extract context if present (after "## Context")
  const contextMatch = body.match(/## Context\n([\s\S]*?)(?=\n## |$)/);
  if (contextMatch && contextMatch[1]) {
    idea.context = contextMatch[1].trim();
  }

  // Extract notes if present (after "## Notes")
  const notesMatch = body.match(/## Notes\n([\s\S]*?)(?=\n## |$)/);
  if (notesMatch && notesMatch[1]) {
    idea.notes = notesMatch[1].trim();
  }

  // Extract exploration notes if present (after "## Exploration")
  const explorationMatch = body.match(/## Exploration\n([\s\S]*?)(?=\n## |$)/);
  if (explorationMatch && explorationMatch[1]) {
    idea.exploration = explorationMatch[1].trim();
  }

  if (!idea.id || !idea.title) {
    logger.warn({ filePath }, "Idea file missing required fields");
    return null;
  }

  return idea as ParsedIdea;
}

/**
 * Format idea as YAML frontmatter file
 */
export function formatIdeaFile(idea: ParsedIdea): string {
  const tags = idea.tags?.length ? `[${idea.tags.join(", ")}]` : "[]";

  let frontmatter = `---
id: ${idea.id}
title: ${idea.title}
status: ${idea.status}
source: ${idea.source}
created: ${idea.timestamp}
tags: ${tags}`;

  if (idea.link) {
    frontmatter += `\nlink: ${idea.link}`;
  }
  if (idea.linkedExplorationThreadId) {
    frontmatter += `\nlinkedExplorationThreadId: ${idea.linkedExplorationThreadId}`;
  }
  if (idea.linkedPlanId) {
    frontmatter += `\nlinkedPlanId: ${idea.linkedPlanId}`;
  }

  frontmatter += `\n---`;

  let content = `${frontmatter}

${idea.content}
`;

  if (idea.context) {
    content += `\n## Context\n\n${idea.context}\n`;
  }

  if (idea.notes) {
    content += `\n## Notes\n\n${idea.notes}\n`;
  }

  if (idea.exploration) {
    content += `\n## Exploration\n\n${idea.exploration}\n`;
  }

  return content;
}

/**
 * Load all ideas from the ideas directory
 */
export function loadIdeasFromDir(): ParsedIdea[] {
  if (!existsSync(IDEAS_DIR)) {
    return [];
  }

  const files = readdirSync(IDEAS_DIR).filter((f) => f.endsWith(".md"));
  const ideas: ParsedIdea[] = [];

  for (const file of files) {
    const idea = parseIdeaFile(join(IDEAS_DIR, file));
    if (idea) {
      ideas.push(idea);
    }
  }

  return ideas.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Save an idea to a file
 */
export function saveIdeaFile(idea: ParsedIdea): string {
  if (!existsSync(IDEAS_DIR)) {
    mkdirSync(IDEAS_DIR, { recursive: true });
  }

  const fileName = `idea_${idea.id}.md`;
  const filePath = join(IDEAS_DIR, fileName);
  const content = formatIdeaFile(idea);

  writeFileSync(filePath, content, "utf-8");
  logger.debug({ id: idea.id, filePath }, "Saved idea file");

  return filePath;
}

/**
 * Check if ideas have been migrated to individual files
 */
export function isIdeasMigrated(): boolean {
  return existsSync(IDEAS_DIR) && readdirSync(IDEAS_DIR).filter((f) => f.endsWith(".md")).length > 0;
}

/**
 * Get paths for ideas system
 */
export function getIdeasPaths(): { legacyFile: string; directory: string } {
  return {
    legacyFile: IDEAS_FILE,
    directory: IDEAS_DIR,
  };
}

/**
 * Append exploration notes to an idea file
 */
export function appendExploration(filePath: string, notes: string): boolean {
  if (!existsSync(filePath)) return false;

  const idea = parseIdeaFile(filePath);
  if (!idea) return false;

  // Format exploration entry with date
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const entry = `### ${dateStr}\n${notes}`;

  // Append to existing exploration or create new section
  if (idea.exploration) {
    idea.exploration = `${idea.exploration}\n\n${entry}`;
  } else {
    idea.exploration = entry;
  }

  // Save updated idea
  const content = formatIdeaFile(idea);
  writeFileSync(filePath, content, "utf-8");
  logger.debug({ filePath }, "Appended exploration notes to idea");

  return true;
}
