/**
 * Idea Discussions DAO — persistent conversation threads.
 *
 * A discussion is a multi-turn conversation linked to either a source_packet
 * or a promoted idea. This replaces the old one-shot "Talk" behavior
 * with genuine conversational exploration.
 *
 * Discussions persist turns, support resume, and are the place where
 * thinking happens before committing to an idea.
 */

// @ts-ignore
import type Database from "better-sqlite3";
// logger available if needed for future diagnostics

// ============================================
// Types
// ============================================

export type DiscussionStatus = "active" | "resolved" | "archived";
export type MessageRole = "user" | "assistant" | "system";

export interface Discussion {
  id: string;
  packetId?: string;
  ideaId?: string;
  title?: string;
  status: DiscussionStatus;
  createdAt: string;
  updatedAt: string;
  messages?: DiscussionMessage[];
}

export interface DiscussionMessage {
  id: number;
  discussionId: string;
  role: MessageRole;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface DiscussionRow {
  id: string;
  packet_id: string | null;
  idea_id: string | null;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  discussion_id: string;
  role: string;
  content: string;
  metadata: string | null;
  created_at: string;
}

// ============================================
// Conversion helpers
// ============================================

function rowToDiscussion(row: DiscussionRow): Discussion {
  return {
    id: row.id,
    packetId: row.packet_id ?? undefined,
    ideaId: row.idea_id ?? undefined,
    title: row.title ?? undefined,
    status: row.status as DiscussionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): DiscussionMessage {
  return {
    id: row.id,
    discussionId: row.discussion_id,
    role: row.role as MessageRole,
    content: row.content,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
  };
}

// ============================================
// Discussion CRUD
// ============================================

export function createDiscussion(db: Database.Database, input: {
  id: string;
  packetId?: string;
  ideaId?: string;
  title?: string;
}): Discussion {
  db.prepare(`
    INSERT INTO idea_discussions (id, packet_id, idea_id, title, status)
    VALUES (?, ?, ?, ?, 'active')
  `).run(input.id, input.packetId ?? null, input.ideaId ?? null, input.title ?? null);

  return getDiscussion(db, input.id)!;
}

export function getDiscussion(db: Database.Database, id: string): Discussion | null {
  const row = db.prepare("SELECT * FROM idea_discussions WHERE id = ?").get(id) as DiscussionRow | undefined;
  return row ? rowToDiscussion(row) : null;
}

/**
 * Get or create a discussion for a packet. If one already exists, resume it.
 */
export function getOrCreateDiscussion(db: Database.Database, opts: {
  packetId?: string;
  ideaId?: string;
  title?: string;
}): Discussion {
  // Look for existing active discussion on this packet/idea
  if (opts.packetId) {
    const existing = db.prepare(
      "SELECT * FROM idea_discussions WHERE packet_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1"
    ).get(opts.packetId) as DiscussionRow | undefined;
    if (existing) return rowToDiscussion(existing);
  }
  if (opts.ideaId) {
    const existing = db.prepare(
      "SELECT * FROM idea_discussions WHERE idea_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1"
    ).get(opts.ideaId) as DiscussionRow | undefined;
    if (existing) return rowToDiscussion(existing);
  }

  const id = `disc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return createDiscussion(db, { id, ...opts });
}

/**
 * Get all discussions, optionally filtered.
 */
export function getDiscussions(db: Database.Database, filter?: {
  status?: DiscussionStatus;
  packetId?: string;
  ideaId?: string;
  limit?: number;
}): Discussion[] {
  let query = "SELECT * FROM idea_discussions WHERE 1=1";
  const params: (string | number)[] = [];

  if (filter?.status) {
    query += " AND status = ?";
    params.push(filter.status);
  }
  if (filter?.packetId) {
    query += " AND packet_id = ?";
    params.push(filter.packetId);
  }
  if (filter?.ideaId) {
    query += " AND idea_id = ?";
    params.push(filter.ideaId);
  }

  query += " ORDER BY updated_at DESC";

  if (filter?.limit) {
    query += " LIMIT ?";
    params.push(filter.limit);
  }

  const rows = db.prepare(query).all(...params) as DiscussionRow[];
  return rows.map(rowToDiscussion);
}

export function updateDiscussion(
  db: Database.Database,
  id: string,
  fields: Partial<Pick<Discussion, "title" | "status" | "ideaId">>,
): Discussion | null {
  const existing = getDiscussion(db, id);
  if (!existing) return null;

  const sets: string[] = ["updated_at = datetime('now')"];
  const params: (string | null)[] = [];

  if (fields.title !== undefined) { sets.push("title = ?"); params.push(fields.title ?? null); }
  if (fields.status !== undefined) { sets.push("status = ?"); params.push(fields.status); }
  if (fields.ideaId !== undefined) { sets.push("idea_id = ?"); params.push(fields.ideaId ?? null); }

  params.push(existing.id);
  db.prepare(`UPDATE idea_discussions SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  return getDiscussion(db, existing.id);
}

// ============================================
// Message CRUD
// ============================================

export function addMessage(db: Database.Database, input: {
  discussionId: string;
  role: MessageRole;
  content: string;
  metadata?: Record<string, unknown>;
}): DiscussionMessage {
  const result = db.prepare(`
    INSERT INTO idea_discussion_messages (discussion_id, role, content, metadata)
    VALUES (?, ?, ?, ?)
  `).run(
    input.discussionId,
    input.role,
    input.content,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );

  // Touch discussion updated_at
  db.prepare("UPDATE idea_discussions SET updated_at = datetime('now') WHERE id = ?").run(input.discussionId);

  return getMessage(db, Number(result.lastInsertRowid))!;
}

export function getMessage(db: Database.Database, id: number): DiscussionMessage | null {
  const row = db.prepare("SELECT * FROM idea_discussion_messages WHERE id = ?").get(id) as MessageRow | undefined;
  return row ? rowToMessage(row) : null;
}

/**
 * Get all messages for a discussion, ordered chronologically.
 */
export function getMessages(db: Database.Database, discussionId: string, limit?: number): DiscussionMessage[] {
  let query = "SELECT * FROM idea_discussion_messages WHERE discussion_id = ? ORDER BY created_at ASC";
  const params: (string | number)[] = [discussionId];

  if (limit) {
    query += " LIMIT ?";
    params.push(limit);
  }

  const rows = db.prepare(query).all(...params) as MessageRow[];
  return rows.map(rowToMessage);
}

/**
 * Get a discussion with all its messages loaded.
 */
export function getDiscussionWithMessages(db: Database.Database, id: string): Discussion | null {
  const discussion = getDiscussion(db, id);
  if (!discussion) return null;

  discussion.messages = getMessages(db, id);
  return discussion;
}

/**
 * Count messages in a discussion.
 */
export function messageCount(db: Database.Database, discussionId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM idea_discussion_messages WHERE discussion_id = ?"
  ).get(discussionId) as { count: number };
  return row.count;
}
