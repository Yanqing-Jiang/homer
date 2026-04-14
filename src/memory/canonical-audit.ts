/**
 * Canonical Memory Audit — parser + snapshot + decision writer for weekly audits.
 *
 * Parses ~/memory/*.md into atomic entries (bullets, numbered list items,
 * paragraphs, bold-label paragraphs, tables) with stable IDs and line ranges.
 * Feeds the Sunday weekly review flow in bot/handlers/weekly-memory-audit.ts.
 */

import { createHash } from "crypto";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { PATHS } from "../config/paths.js";
import { logger } from "../utils/logger.js";
// @ts-ignore
import type Database from "better-sqlite3";
import type { StateManager } from "../state/manager.js";
import type { CanonicalMemoryService } from "./canonical-service.js";

// ── Types ──────────────────────────────────────────────────

export type EntryKind = "bullet" | "numbered" | "paragraph" | "label" | "table" | "code";

export interface ParsedEntry {
  fileKey: string;
  relativePath: string;
  sectionPath: string | null;
  kind: EntryKind;
  text: string;
  hash: string;
  lineStart: number;
  lineEnd: number;
  ordinalInFile: number;
}

export interface MemoryEntryRow {
  id: string;
  fileKey: string;
  relativePath: string;
  sectionPath: string | null;
  entryKind: EntryKind;
  entryText: string;
  entryHash: string;
  lineStart: number;
  lineEnd: number;
  ordinalInFile: number;
  createdAt: string;
  updatedAt: string;
  promotedAt: string | null;
  lastReviewedAt: string | null;
  lastRetrievedAt: string | null;
  usageCount: number;
  isActive: number;
}

export interface WeeklyAuditSessionRow {
  id: string;
  weekStart: string;
  status: "active" | "paused" | "completed" | "abandoned";
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  resumeFilePath: string | null;
  resumeEntryOrdinal: number | null;
  resumeAnchorStaleness: number | null;
  resumeAnchorOrdinal: number | null;
  entrySnapshotCount: number;
  sourceMemoryVersion: string;
  telegramSessionRootId: number | null;
}

export interface WeeklyAuditSessionEntryRow {
  id: string;
  sessionId: string;
  memoryEntryId: string;
  fileKey: string;
  filePath: string;
  sectionPath: string | null;
  lineStart: number;
  lineEnd: number;
  entryText: string;
  entryHash: string;
  usageCount: number;
  lastRetrievedAt: string | null;
  promotedAt: string | null;
  ordinalInFile: number;
  stalenessScore: number | null;
  status: "pending" | "kept" | "edited" | "removed" | "stale" | "skipped" | "conflict";
  decisionNote: string | null;
  decidedAt: string | null;
  telegramMessageId: number | null;
}

export interface MemoryEntrySyncResult {
  scannedFiles: number;
  parsedEntries: number;
  inserted: number;
  updated: number;
  deactivated: number;
}

// ── Parser ─────────────────────────────────────────────────

// Phase 0.9: canonical files come from the registry; "extras" are listed
// after them in preferred audit order but aren't part of the canonical set.
import { CANONICAL_FILE_KEYS } from "./registry.js";
const FILES_TO_AUDIT_ORDER = [
  ...CANONICAL_FILE_KEYS.map((k) => `${k}.md`),
  "goals.md",
  "projects.md",
];

/**
 * Canonical memory files to audit, in review order.
 * Returns relative paths like "me.md" or "skills/foo.md".
 */
export async function listAuditableFiles(memoryDir: string = PATHS.memory): Promise<string[]> {
  const entries = await readdir(memoryDir, { withFileTypes: true, recursive: false });
  const rootFiles = entries
    .filter(e => e.isFile() && e.name.endsWith(".md"))
    .map(e => e.name)
    .filter(n => !n.startsWith(".") && n !== "MEMORY.md" && n !== "emergency-bootstrap.md");

  // Apply preferred order: listed files first, remaining alphabetically
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const preferred of FILES_TO_AUDIT_ORDER) {
    if (rootFiles.includes(preferred)) {
      ordered.push(preferred);
      seen.add(preferred);
    }
  }
  for (const f of rootFiles.sort()) {
    if (!seen.has(f)) ordered.push(f);
  }

  return ordered;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function hashEntry(text: string, relativePath: string): string {
  return createHash("sha256").update(normalize(text) + "::" + relativePath).digest("hex");
}

function fileKeyFromPath(relativePath: string): string {
  // 'work.md' -> 'work'; 'skills/foo.md' -> 'skills/foo'
  return relativePath.replace(/\.md$/, "");
}

/**
 * Parse a markdown file into atomic entries.
 *
 * Rules (opinionated v1):
 *   - A bullet line (`- ...` or `* ...`) is one entry.
 *   - A numbered line (`1. ...`) is one entry.
 *   - A standalone paragraph block under a heading is one entry.
 *   - A bold-label paragraph `**Label:** ...` is one entry.
 *   - A markdown table (consecutive `|` lines) is one entry block.
 *   - Fenced code blocks (```) only become entries if under 500 chars.
 *   - Headings themselves are not entries; they set section context.
 *   - HOMER auto-managed blocks (`<!-- HOMER:START -->` to `<!-- HOMER:END -->`) are skipped.
 */
export function parseMarkdownEntries(
  relativePath: string,
  content: string,
): ParsedEntry[] {
  const fileKey = fileKeyFromPath(relativePath);
  const lines = content.split("\n");
  const entries: ParsedEntry[] = [];
  const sectionStack: string[] = [];
  let inHomerBlock = false;
  let inCodeFence = false;
  let codeFenceStart = -1;
  let codeFenceLines: string[] = [];
  let ordinal = 0;

  function pushEntry(partial: Omit<ParsedEntry, "fileKey" | "relativePath" | "hash" | "ordinalInFile" | "sectionPath">) {
    const section = sectionStack.length > 0 ? sectionStack.join(" / ") : null;
    entries.push({
      fileKey,
      relativePath,
      sectionPath: section,
      kind: partial.kind,
      text: partial.text,
      hash: hashEntry(partial.text, relativePath),
      lineStart: partial.lineStart,
      lineEnd: partial.lineEnd,
      ordinalInFile: ordinal++,
    });
  }

  let i = 0;
  let paragraphBuffer: string[] = [];
  let paragraphStart = -1;

  function flushParagraph(endLine: number) {
    if (paragraphBuffer.length === 0) return;
    const text = paragraphBuffer.join("\n").trim();
    if (text.length > 0) {
      const isLabel = /^\*\*[^*]+:\*\*/.test(text);
      pushEntry({
        kind: isLabel ? "label" : "paragraph",
        text,
        lineStart: paragraphStart,
        lineEnd: endLine,
      });
    }
    paragraphBuffer = [];
    paragraphStart = -1;
  }

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // HOMER auto-managed block
    if (trimmed.startsWith("<!-- HOMER:START")) { inHomerBlock = true; i++; continue; }
    if (trimmed.startsWith("<!-- HOMER:END")) { inHomerBlock = false; i++; continue; }
    if (inHomerBlock) { i++; continue; }

    // Code fences
    if (trimmed.startsWith("```")) {
      if (!inCodeFence) {
        flushParagraph(i - 1);
        inCodeFence = true;
        codeFenceStart = i;
        codeFenceLines = [line];
      } else {
        codeFenceLines.push(line);
        const full = codeFenceLines.join("\n");
        if (full.length < 500) {
          pushEntry({ kind: "code", text: full, lineStart: codeFenceStart, lineEnd: i });
        }
        inCodeFence = false;
        codeFenceStart = -1;
        codeFenceLines = [];
      }
      i++;
      continue;
    }
    if (inCodeFence) {
      codeFenceLines.push(line);
      i++;
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph(i - 1);
      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!.trim();
      // Trim stack to depth level-1 then push
      sectionStack.length = Math.max(0, level - 1);
      sectionStack[level - 1] = title;
      i++;
      continue;
    }

    // Bullet
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph(i - 1);
      // Gather continuation lines (indented more than bullet marker)
      const bulletText: string[] = [line];
      const baseIndent = bulletMatch[1]!.length;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j]!;
        if (next.trim() === "") break;
        // Continuation = indented further than bullet marker, not a new bullet/heading
        const nextIndent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (nextIndent > baseIndent && !next.trim().match(/^[-*]\s/) && !next.trim().match(/^\d+\.\s/) && !next.trim().startsWith("#")) {
          bulletText.push(next);
          j++;
        } else break;
      }
      pushEntry({ kind: "bullet", text: bulletText.join("\n"), lineStart: i, lineEnd: j - 1 });
      i = j;
      continue;
    }

    // Numbered list
    const numberedMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (numberedMatch) {
      flushParagraph(i - 1);
      const numText: string[] = [line];
      const baseIndent = numberedMatch[1]!.length;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j]!;
        if (next.trim() === "") break;
        const nextIndent = next.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (nextIndent > baseIndent && !next.trim().match(/^\d+\.\s/) && !next.trim().match(/^[-*]\s/) && !next.trim().startsWith("#")) {
          numText.push(next);
          j++;
        } else break;
      }
      pushEntry({ kind: "numbered", text: numText.join("\n"), lineStart: i, lineEnd: j - 1 });
      i = j;
      continue;
    }

    // Table (consecutive `|` lines)
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushParagraph(i - 1);
      const tableLines: string[] = [line];
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim().startsWith("|") && lines[j]!.trim().endsWith("|")) {
        tableLines.push(lines[j]!);
        j++;
      }
      pushEntry({ kind: "table", text: tableLines.join("\n"), lineStart: i, lineEnd: j - 1 });
      i = j;
      continue;
    }

    // Blank line = flush paragraph
    if (trimmed === "") {
      flushParagraph(i - 1);
      i++;
      continue;
    }

    // Accumulate into paragraph
    if (paragraphBuffer.length === 0) paragraphStart = i;
    paragraphBuffer.push(line);
    i++;
  }
  flushParagraph(lines.length - 1);

  return entries;
}

// ── Index Sync ─────────────────────────────────────────────

function genEntryId(hash: string): string {
  return "me_" + hash.slice(0, 20);
}

/**
 * Reconcile memory_entries with the current state of ~/memory/*.md files.
 * - New entries are inserted.
 * - Entries whose hash or line range changed are updated.
 * - Entries no longer present are soft-deactivated (is_active = 0).
 */
export async function syncMemoryEntries(sm: StateManager, memoryDir: string = PATHS.memory): Promise<MemoryEntrySyncResult> {
  const db = sm.getDb();
  const files = await listAuditableFiles(memoryDir);

  const allParsed: ParsedEntry[] = [];
  for (const rel of files) {
    const full = join(memoryDir, rel);
    try {
      const content = await readFile(full, "utf-8");
      const entries = parseMarkdownEntries(rel, content);
      allParsed.push(...entries);
    } catch (err) {
      logger.warn({ err, file: rel }, "syncMemoryEntries: failed to read file");
    }
  }

  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  let deactivated = 0;

  const existingById = new Map<string, { hash: string; is_active: number }>();
  const rows = db.prepare(`SELECT id, entry_hash as hash, is_active FROM memory_entries`).all() as Array<{ id: string; hash: string; is_active: number }>;
  for (const r of rows) existingById.set(r.id, { hash: r.hash, is_active: r.is_active });

  const seen = new Set<string>();

  const insert = db.prepare(`
    INSERT INTO memory_entries (
      id, file_key, relative_path, section_path, entry_kind, entry_text, entry_hash,
      line_start, line_end, ordinal_in_file, created_at, updated_at, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const update = db.prepare(`
    UPDATE memory_entries
    SET file_key = ?, relative_path = ?, section_path = ?, entry_kind = ?,
        entry_text = ?, entry_hash = ?, line_start = ?, line_end = ?,
        ordinal_in_file = ?, updated_at = ?, is_active = 1
    WHERE id = ?
  `);

  const deactivate = db.prepare(`
    UPDATE memory_entries SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1
  `);

  const tx = db.transaction(() => {
    for (const e of allParsed) {
      const id = genEntryId(e.hash);
      seen.add(id);
      const existing = existingById.get(id);
      if (!existing) {
        try {
          insert.run(id, e.fileKey, e.relativePath, e.sectionPath, e.kind, e.text, e.hash,
            e.lineStart, e.lineEnd, e.ordinalInFile, now, now);
          inserted++;
        } catch (err) {
          // Hash collision with inactive row: reactivate
          update.run(e.fileKey, e.relativePath, e.sectionPath, e.kind, e.text, e.hash,
            e.lineStart, e.lineEnd, e.ordinalInFile, now, id);
          updated++;
        }
      } else {
        // Re-run update even if hash matches — line ranges or ordinal may have shifted
        update.run(e.fileKey, e.relativePath, e.sectionPath, e.kind, e.text, e.hash,
          e.lineStart, e.lineEnd, e.ordinalInFile, now, id);
        if (existing.is_active === 0) updated++;
      }
    }
    for (const [id] of existingById) {
      if (!seen.has(id)) {
        const result = deactivate.run(now, id);
        if (result.changes > 0) deactivated++;
      }
    }
  });
  tx();

  logger.info({ files: files.length, parsed: allParsed.length, inserted, updated, deactivated }, "syncMemoryEntries complete");
  return { scannedFiles: files.length, parsedEntries: allParsed.length, inserted, updated, deactivated };
}

// ── Weekly Session Management ──────────────────────────────

function sessionId(): string {
  return "was_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function sessionEntryId(): string {
  return "wase_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function computeStalenessScore(entry: {
  lastRetrievedAt: string | null;
  usageCount: number;
  createdAt: string;
  lastReviewedAt: string | null;
}): number {
  const now = Date.now();
  const lastTouchMs = entry.lastRetrievedAt ? new Date(entry.lastRetrievedAt).getTime() : new Date(entry.createdAt).getTime();
  const daysSinceTouch = Math.max(0, (now - lastTouchMs) / 86400000);
  // Score: days-since-retrieved / (usage_count + 1). Higher = more stale.
  return Math.round((daysSinceTouch / (entry.usageCount + 1)) * 100) / 100;
}

const RECENT_REVIEW_GRACE_DAYS = 14;

function isRecentlyReviewed(lastReviewedAt: string | null, usageCount: number): boolean {
  if (!lastReviewedAt) return false;
  const ageDays = (Date.now() - new Date(lastReviewedAt).getTime()) / 86400000;
  return ageDays < RECENT_REVIEW_GRACE_DAYS && usageCount > 0;
}

/**
 * If an active or paused session exists and is less than 21 days old, return it.
 * Otherwise return null — caller should create a fresh session.
 */
export function findResumableSession(db: Database.Database): WeeklyAuditSessionRow | null {
  const row = db.prepare(`
    SELECT id, week_start as weekStart, status, created_at as createdAt,
           started_at as startedAt, completed_at as completedAt,
           resume_file_path as resumeFilePath, resume_entry_ordinal as resumeEntryOrdinal,
           resume_anchor_staleness as resumeAnchorStaleness,
           resume_anchor_ordinal as resumeAnchorOrdinal,
           entry_snapshot_count as entrySnapshotCount,
           source_memory_version as sourceMemoryVersion,
           telegram_session_root_id as telegramSessionRootId
    FROM weekly_audit_sessions
    WHERE status IN ('active', 'paused')
    ORDER BY created_at DESC
    LIMIT 1
  `).get() as WeeklyAuditSessionRow | undefined;

  if (!row) return null;
  const ageDays = (Date.now() - new Date(row.createdAt).getTime()) / 86400000;
  if (ageDays > 21) {
    db.prepare(`UPDATE weekly_audit_sessions SET status = 'abandoned' WHERE id = ?`).run(row.id);
    logger.info({ sessionId: row.id, ageDays }, "Auto-abandoned stale weekly audit session");
    return null;
  }
  return row;
}

/**
 * Create a new weekly audit session and snapshot all currently-active memory entries.
 * Applies 14-day grace filter (recently-reviewed + used entries are excluded).
 */
export function createWeeklyAuditSession(sm: StateManager, weekStartIso: string): WeeklyAuditSessionRow {
  const db = sm.getDb();
  const sid = sessionId();
  const now = new Date().toISOString();

  const activeEntries = db.prepare(`
    SELECT id, file_key as fileKey, relative_path as relativePath, section_path as sectionPath,
           entry_kind as entryKind, entry_text as entryText, entry_hash as entryHash,
           line_start as lineStart, line_end as lineEnd, ordinal_in_file as ordinalInFile,
           created_at as createdAt, updated_at as updatedAt,
           promoted_at as promotedAt, last_reviewed_at as lastReviewedAt,
           last_retrieved_at as lastRetrievedAt, usage_count as usageCount, is_active as isActive
    FROM memory_entries
    WHERE is_active = 1
    ORDER BY relative_path, ordinal_in_file
  `).all() as MemoryEntryRow[];

  // Apply 14-day grace filter
  const toReview = activeEntries.filter(e => !isRecentlyReviewed(e.lastReviewedAt, e.usageCount));

  // Compute memory version hash
  const versionHash = createHash("sha256")
    .update(activeEntries.map(e => e.entryHash).sort().join(":"))
    .digest("hex");

  db.prepare(`
    INSERT INTO weekly_audit_sessions (
      id, week_start, status, created_at, entry_snapshot_count, source_memory_version
    ) VALUES (?, ?, 'active', ?, ?, ?)
  `).run(sid, weekStartIso, now, toReview.length, versionHash);

  const insertSnapshot = db.prepare(`
    INSERT INTO weekly_audit_session_entries (
      id, session_id, memory_entry_id, file_key, file_path, section_path,
      line_start, line_end, entry_text, entry_hash, usage_count,
      last_retrieved_at, promoted_at, ordinal_in_file, staleness_score, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);

  const tx = db.transaction(() => {
    for (const e of toReview) {
      const score = computeStalenessScore({
        lastRetrievedAt: e.lastRetrievedAt,
        usageCount: e.usageCount,
        createdAt: e.createdAt,
        lastReviewedAt: e.lastReviewedAt,
      });
      insertSnapshot.run(
        sessionEntryId(), sid, e.id, e.fileKey, e.relativePath, e.sectionPath,
        e.lineStart, e.lineEnd, e.entryText, e.entryHash, e.usageCount,
        e.lastRetrievedAt, e.promotedAt, e.ordinalInFile, score,
      );
    }
  });
  tx();

  logger.info({ sessionId: sid, snapshotCount: toReview.length, filtered: activeEntries.length - toReview.length }, "Created weekly audit session");

  return {
    id: sid,
    weekStart: weekStartIso,
    status: "active",
    createdAt: now,
    startedAt: null,
    completedAt: null,
    resumeFilePath: null,
    resumeEntryOrdinal: null,
    resumeAnchorStaleness: null,
    resumeAnchorOrdinal: null,
    entrySnapshotCount: toReview.length,
    sourceMemoryVersion: versionHash,
    telegramSessionRootId: null,
  };
}

/**
 * List files present in a session snapshot, with per-file progress counts.
 */
export function getSessionFileProgress(
  db: Database.Database,
  sessionId: string,
): Array<{ fileKey: string; filePath: string; total: number; pending: number; kept: number; edited: number; removed: number; stale: number; skipped: number; conflict: number }> {
  return db.prepare(`
    SELECT
      file_key as fileKey,
      file_path as filePath,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'kept' THEN 1 ELSE 0 END) as kept,
      SUM(CASE WHEN status = 'edited' THEN 1 ELSE 0 END) as edited,
      SUM(CASE WHEN status = 'removed' THEN 1 ELSE 0 END) as removed,
      SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) as stale,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
      SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END) as conflict
    FROM weekly_audit_session_entries
    WHERE session_id = ?
    GROUP BY file_key, file_path
  `).all(sessionId) as Array<{ fileKey: string; filePath: string; total: number; pending: number; kept: number; edited: number; removed: number; stale: number; skipped: number; conflict: number }>;
}

/**
 * Get pending entries for a specific file within a session, sorted by staleness DESC then ordinal.
 */
export function getSessionFileEntries(
  db: Database.Database,
  sessionId: string,
  filePath: string,
  includeResolved: boolean = false,
): WeeklyAuditSessionEntryRow[] {
  const statusFilter = includeResolved ? "" : "AND status = 'pending'";
  return db.prepare(`
    SELECT
      id, session_id as sessionId, memory_entry_id as memoryEntryId,
      file_key as fileKey, file_path as filePath, section_path as sectionPath,
      line_start as lineStart, line_end as lineEnd, entry_text as entryText,
      entry_hash as entryHash, usage_count as usageCount,
      last_retrieved_at as lastRetrievedAt, promoted_at as promotedAt,
      ordinal_in_file as ordinalInFile, staleness_score as stalenessScore,
      status, decision_note as decisionNote, decided_at as decidedAt,
      telegram_message_id as telegramMessageId
    FROM weekly_audit_session_entries
    WHERE session_id = ? AND file_path = ? ${statusFilter}
    ORDER BY staleness_score DESC, ordinal_in_file ASC
  `).all(sessionId, filePath) as WeeklyAuditSessionEntryRow[];
}

/**
 * Fetch up to `limit` pending entries strictly after the given anchor in the
 * stable sort order (staleness_score DESC, ordinal_in_file ASC). Pass null
 * anchor for the first page. Pagination stays correct even when earlier
 * entries resolve mid-session, because the anchor is an entry-identifying
 * key rather than an offset into a shrinking list.
 */
export function getSessionFileEntriesAfter(
  db: Database.Database,
  sessionId: string,
  filePath: string,
  anchor: { stalenessScore: number; ordinalInFile: number } | null,
  limit: number,
): WeeklyAuditSessionEntryRow[] {
  const base = `
    SELECT
      id, session_id as sessionId, memory_entry_id as memoryEntryId,
      file_key as fileKey, file_path as filePath, section_path as sectionPath,
      line_start as lineStart, line_end as lineEnd, entry_text as entryText,
      entry_hash as entryHash, usage_count as usageCount,
      last_retrieved_at as lastRetrievedAt, promoted_at as promotedAt,
      ordinal_in_file as ordinalInFile, staleness_score as stalenessScore,
      status, decision_note as decisionNote, decided_at as decidedAt,
      telegram_message_id as telegramMessageId
    FROM weekly_audit_session_entries
    WHERE session_id = ? AND file_path = ? AND status = 'pending'
  `;

  if (!anchor) {
    return db.prepare(`${base} ORDER BY staleness_score DESC, ordinal_in_file ASC LIMIT ?`)
      .all(sessionId, filePath, limit) as WeeklyAuditSessionEntryRow[];
  }

  // Strictly-after in (staleness DESC, ordinal ASC) order:
  //   staleness_score < anchor.staleness
  //   OR (staleness_score = anchor.staleness AND ordinal_in_file > anchor.ordinal)
  return db.prepare(`
    ${base}
      AND (
        staleness_score < ?
        OR (staleness_score = ? AND ordinal_in_file > ?)
      )
    ORDER BY staleness_score DESC, ordinal_in_file ASC
    LIMIT ?
  `).all(
    sessionId, filePath,
    anchor.stalenessScore, anchor.stalenessScore, anchor.ordinalInFile,
    limit,
  ) as WeeklyAuditSessionEntryRow[];
}

export function getSessionEntry(
  db: Database.Database,
  entryId: string,
): WeeklyAuditSessionEntryRow | null {
  return (db.prepare(`
    SELECT
      id, session_id as sessionId, memory_entry_id as memoryEntryId,
      file_key as fileKey, file_path as filePath, section_path as sectionPath,
      line_start as lineStart, line_end as lineEnd, entry_text as entryText,
      entry_hash as entryHash, usage_count as usageCount,
      last_retrieved_at as lastRetrievedAt, promoted_at as promotedAt,
      ordinal_in_file as ordinalInFile, staleness_score as stalenessScore,
      status, decision_note as decisionNote, decided_at as decidedAt,
      telegram_message_id as telegramMessageId
    FROM weekly_audit_session_entries
    WHERE id = ?
  `).get(entryId) as WeeklyAuditSessionEntryRow | undefined) ?? null;
}

// ── Decision Application ──────────────────────────────────

export interface WeeklyAuditDecisionInput {
  sessionEntryId: string;
  action: "keep" | "edit" | "remove" | "stale";
  newText?: string; // required for action === 'edit'
}

/**
 * Apply a Keep/Edit/Remove/Stale decision to the live memory file, guarded by
 * the snapshot's entry_hash. If the live file no longer contains the snapshot
 * text, marks the entry as 'conflict' instead of blindly writing.
 */
export async function applyWeeklyAuditDecision(
  sm: StateManager,
  cms: CanonicalMemoryService,
  input: WeeklyAuditDecisionInput,
): Promise<{ ok: boolean; status: "kept" | "edited" | "removed" | "stale" | "conflict"; reason?: string }> {
  const db = sm.getDb();
  const row = getSessionEntry(db, input.sessionEntryId);
  if (!row) return { ok: false, status: "conflict", reason: "session entry not found" };

  if (row.status !== "pending") {
    return { ok: false, status: row.status as "kept" | "edited" | "removed" | "stale" | "conflict", reason: `already ${row.status}` };
  }

  const now = new Date().toISOString();

  const markDecision = (newStatus: "kept" | "edited" | "removed" | "stale" | "conflict", note?: string) => {
    db.prepare(`
      UPDATE weekly_audit_session_entries
      SET status = ?, decision_note = ?, decided_at = ?
      WHERE id = ?
    `).run(newStatus, note ?? null, now, input.sessionEntryId);
    db.prepare(`
      INSERT INTO memory_entry_events (memory_entry_id, event_type, session_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.memoryEntryId, newStatus === "conflict" ? "conflict" : newStatus, row.sessionId, JSON.stringify({ action: input.action, note }), now);
    if (newStatus !== "conflict") {
      db.prepare(`
        UPDATE memory_entries SET last_reviewed_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, row.memoryEntryId);
    }
  };

  // Keep: just mark reviewed, no file mutation
  if (input.action === "keep") {
    markDecision("kept");
    return { ok: true, status: "kept" };
  }

  // Stale: flag for later but don't remove yet
  if (input.action === "stale") {
    markDecision("stale");
    return { ok: true, status: "stale" };
  }

  // Edit / Remove: verify the snapshot text still lives in the file, then mutate
  const fileContent = await readFileSafe(join(PATHS.memory, row.filePath));
  if (fileContent === null) {
    markDecision("conflict", "file not found");
    return { ok: false, status: "conflict", reason: "file missing" };
  }

  if (!fileContent.includes(row.entryText)) {
    markDecision("conflict", "entry text not found in live file");
    return { ok: false, status: "conflict", reason: "snapshot conflict" };
  }

  if (input.action === "remove") {
    const removed = await cms.removeFromFile(row.fileKey, row.entryText, "weekly-audit");
    if (!removed) {
      markDecision("conflict", "remove failed");
      return { ok: false, status: "conflict", reason: "remove failed" };
    }
    markDecision("removed");
    return { ok: true, status: "removed" };
  }

  if (input.action === "edit") {
    if (!input.newText || input.newText.trim().length === 0) {
      return { ok: false, status: "conflict", reason: "edit requires non-empty newText" };
    }
    const replaced = await cms.replaceInFile(row.fileKey, row.entryText, input.newText, "weekly-audit");
    if (!replaced) {
      markDecision("conflict", "replace failed");
      return { ok: false, status: "conflict", reason: "replace failed" };
    }
    markDecision("edited", input.newText.slice(0, 200));
    return { ok: true, status: "edited" };
  }

  return { ok: false, status: "conflict", reason: "unknown action" };
}

async function readFileSafe(path: string): Promise<string | null> {
  try { return await readFile(path, "utf-8"); } catch { return null; }
}

/**
 * Pause / Complete / Abandon a session.
 */
export function updateSessionStatus(
  db: Database.Database,
  sessionId: string,
  status: "paused" | "completed" | "abandoned" | "active",
): void {
  const now = new Date().toISOString();
  if (status === "completed") {
    db.prepare(`UPDATE weekly_audit_sessions SET status = 'completed', completed_at = ? WHERE id = ?`).run(now, sessionId);
  } else {
    db.prepare(`UPDATE weekly_audit_sessions SET status = ? WHERE id = ?`).run(status, sessionId);
  }
}

export function getActiveSession(db: Database.Database): WeeklyAuditSessionRow | null {
  return findResumableSession(db);
}

/**
 * Given a relative path like "work.md", convert to the fileKey used by
 * canonical-service.ts promoteToFile/replaceInFile (which expects "work").
 */
export function relativePathToFileKey(relativePath: string): string {
  return fileKeyFromPath(relativePath);
}
