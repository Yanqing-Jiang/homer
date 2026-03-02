/**
 * Ideas DAO — centralized CRUD for the ideas table.
 *
 * Single module for ALL idea read/write operations.
 * SQLite is source of truth. .md files are write-through mirrors.
 * Every write function calls writeMirrorFile() as fire-and-forget.
 */

import type Database from "better-sqlite3";
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { formatIdeaFile, type ParsedIdea } from "./parser.js";
import { canonicalizeUrl } from "./canonical-url.js";
import { createFingerprint } from "./fingerprint.js";
import { logger } from "../utils/logger.js";
import { PATHS } from "../config/paths.js";

const IDEAS_DIR = PATHS.ideas;

// ============================================
// Types
// ============================================

export interface IdeaRow {
  id: string;
  title: string;
  status: string;
  source: string | null;
  tags: string | null;           // JSON array
  raw_content: string | null;
  link: string | null;
  canonical_url: string | null;
  notes: string | null;
  context: string | null;
  exploration: string | null;
  fingerprint: string | null;
  linked_exploration_thread_id: string | null;
  linked_plan_id: string | null;
  file_path: string | null;
  content_hash: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface IdeaFilter {
  status?: string;
  source?: string;
  limit?: number;
}

export interface SearchResult {
  id: string;
  title: string;
  status: string;
  source: string | null;
  link: string | null;
  created_at: string | null;
  content: string;   // snippet from FTS
  rank: number;
}

// ============================================
// Conversion helpers
// ============================================

/** Convert DB row → ParsedIdea (the format all existing callers expect) */
export function rowToIdea(row: IdeaRow): ParsedIdea {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    source: row.source ?? "",
    content: row.raw_content ?? "",
    context: row.context ?? undefined,
    link: row.link ?? undefined,
    notes: row.notes ?? undefined,
    exploration: row.exploration ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : [],
    timestamp: row.created_at ?? new Date().toISOString(),
    filePath: row.file_path ?? undefined,
    contentHash: row.content_hash ?? undefined,
    linkedExplorationThreadId: row.linked_exploration_thread_id ?? undefined,
    linkedPlanId: row.linked_plan_id ?? undefined,
  };
}

/** Convert ParsedIdea → partial DB columns for INSERT/UPDATE */
function ideaToRow(idea: ParsedIdea): Omit<IdeaRow, "updated_at"> {
  const tags = idea.tags?.length ? JSON.stringify(idea.tags) : null;
  const canonical = idea.link ? canonicalizeUrl(idea.link).canonical || null : null;
  const fp = createFingerprint(idea.title);
  const filePath = idea.filePath ?? mirrorPath(idea.id);
  const contentStr = formatIdeaFile(idea);
  const hash = createHash("md5").update(contentStr).digest("hex");

  return {
    id: idea.id,
    title: idea.title,
    status: idea.status,
    source: idea.source || null,
    tags,
    raw_content: idea.content || null,
    link: idea.link || null,
    canonical_url: canonical,
    notes: idea.notes || null,
    context: idea.context || null,
    exploration: idea.exploration || null,
    fingerprint: fp.hash || null,
    linked_exploration_thread_id: idea.linkedExplorationThreadId || null,
    linked_plan_id: idea.linkedPlanId || null,
    file_path: filePath,
    content_hash: hash,
    created_at: idea.timestamp || new Date().toISOString(),
  };
}

// ============================================
// Mirror file helpers
// ============================================

function mirrorPath(id: string): string {
  const fileName = id.startsWith("idea_") ? `${id}.md` : `idea_${id}.md`;
  return join(IDEAS_DIR, fileName);
}

function writeMirrorFile(idea: ParsedIdea): void {
  try {
    if (!existsSync(IDEAS_DIR)) {
      mkdirSync(IDEAS_DIR, { recursive: true });
    }
    const content = formatIdeaFile(idea);
    writeFileSync(idea.filePath ?? mirrorPath(idea.id), content, "utf-8");
  } catch (e) {
    logger.warn({ id: idea.id, error: e }, "Mirror write failed (non-fatal)");
  }
}

function deleteMirrorFile(filePath: string | null): void {
  if (!filePath) return;
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (e) {
    logger.warn({ filePath, error: e }, "Mirror delete failed (non-fatal)");
  }
}

// ============================================
// DAO Functions
// ============================================

/**
 * Get a single idea by ID (exact or prefix match).
 */
export function getIdea(db: Database.Database, id: string): ParsedIdea | null {
  // Try exact match first
  let row = db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as IdeaRow | undefined;

  // Try prefix match
  if (!row) {
    row = db.prepare("SELECT * FROM ideas WHERE id LIKE ? LIMIT 1").get(`${id}%`) as IdeaRow | undefined;
  }

  return row ? rowToIdea(row) : null;
}

/**
 * Get all ideas, optionally filtered by status/source.
 */
export function getAllIdeas(db: Database.Database, filter?: IdeaFilter): ParsedIdea[] {
  let query = "SELECT * FROM ideas WHERE 1=1";
  const params: (string | number)[] = [];

  if (filter?.status) {
    query += " AND status = ?";
    params.push(filter.status);
  }
  if (filter?.source) {
    query += " AND source = ?";
    params.push(filter.source);
  }

  query += " ORDER BY created_at DESC";

  if (filter?.limit) {
    query += " LIMIT ?";
    params.push(filter.limit);
  }

  const rows = db.prepare(query).all(...params) as IdeaRow[];
  return rows.map(rowToIdea);
}

/**
 * Create a new idea. Returns the saved ParsedIdea.
 */
export function createIdea(db: Database.Database, idea: ParsedIdea): ParsedIdea {
  const row = ideaToRow(idea);

  // Atomic: ideas + idea_index in one transaction
  db.transaction(() => {
    db.prepare(`
      INSERT INTO ideas (
        id, title, status, source, tags, raw_content, link, canonical_url,
        notes, context, exploration, fingerprint,
        linked_exploration_thread_id, linked_plan_id,
        file_path, content_hash, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, datetime('now')
      )
    `).run(
      row.id, row.title, row.status, row.source, row.tags, row.raw_content,
      row.link, row.canonical_url,
      row.notes, row.context, row.exploration, row.fingerprint,
      row.linked_exploration_thread_id, row.linked_plan_id,
      row.file_path, row.content_hash, row.created_at,
    );

    // Sync to idea_index for backward compat (Web UI still uses IdeasIndexer)
    syncToIdeaIndex(db, row);
  })();

  // Mirror file write is post-commit best-effort
  const saved = { ...idea, filePath: row.file_path ?? undefined, contentHash: row.content_hash ?? undefined };
  writeMirrorFile(saved);

  return saved;
}

/**
 * Update specific fields on an idea. Only non-undefined fields are updated.
 */
export function updateIdea(
  db: Database.Database,
  id: string,
  fields: Partial<Pick<ParsedIdea, "title" | "status" | "content" | "context" | "notes" | "exploration" | "link" | "tags" | "linkedExplorationThreadId" | "linkedPlanId">>
): ParsedIdea | null {
  const existing = getIdea(db, id);
  if (!existing) return null;

  // Merge fields
  const merged = { ...existing };
  if (fields.title !== undefined) merged.title = fields.title;
  if (fields.status !== undefined) merged.status = fields.status;
  if (fields.content !== undefined) merged.content = fields.content;
  if (fields.context !== undefined) merged.context = fields.context;
  if (fields.notes !== undefined) merged.notes = fields.notes;
  if (fields.exploration !== undefined) merged.exploration = fields.exploration;
  if (fields.link !== undefined) merged.link = fields.link;
  if (fields.tags !== undefined) merged.tags = fields.tags;
  if (fields.linkedExplorationThreadId !== undefined) merged.linkedExplorationThreadId = fields.linkedExplorationThreadId;
  if (fields.linkedPlanId !== undefined) merged.linkedPlanId = fields.linkedPlanId;

  const row = ideaToRow(merged);

  // Atomic: ideas + idea_index in one transaction
  db.transaction(() => {
    db.prepare(`
      UPDATE ideas SET
        title = ?, status = ?, source = ?, tags = ?, raw_content = ?,
        link = ?, canonical_url = ?, notes = ?, context = ?, exploration = ?,
        fingerprint = ?, linked_exploration_thread_id = ?, linked_plan_id = ?,
        file_path = ?, content_hash = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      row.title, row.status, row.source, row.tags, row.raw_content,
      row.link, row.canonical_url, row.notes, row.context, row.exploration,
      row.fingerprint, row.linked_exploration_thread_id, row.linked_plan_id,
      row.file_path, row.content_hash, existing.id,
    );

    syncToIdeaIndex(db, { ...row, id: existing.id });
  })();

  // Mirror file write is post-commit best-effort
  const saved = { ...merged, filePath: row.file_path ?? undefined, contentHash: row.content_hash ?? undefined };
  writeMirrorFile(saved);

  return saved;
}

/**
 * Append a timestamped note to an idea.
 * Uses atomic SQL concatenation to avoid lost updates from concurrent appends.
 */
export function appendNote(db: Database.Database, id: string, note: string): ParsedIdea | null {
  const existing = getIdea(db, id);
  if (!existing) return null;

  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const newNote = `- [${timestamp}] ${note}`;

  // Atomic append — avoids read-modify-write race
  db.prepare(`
    UPDATE ideas SET
      notes = CASE WHEN notes IS NOT NULL AND notes != '' THEN notes || char(10) || ? ELSE ? END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(newNote, newNote, existing.id);

  // Re-read and sync
  const updated = getIdea(db, existing.id);
  if (updated) {
    syncToIdeaIndex(db, ideaToRow(updated));
    writeMirrorFile(updated);
  }
  return updated;
}

/**
 * Append exploration notes to an idea.
 */
export function appendExplorationNotes(db: Database.Database, id: string, notes: string): ParsedIdea | null {
  const existing = getIdea(db, id);
  if (!existing) return null;

  const dateStr = new Date().toISOString().split("T")[0];
  const entry = `### ${dateStr}\n${notes}`;
  const exploration = existing.exploration
    ? `${existing.exploration}\n\n${entry}`
    : entry;

  return updateIdea(db, existing.id, { exploration });
}

/**
 * Delete an idea from DB and mirror file.
 */
export function deleteIdea(db: Database.Database, id: string): boolean {
  const existing = getIdea(db, id);
  if (!existing) return false;

  // Atomic: ideas + idea_index in one transaction
  db.transaction(() => {
    db.prepare("DELETE FROM ideas WHERE id = ?").run(existing.id);
    try {
      db.prepare("DELETE FROM idea_index WHERE id = ?").run(existing.id);
    } catch { /* idea_index may not exist */ }
  })();

  // Mirror file delete is post-commit best-effort
  deleteMirrorFile(existing.filePath ?? null);
  return true;
}

/**
 * FTS5 search across ideas.
 */
export function searchIdeas(db: Database.Database, query: string, maxResults: number = 10): SearchResult[] {
  const escapedTerms = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[*()":^$]/g, ""))
    .filter(Boolean)
    .join(" OR ");

  if (!escapedTerms) return [];

  try {
    return db.prepare(`
      SELECT i.id, i.title, i.status, i.source, i.link, i.created_at,
             snippet(ideas_fts, 1, '>>>', '<<<', '...', 50) as content,
             bm25(ideas_fts) as rank
      FROM ideas_fts fts
      JOIN ideas i ON fts.rowid = i.rowid
      WHERE ideas_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(escapedTerms, maxResults) as SearchResult[];
  } catch (err) {
    logger.debug({ error: err, query }, "Ideas FTS search failed");
    return [];
  }
}

/**
 * Upsert by canonical URL — used by smartSaveIdea for URL-based dedup.
 * Returns existing idea if URL matches, null otherwise.
 */
export function findByCanonicalUrl(db: Database.Database, url: string): ParsedIdea | null {
  const canonical = canonicalizeUrl(url).canonical;
  if (!canonical) return null;

  const row = db.prepare(
    "SELECT * FROM ideas WHERE canonical_url = ?"
  ).get(canonical) as IdeaRow | undefined;

  return row ? rowToIdea(row) : null;
}

/**
 * Get all ideas as IdeaRow (raw DB format, for callers that need it).
 */
export function getAllIdeaRows(db: Database.Database, filter?: IdeaFilter): IdeaRow[] {
  let query = "SELECT * FROM ideas WHERE 1=1";
  const params: (string | number)[] = [];

  if (filter?.status) {
    query += " AND status = ?";
    params.push(filter.status);
  }

  query += " ORDER BY created_at DESC";

  if (filter?.limit) {
    query += " LIMIT ?";
    params.push(filter.limit);
  }

  return db.prepare(query).all(...params) as IdeaRow[];
}

// ============================================
// Backward compat: sync to idea_index
// ============================================

function syncToIdeaIndex(db: Database.Database, row: Omit<IdeaRow, "updated_at">): void {
  try {
    db.prepare(`
      INSERT INTO idea_index (id, title, status, source, tags, linked_thread_id, linked_plan_id, file_path, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        source = excluded.source,
        tags = excluded.tags,
        linked_thread_id = excluded.linked_thread_id,
        linked_plan_id = excluded.linked_plan_id,
        file_path = excluded.file_path,
        content_hash = excluded.content_hash,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      row.id, row.title, row.status, row.source, row.tags,
      row.linked_exploration_thread_id, row.linked_plan_id,
      row.file_path, row.content_hash, row.created_at,
    );
  } catch {
    // idea_index table may not exist or have different schema — non-fatal
  }
}
