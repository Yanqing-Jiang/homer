#!/usr/bin/env tsx

/**
 * Migrate legacy plan markdown files to YAML frontmatter format
 *
 * Usage: npx tsx scripts/migrate-plans.ts [--dry-run]
 *
 * Notes:
 * - Preserves the full body content (only strips legacy header lines)
 * - Creates a .bak backup for each migrated file
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "fs";
import { join, basename } from "path";
import YAML from "yaml";

const MEMORY_PATH = process.env.MEMORY_PATH ?? "/Users/yj/memory";
const PLANS_DIR = join(MEMORY_PATH, "plans");

const dryRun = process.argv.includes("--dry-run");

function hasFrontmatter(content: string): boolean {
  return /^---\n/.test(content);
}

function extractLegacyHeader(content: string): { title: string | null; meta: Record<string, string>; body: string } {
  const lines = content.split("\n");
  let idx = 0;
  let title: string | null = null;

  if (lines[idx]?.startsWith("# ")) {
    title = lines[idx]?.slice(2).trim() ?? null;
    idx += 1;
  }

  const meta: Record<string, string> = {};
  while (idx < lines.length) {
    const line = lines[idx] ?? "";
    const match = line.match(/^\*\*(.+?):\*\*\s*(.*)$/);
    if (!match) break;
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    meta[key] = value;
    idx += 1;
  }

  while (idx < lines.length && (lines[idx]?.trim() ?? "") === "") {
    idx += 1;
  }

  const body = lines.slice(idx).join("\n");
  return { title, meta, body };
}

function toFrontmatter(
  filePath: string,
  title: string | null,
  meta: Record<string, string>,
  body: string
): string {
  const id = basename(filePath, ".md");
  const status = meta["status"] || "planning";
  const currentPhase = meta["current phase"] || "";
  const created = meta["created"] || "";
  const updated = meta["updated"] || "";

  const frontmatter: Record<string, unknown> = {
    id,
    title: title || id,
    status,
  };

  if (currentPhase) frontmatter.current_phase = currentPhase;
  if (created) frontmatter.created = created;
  if (updated) frontmatter.updated = updated;

  const yaml = YAML.stringify(frontmatter).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trimStart()}\n`;
}

function migrateFile(filePath: string): boolean {
  const content = readFileSync(filePath, "utf-8");

  if (hasFrontmatter(content)) {
    console.log(`↷ Skipping (already migrated): ${filePath}`);
    return false;
  }

  const { title, meta, body } = extractLegacyHeader(content);
  const newContent = toFrontmatter(filePath, title, meta, body);

  if (dryRun) {
    console.log(`• Would migrate: ${filePath}`);
    return false;
  }

  const backupPath = `${filePath}.bak`;
  if (!existsSync(backupPath)) {
    copyFileSync(filePath, backupPath);
  }

  writeFileSync(filePath, newContent, "utf-8");
  console.log(`✓ Migrated: ${filePath}`);
  return true;
}

function migrate(): void {
  console.log("Plans Migration Script");
  console.log("======================");
  console.log();

  if (dryRun) {
    console.log("🔍 DRY RUN MODE - No files will be modified\n");
  }

  if (!existsSync(PLANS_DIR)) {
    console.error(`❌ Plans directory not found: ${PLANS_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(PLANS_DIR).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    console.log("No plan files found.");
    return;
  }

  let migrated = 0;
  for (const file of files) {
    const filePath = join(PLANS_DIR, file);
    if (migrateFile(filePath)) {
      migrated++;
    }
  }

  console.log();
  console.log(`Done. Migrated ${migrated} file(s).`);
}

migrate();
