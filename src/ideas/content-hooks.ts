/**
 * Content Hooks DAO — Medium/LinkedIn copywriting patterns.
 *
 * Stores viral hooks, title patterns, and opening structures extracted
 * from trending articles. These serve Yanqing's PICE content engine,
 * NOT the idea pipeline. They are never synthesized into ideas.
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

// ============================================
// Types
// ============================================

export type HookType = "title-pattern" | "opening-hook" | "structure-template";
export type HookStatus = "active" | "used" | "archived";

export interface ContentHook {
  id: string;
  platform: string;
  sourceUrl?: string;
  title?: string;
  hookType: HookType;
  content: string;
  analysis?: string;
  metadata?: Record<string, unknown>;
  status: HookStatus;
  createdAt: string;
  usedAt?: string;
}

interface ContentHookRow {
  id: string;
  platform: string;
  source_url: string | null;
  title: string | null;
  hook_type: string;
  content: string;
  analysis: string | null;
  metadata: string | null;
  status: string;
  created_at: string;
  used_at: string | null;
}

// ============================================
// Helpers
// ============================================

function rowToHook(row: ContentHookRow): ContentHook {
  return {
    id: row.id,
    platform: row.platform,
    sourceUrl: row.source_url ?? undefined,
    title: row.title ?? undefined,
    hookType: row.hook_type as HookType,
    content: row.content,
    analysis: row.analysis ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    status: row.status as HookStatus,
    createdAt: row.created_at,
    usedAt: row.used_at ?? undefined,
  };
}

// ============================================
// CRUD
// ============================================

export function createHook(
  db: Database.Database,
  hook: {
    id: string;
    platform: string;
    sourceUrl?: string;
    title?: string;
    hookType: HookType;
    content: string;
    analysis?: string;
    metadata?: Record<string, unknown>;
  },
): ContentHook | null {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO content_hooks
        (id, platform, source_url, title, hook_type, content, analysis, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      hook.id,
      hook.platform,
      hook.sourceUrl ?? null,
      hook.title ?? null,
      hook.hookType,
      hook.content,
      hook.analysis ?? null,
      hook.metadata ? JSON.stringify(hook.metadata) : null,
    );
    return getHook(db, hook.id);
  } catch (e) {
    logger.warn({ id: hook.id, error: e }, "Failed to create content hook");
    return null;
  }
}

export function getHook(db: Database.Database, id: string): ContentHook | null {
  const row = db.prepare("SELECT * FROM content_hooks WHERE id = ?").get(id) as ContentHookRow | undefined;
  return row ? rowToHook(row) : null;
}

export function getHooks(
  db: Database.Database,
  opts?: {
    platform?: string;
    hookType?: HookType;
    status?: HookStatus;
    limit?: number;
  },
): ContentHook[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.platform) {
    conditions.push("platform = ?");
    params.push(opts.platform);
  }
  if (opts?.hookType) {
    conditions.push("hook_type = ?");
    params.push(opts.hookType);
  }
  if (opts?.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts?.limit ?? 50;

  const rows = db.prepare(
    `SELECT * FROM content_hooks ${where} ORDER BY created_at DESC LIMIT ?`,
  ).all(...params, limit) as ContentHookRow[];

  return rows.map(rowToHook);
}

export function getRecentHooks(
  db: Database.Database,
  platform?: string,
  limit = 10,
): ContentHook[] {
  if (platform) {
    const rows = db.prepare(
      "SELECT * FROM content_hooks WHERE platform = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?",
    ).all(platform, limit) as ContentHookRow[];
    return rows.map(rowToHook);
  }
  const rows = db.prepare(
    "SELECT * FROM content_hooks WHERE status = 'active' ORDER BY created_at DESC LIMIT ?",
  ).all(limit) as ContentHookRow[];
  return rows.map(rowToHook);
}

export function markUsed(db: Database.Database, id: string): void {
  db.prepare(
    "UPDATE content_hooks SET status = 'used', used_at = datetime('now') WHERE id = ?",
  ).run(id);
}

export function archiveHook(db: Database.Database, id: string): void {
  db.prepare(
    "UPDATE content_hooks SET status = 'archived' WHERE id = ?",
  ).run(id);
}

// ============================================
// Extraction — called from content-scraper
// ============================================

interface ScrapedPost {
  title: string;
  content: string;
  link?: string;
  author?: string;
  topic?: string;
  first_paragraph?: string;
  hook_analysis?: string;
  claps?: number | null;
}

/**
 * Extract and store content hooks from a scraped Medium/LinkedIn post.
 * Creates 1-2 hooks per post (title pattern + opening hook).
 * No LLM call — uses fields already extracted by the scraper.
 */
export function extractAndStoreHooks(
  db: Database.Database,
  post: ScrapedPost,
  platform: string,
): number {
  const slug = (post.title ?? "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 30);
  const ts = Date.now();
  let stored = 0;

  // Hook 1: Title pattern
  if (post.title) {
    const created = createHook(db, {
      id: `hook_title_${slug}_${ts}`,
      platform,
      sourceUrl: post.link,
      title: post.title,
      hookType: "title-pattern",
      content: post.title,
      analysis: post.hook_analysis ?? undefined,
      metadata: {
        author: post.author,
        claps: post.claps,
        topic: post.topic,
      },
    });
    if (created) stored++;
  }

  // Hook 2: Opening hook (first paragraph)
  if (post.first_paragraph) {
    const created = createHook(db, {
      id: `hook_open_${slug}_${ts}`,
      platform,
      sourceUrl: post.link,
      title: post.title,
      hookType: "opening-hook",
      content: post.first_paragraph,
      analysis: post.hook_analysis ?? undefined,
      metadata: {
        author: post.author,
        claps: post.claps,
        topic: post.topic,
      },
    });
    if (created) stored++;
  }

  if (stored > 0) {
    logger.info({ platform, title: post.title, hooks: stored }, "Stored content hooks");
  }

  return stored;
}
