#!/usr/bin/env tsx

/**
 * Migrate ideas.md to individual idea files with YAML frontmatter
 *
 * Usage: npx tsx scripts/migrate-ideas.ts [--dry-run]
 *
 * Before running:
 * - The script will backup ideas.md to ideas.md.bak
 *
 * Rollback:
 * - rm -rf ~/memory/ideas && mv ~/memory/ideas.md.bak ~/memory/ideas.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { join } from "path";

const MEMORY_PATH = process.env.MEMORY_PATH ?? "/Users/yj/memory";
const IDEAS_FILE = join(MEMORY_PATH, "ideas.md");
const IDEAS_BACKUP = join(MEMORY_PATH, "ideas.md.bak");
const IDEAS_DIR = join(MEMORY_PATH, "ideas");

const dryRun = process.argv.includes("--dry-run");

interface ParsedIdea {
  id: string;
  title: string;
  status: string;
  source: string;
  content: string;
  context?: string;
  link?: string;
  notes?: string;
  timestamp: string;
}

function parseIdeasMd(content: string): ParsedIdea[] {
  const ideas: ParsedIdea[] = [];
  const lines = content.split("\n");

  let currentIdea: Partial<ParsedIdea> | null = null;
  let currentSection = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Section headers
    if (line.startsWith("## ")) {
      currentSection = line.slice(3).trim().toLowerCase();
      continue;
    }

    // Idea header: ### [2026-01-29 16:15] Title
    const ideaMatch = line.match(/^### \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (.+)$/);
    if (ideaMatch) {
      if (currentIdea?.id) {
        ideas.push(currentIdea as ParsedIdea);
      }

      const [, timestamp, title] = ideaMatch;
      currentIdea = {
        id: "",
        title,
        timestamp,
        status: sectionToStatus(currentSection),
        source: "",
        content: "",
      };
      continue;
    }

    if (!currentIdea) continue;

    // Parse metadata fields
    const fieldMatch = line.match(/^- \*\*(\w+):\*\* (.+)$/);
    if (fieldMatch) {
      const [, field, value] = fieldMatch;
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
          currentIdea.notes = value;
          if (value.includes(";")) {
            currentIdea.notes = value.split(";").map((n) => n.trim()).join("\n");
          }
          break;
      }
    }
  }

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

function formatIdeaFile(idea: ParsedIdea): string {
  // Use the id as-is (legacy format has 8-char IDs)
  const ideaId = idea.id.startsWith("idea_") ? idea.id : `idea_${idea.id}`;

  let content = `---
id: ${ideaId}
title: ${idea.title}
status: ${idea.status}
source: ${idea.source}
tags: []
created: ${idea.timestamp}
${idea.link ? `link: ${idea.link}` : ""}
---

${idea.content}
`;

  if (idea.context) {
    content += `\n## Context\n\n${idea.context}\n`;
  }

  if (idea.notes) {
    content += `\n## Notes\n\n${idea.notes}\n`;
  }

  return content;
}

function migrate(): void {
  console.log("Ideas Migration Script");
  console.log("======================");
  console.log();

  if (dryRun) {
    console.log("🔍 DRY RUN MODE - No files will be modified\n");
  }

  // Check source file exists
  if (!existsSync(IDEAS_FILE)) {
    console.error(`❌ Source file not found: ${IDEAS_FILE}`);
    process.exit(1);
  }

  // Check if already migrated
  if (existsSync(IDEAS_DIR)) {
    console.log(`⚠️  Ideas directory already exists: ${IDEAS_DIR}`);
    console.log("   If you want to re-migrate, delete the directory first.");
    process.exit(1);
  }

  // Read and parse
  const content = readFileSync(IDEAS_FILE, "utf-8");
  const ideas = parseIdeasMd(content);

  console.log(`📖 Parsed ${ideas.length} ideas from ${IDEAS_FILE}\n`);

  if (ideas.length === 0) {
    console.log("No ideas to migrate.");
    return;
  }

  // Preview
  console.log("Ideas to migrate:");
  for (const idea of ideas) {
    console.log(`  - [${idea.id}] ${idea.title} (${idea.status})`);
  }
  console.log();

  if (dryRun) {
    console.log("🔍 Dry run complete. Run without --dry-run to execute migration.");
    return;
  }

  // Backup
  console.log(`💾 Backing up ${IDEAS_FILE} to ${IDEAS_BACKUP}`);
  copyFileSync(IDEAS_FILE, IDEAS_BACKUP);

  // Create directory
  console.log(`📁 Creating directory ${IDEAS_DIR}`);
  mkdirSync(IDEAS_DIR, { recursive: true });

  // Write individual files
  let migrated = 0;
  const seenIds = new Set<string>();

  for (const idea of ideas) {
    // Handle duplicate IDs by appending suffix
    const baseId = idea.id.startsWith("idea_") ? idea.id : `idea_${idea.id}`;
    let uniqueId = baseId;
    let suffix = 1;
    while (seenIds.has(uniqueId)) {
      uniqueId = `${baseId}_${suffix}`;
      suffix++;
    }
    seenIds.add(uniqueId);

    const fileName = `${uniqueId}.md`;
    const filePath = join(IDEAS_DIR, fileName);
    const fileContent = formatIdeaFile({ ...idea, id: uniqueId });

    writeFileSync(filePath, fileContent, "utf-8");
    console.log(`  ✅ ${fileName}`);
    migrated++;
  }

  console.log();
  console.log(`✨ Migration complete! ${migrated} ideas migrated.`);
  console.log();
  console.log("Next steps:");
  console.log("  1. Verify the migrated files in ~/memory/ideas/");
  console.log("  2. Restart the Homer daemon to pick up the new files");
  console.log("  3. The original ideas.md is backed up at ideas.md.bak");
  console.log();
  console.log("To rollback:");
  console.log("  rm -rf ~/memory/ideas && mv ~/memory/ideas.md.bak ~/memory/ideas.md");
}

migrate();
