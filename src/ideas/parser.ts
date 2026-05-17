import { existsSync, readdirSync } from "fs";
import { PATHS } from "../config/paths.js";

const IDEAS_FILE = PATHS.ideasMd;
const IDEAS_DIR = PATHS.ideas;

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
  enrichment?: string; // JSON: {deep_dive, deep_links, homer_improvement}
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

