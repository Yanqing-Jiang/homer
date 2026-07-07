/**
 * Todos DAO — DB-only surface backing the To-Dos feature.
 *
 * todo_index (SQLite) is the sole source of truth. No filesystem mirror.
 *
 * Two knowledge_claims hooks:
 *  - P1 todos auto-emit an approved `commitment` claim the first time priority
 *    becomes P1. Dedup key: `source_url = todo:{id}`. Skipped for source='idea'
 *    (HITL elsewhere) and source='migration' (retro claims aren't meaningful).
 *  - Todos transitioning open→done with notes ≥ LESSON_MIN_NOTES_LEN chars
 *    auto-emit an approved `lesson` claim with title + notes as content.
 *    Dedup key: `source_url = todo:{id}:done`. The lesson flows through
 *    knowledge_claims_fts automatically and is picked up by the next
 *    memory_reindex embeddings pass for vector recall.
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import { logger } from "../utils/logger.js";

export interface ChecklistItem { id: string; text: string; done: boolean }

export interface TodoRow {
  id: string;
  title: string;
  status: "open" | "done" | "archived";
  category: "W" | "L";
  priority: "P1" | "P2" | "P3";
  notes: string;
  checklist: ChecklistItem[];
  source: "manual" | "web" | "mcp" | "idea" | "migration";
  source_idea_id: string | null;
  linked_thread_id: string | null;
  legacy_plan_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
}

export interface TodoFilter {
  status?: "open" | "done" | "archived" | "all";
  category?: "W" | "L";
  priority?: "P1" | "P2" | "P3";
  id?: string;
  limit?: number;
  includeNotes?: boolean;
}

export interface SaveTodoInput {
  /** Patch this id if present; otherwise create a new todo (title required). */
  id?: string;
  title?: string;
  status?: "open" | "done" | "archived";
  category?: "W" | "L";
  priority?: "P1" | "P2" | "P3";
  notes?: string;
  checklist?: ChecklistItem[];
  /** Convenience: appended to notes verbatim with a blank line in front. */
  appendNotes?: string;
  source?: TodoRow["source"];
  sourceIdeaId?: string | null;
  linkedThreadId?: string | null;
  legacyPlanId?: string | null;
}

// ─── ID helpers ──────────────────────────────────────────────────

function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}`; }

function timestampStem(d: Date = new Date()): string {
  return (
    d.getFullYear().toString() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  return s.length > 0 ? s : "untitled";
}

export function generateTodoId(title: string, when: Date = new Date()): string {
  const suffix = randomBytes(2).toString("hex");
  return `todo_${timestampStem(when)}_${slugify(title)}_${suffix}`;
}

function nowIso(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// ─── Reads ───────────────────────────────────────────────────────

export function getTodo(db: Database.Database, id: string): TodoRow | null {
  let row = db.prepare("SELECT * FROM todo_index WHERE id = ?").get(id) as any;
  if (!row) {
    row = db.prepare("SELECT * FROM todo_index WHERE id LIKE ? LIMIT 1").get(`${id}%`) as any;
  }
  return row ? mapRow(row) : null;
}

export function listTodos(db: Database.Database, filter: TodoFilter = {}): TodoRow[] {
  // Single-id filter short-circuits to getTodo for ergonomics.
  if (filter.id) {
    const one = getTodo(db, filter.id);
    return one ? [one] : [];
  }

  const status = filter.status ?? "open";
  const cat = filter.category ?? null;
  const prio = filter.priority ?? null;
  const limit = filter.limit ?? 100;
  const includeNotes = filter.includeNotes !== false;

  const sql = `
    SELECT id, title, status, category, priority,
           ${includeNotes ? "notes" : "'' AS notes"},
           checklist,
           source, source_idea_id, linked_thread_id, legacy_plan_id,
           created_at, updated_at, completed_at, archived_at
    FROM todo_index
    WHERE (? = 'all' OR status = ?)
      AND (? IS NULL OR category = ?)
      AND (? IS NULL OR priority = ?)
    ORDER BY
      CASE priority WHEN 'P1' THEN 0 WHEN 'P2' THEN 1 ELSE 2 END,
      datetime(updated_at) DESC
    LIMIT ?
  `;
  return (db.prepare(sql).all(status, status, cat, cat, prio, prio, limit) as any[]).map(mapRow);
}

// ─── Writes ──────────────────────────────────────────────────────

/**
 * Single upsert entry point. Missing id = create; present id = patch.
 * Returns the resulting row, or null if patching an id that doesn't exist.
 */
export function saveTodo(db: Database.Database, input: SaveTodoInput): TodoRow | null {
  return input.id ? patchExisting(db, input) : createNew(db, input);
}

function createNew(db: Database.Database, input: SaveTodoInput): TodoRow {
  if (!input.title || input.title.trim().length === 0) {
    throw new TodoValidationError("title required when creating a todo");
  }
  const now = nowIso();
  const id = generateTodoId(input.title);
  const notes = appendIfPresent(input.notes ?? "", input.appendNotes);
  const checklist = validateChecklist(input.checklist ?? []);

  const row: TodoRow = {
    id,
    title: input.title.trim(),
    status: input.status ?? "open",
    category: input.category ?? "W",
    priority: input.priority ?? "P3",
    notes,
    checklist,
    source: input.source ?? "manual",
    source_idea_id: input.sourceIdeaId ?? null,
    linked_thread_id: input.linkedThreadId ?? null,
    legacy_plan_id: input.legacyPlanId ?? null,
    created_at: now,
    updated_at: now,
    completed_at: input.status === "done" ? now : null,
    archived_at: input.status === "archived" ? now : null,
  };

  db.transaction(() => {
    db.prepare(`
      INSERT INTO todo_index (
        id, title, status, category, priority, notes, checklist,
        source, source_idea_id, linked_thread_id, legacy_plan_id,
        created_at, updated_at, completed_at, archived_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      row.id, row.title, row.status, row.category, row.priority, row.notes, JSON.stringify(row.checklist),
      row.source, row.source_idea_id, row.linked_thread_id, row.legacy_plan_id,
      row.created_at, row.updated_at, row.completed_at, row.archived_at,
    );

    if (row.source_idea_id) linkIdea(db, row.source_idea_id, id);
  })();

  emitCommitmentIfP1(db, row);
  if (row.status === "done") emitLessonOnDone(db, row);
  return row;
}

function patchExisting(db: Database.Database, input: SaveTodoInput): TodoRow | null {
  const finalChecklistProvided = input.checklist !== undefined;
  const validatedChecklist = finalChecklistProvided ? validateChecklist(input.checklist) : null;

  return db.transaction((): TodoRow | null => {
    const existing = getTodo(db, input.id!);
    if (!existing) return null;
    const wasP1 = existing.priority === "P1";
    const now = nowIso();
    const explicitStatus = input.status !== undefined;

    const checklist = validatedChecklist ?? existing.checklist;

    // Resolve status: explicit wins; else checklist auto-rule (patches only, non-archived).
    let status = input.status ?? existing.status;
    if (!explicitStatus && finalChecklistProvided && existing.status !== "archived") {
      const total = checklist.length;
      const doneCount = checklist.filter((i) => i.done).length;
      if (total > 0 && doneCount === total && existing.status === "open") status = "done";
      else if (doneCount < total && existing.status === "done") status = "open";
    }

    const transitionedToDone = existing.status !== "done" && status === "done";
    const autoCompleted = transitionedToDone && !explicitStatus; // checklist-driven
    let notes = appendIfPresent(input.notes ?? existing.notes, input.appendNotes);
    if (autoCompleted) {
      notes = appendIfPresent(notes, `## Completed ${now.slice(0, 10)}\nAuto-completed: all checklist items done.`);
    }

    const merged: TodoRow = {
      ...existing,
      title: input.title?.trim() ?? existing.title,
      category: input.category ?? existing.category,
      priority: input.priority ?? existing.priority,
      status,
      notes,
      checklist,
      source_idea_id: input.sourceIdeaId !== undefined ? input.sourceIdeaId : existing.source_idea_id,
      linked_thread_id: input.linkedThreadId !== undefined ? input.linkedThreadId : existing.linked_thread_id,
      updated_at: now,
    };
    // Timestamps from FINAL status transition.
    if (transitionedToDone) merged.completed_at = now;
    else if (status !== "done") merged.completed_at = null;
    if (status === "archived" && existing.status !== "archived") merged.archived_at = now;
    else if (status !== "archived") merged.archived_at = null;

    db.prepare(`
      UPDATE todo_index SET
        title = ?, status = ?, category = ?, priority = ?, notes = ?, checklist = ?,
        source_idea_id = ?, linked_thread_id = ?,
        updated_at = ?, completed_at = ?, archived_at = ?
      WHERE id = ?
    `).run(
      merged.title, merged.status, merged.category, merged.priority, merged.notes, JSON.stringify(merged.checklist),
      merged.source_idea_id, merged.linked_thread_id,
      merged.updated_at, merged.completed_at, merged.archived_at, existing.id,
    );

    if (!wasP1 && merged.priority === "P1") emitCommitmentIfP1(db, merged);
    if (transitionedToDone) emitLessonOnDone(db, merged); // covers explicit AND auto
    return merged;
  })();
}

/**
 * Hard delete (rare). Soft-archival is done via saveTodo({status: 'archived'}).
 */
export function hardDeleteTodo(db: Database.Database, id: string): boolean {
  const existing = getTodo(db, id);
  if (!existing) return false;
  db.prepare("DELETE FROM todo_index WHERE id = ?").run(existing.id);
  return true;
}

// ─── Internal helpers ────────────────────────────────────────────

function appendIfPresent(base: string, append?: string): string {
  if (!append) return base;
  const trimmedBase = base.replace(/\s+$/, "");
  return trimmedBase.length > 0 ? `${trimmedBase}\n\n${append}` : append;
}

// ─── Checklist helpers ───────────────────────────────────────────

/** Thrown on invalid client input (bad checklist, missing title). Callers map this to HTTP 400 / MCP tool error; anything else is a real 500. */
export class TodoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoValidationError";
  }
}

const CHECKLIST_MAX_ITEMS = 100;
const CHECKLIST_MAX_TEXT = 500;
function genItemId(): string { return "ck_" + randomBytes(4).toString("hex"); }

// READ path — lenient, never throws. Normalizes shape, drops structurally-broken
// items, and guarantees unique ids (regenerating on collision) so keyed Svelte
// lists never mis-associate rows. Arrays and JSON strings share one normalizer;
// non-array / malformed JSON falls back to [].
function parseChecklist(raw: unknown): ChecklistItem[] {
  if (raw == null || raw === "") return [];
  let arr: unknown;
  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    try { arr = JSON.parse(String(raw)); }
    catch (err) { logger.warn({ err }, "todo checklist: malformed JSON in DB"); return []; }
  }
  if (!Array.isArray(arr)) { logger.warn({ raw }, "todo checklist: stored value not an array"); return []; }
  const seen = new Set<string>();
  const out: ChecklistItem[] = [];
  for (const it of arr as any[]) {
    if (!it || typeof it.text !== "string") { logger.warn({ it }, "todo checklist: dropping malformed item"); continue; }
    let id = typeof it.id === "string" && it.id ? it.id : genItemId();
    if (seen.has(id)) id = genItemId();
    seen.add(id);
    out.push({ id, text: it.text, done: it.done === true });
  }
  return out;
}

// WRITE path — strict, THROWS TodoValidationError on bad input. No silent coercion:
// `done` must be a real boolean and ids must be unique.
function validateChecklist(input: unknown): ChecklistItem[] {
  if (!Array.isArray(input)) throw new TodoValidationError("checklist: must be an array");
  if (input.length > CHECKLIST_MAX_ITEMS) throw new TodoValidationError(`checklist: too many items (max ${CHECKLIST_MAX_ITEMS})`);
  const seen = new Set<string>();
  return input.map((it: any, i: number) => {
    if (!it || typeof it !== "object") throw new TodoValidationError(`checklist: item ${i} is not an object`);
    const text = typeof it.text === "string" ? it.text.trim() : "";
    if (!text) throw new TodoValidationError(`checklist: item ${i} has empty text`);
    if (text.length > CHECKLIST_MAX_TEXT) throw new TodoValidationError(`checklist: item ${i} text exceeds ${CHECKLIST_MAX_TEXT}`);
    if (it.done !== undefined && typeof it.done !== "boolean") throw new TodoValidationError(`checklist: item ${i} done must be a boolean`);
    const id = typeof it.id === "string" && it.id ? it.id : genItemId();
    if (seen.has(id)) throw new TodoValidationError(`checklist: duplicate id ${id}`);
    seen.add(id);
    return { id, text, done: it.done === true };
  });
}

function mapRow(raw: any): TodoRow { return { ...raw, checklist: parseChecklist(raw.checklist) }; }

function linkIdea(db: Database.Database, ideaId: string, todoId: string): void {
  try {
    db.prepare("UPDATE ideas SET linked_todo_id = ? WHERE id = ?").run(todoId, ideaId);
  } catch (e) {
    logger.warn({ ideaId, error: e }, "Idea linked_todo_id update failed");
  }
}

/** Minimum notes length to qualify a done todo as a lesson worth indexing. */
const LESSON_MIN_NOTES_LEN = 80;
/** Cap on lesson content to avoid blob-sized claims. */
const LESSON_MAX_CONTENT_LEN = 4000;

function emitLessonOnDone(db: Database.Database, row: TodoRow): void {
  if (row.source === "migration") return;
  const notes = row.notes.trim();
  if (notes.length < LESSON_MIN_NOTES_LEN) return;

  try {
    const sourceUrl = `todo:${row.id}:done`;
    const existing = db.prepare(`
      SELECT id FROM knowledge_claims
      WHERE source_url = ? AND status NOT IN ('rejected','archived','expired')
      LIMIT 1
    `).get(sourceUrl) as { id: string } | undefined;
    if (existing) return;

    const body = `Completed: ${row.title}\n\n${notes}`;
    const content = body.length > LESSON_MAX_CONTENT_LEN
      ? body.slice(0, LESSON_MAX_CONTENT_LEN) + "\n\n[…truncated]"
      : body;
    const targetFile = row.category === "W" ? "work" : "me";
    const contentHash = createHash("md5").update(`${content}\n${targetFile}\nLessons`).digest("hex");
    const id = `claim_${randomBytes(8).toString("hex")}`;

    db.prepare(`
      INSERT INTO knowledge_claims (
        id, content, content_hash, target_file, section,
        claim_type, confidence, status, source_url, origin_channel, created_at
      ) VALUES (
        ?, ?, ?, ?, 'Lessons',
        'lesson', 0.85, 'approved', ?, 'todo', datetime('now')
      )
    `).run(id, content, contentHash, targetFile, sourceUrl);
    logger.info({ todoId: row.id, claimId: id, notesLen: notes.length }, "Auto-emitted done todo lesson claim");
  } catch (e) {
    logger.warn({ todoId: row.id, error: e }, "Done todo lesson claim emit failed (non-fatal)");
  }
}

function emitCommitmentIfP1(db: Database.Database, row: TodoRow): void {
  if (row.priority !== "P1") return;
  if (row.source === "idea" || row.source === "migration") return;
  try {
    const sourceUrl = `todo:${row.id}`;
    const existing = db.prepare(`
      SELECT id FROM knowledge_claims
      WHERE source_url = ? AND status NOT IN ('rejected','archived','expired')
      LIMIT 1
    `).get(sourceUrl) as { id: string } | undefined;
    if (existing) return;

    const content = `Yanqing committed to: ${row.title}. Priority: P1. Category: ${row.category === "W" ? "Work" : "Life"}. Todo: ${row.id}.`;
    const targetFile = row.category === "W" ? "work" : "me";
    const contentHash = createHash("md5").update(`${content}\n${targetFile}\nTo-Dos`).digest("hex");
    const id = `claim_${randomBytes(8).toString("hex")}`;

    db.prepare(`
      INSERT INTO knowledge_claims (
        id, content, content_hash, target_file, section,
        claim_type, confidence, status, source_url, origin_channel, created_at
      ) VALUES (
        ?, ?, ?, ?, 'To-Dos',
        'commitment', 0.95, 'approved', ?, 'todo', datetime('now')
      )
    `).run(id, content, contentHash, targetFile, sourceUrl);
    logger.info({ todoId: row.id, claimId: id }, "Auto-emitted P1 commitment claim");
  } catch (e) {
    logger.warn({ todoId: row.id, error: e }, "P1 commitment claim emit failed (non-fatal)");
  }
}

// ─── Mentor-layer surface ────────────────────────────────────────

export interface MentorTodo {
  id: string;
  title: string;
  category: "W" | "L";
  priority: "P1" | "P2";
  days_since_update: number;
}

/**
 * Open W P1/P2 todos that have crossed their stale threshold:
 * P1 ≥ 3 days untouched, P2 ≥ 7 days untouched. Used by mentor-layer cron.
 */
export function findMentorStalled(db: Database.Database, includeLife = false): MentorTodo[] {
  const catClause = includeLife ? "" : "AND category = 'W'";
  return db.prepare(`
    SELECT
      id, title, category, priority,
      CAST(julianday('now') - julianday(updated_at) AS INTEGER) AS days_since_update
    FROM todo_index
    WHERE status = 'open'
      ${catClause}
      AND (
        (priority = 'P1' AND updated_at < datetime('now','-3 days'))
        OR (priority = 'P2' AND updated_at < datetime('now','-7 days'))
      )
    ORDER BY
      CASE priority WHEN 'P1' THEN 0 ELSE 1 END,
      datetime(updated_at) ASC
    LIMIT 6
  `).all() as MentorTodo[];
}
