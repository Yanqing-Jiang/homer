/**
 * Source Packets DAO — first-class evidence objects.
 *
 * A source_packet is a durable, full-provenance evidence unit built from
 * one or more scrapes. It preserves raw content, deep-fetch results,
 * metadata, and enrichment without lossy flattening.
 *
 * Lifecycle: raw → queued → review → approved → promoted | archived | discarded
 * Ideas are only created when a packet is explicitly promoted.
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

// ============================================
// Types
// ============================================

export type PacketStatus = "raw" | "queued" | "review" | "approved" | "promoted" | "archived" | "discarded";

export interface SourcePacket {
  id: string;
  clusterId?: string;
  sourceType: string;
  primaryUrl?: string;
  title?: string;
  summary?: string;
  rawContent?: string;
  deepFetchContent?: string;
  metadata?: PacketMetadata;
  enrichment?: PacketEnrichment;
  status: PacketStatus;
  promotedIdeaId?: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  promotedAt?: string;
}

export interface PacketMetadata {
  author?: string;
  externalUrls?: string[];
  extractedTopics?: string[];
  deepFetchMeta?: Record<string, unknown>;
  scrapeIds?: string[];
  [key: string]: unknown;
}

export interface PacketEnrichment {
  candidate?: {
    title: string;
    content: string;
    relevance: string;
    confidence: number;
    tags: string[];
    link?: string;
    source: string;
  };
  critique?: {
    passed: boolean;
    reason: string;
    strengths?: string[];
    risks?: string[];
  };
  deepDive?: {
    coreClaim: string;
    evidence?: string;
    risks?: string[];
    validationPath?: string;
  };
  deepLinks?: Array<{
    target: string;
    relationship: string;
    strength: number;
  }>;
  homerImprovement?: {
    relevant: boolean;
    summary?: string;
    area?: string;
    priority?: string;
    plan?: string[];
  };
  [key: string]: unknown;
}

export interface PacketFilter {
  status?: PacketStatus | PacketStatus[];
  sourceType?: string;
  limit?: number;
  since?: string; // ISO datetime
}

interface SourcePacketRow {
  id: string;
  cluster_id: string | null;
  source_type: string;
  primary_url: string | null;
  title: string | null;
  summary: string | null;
  raw_content: string | null;
  deep_fetch_content: string | null;
  metadata: string | null;
  enrichment: string | null;
  status: string;
  promoted_idea_id: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  promoted_at: string | null;
}

// ============================================
// Conversion helpers
// ============================================

function rowToPacket(row: SourcePacketRow): SourcePacket {
  return {
    id: row.id,
    clusterId: row.cluster_id ?? undefined,
    sourceType: row.source_type,
    primaryUrl: row.primary_url ?? undefined,
    title: row.title ?? undefined,
    summary: row.summary ?? undefined,
    rawContent: row.raw_content ?? undefined,
    deepFetchContent: row.deep_fetch_content ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    enrichment: row.enrichment ? JSON.parse(row.enrichment) : undefined,
    status: row.status as PacketStatus,
    promotedIdeaId: row.promoted_idea_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at ?? undefined,
    promotedAt: row.promoted_at ?? undefined,
  };
}

// ============================================
// CRUD
// ============================================

export function createPacket(db: Database.Database, packet: {
  id: string;
  clusterId?: string;
  sourceType: string;
  primaryUrl?: string;
  title?: string;
  summary?: string;
  rawContent?: string;
  deepFetchContent?: string;
  metadata?: PacketMetadata;
  enrichment?: PacketEnrichment;
  status?: PacketStatus;
}): SourcePacket {
  const status = packet.status ?? "raw";

  db.prepare(`
    INSERT INTO source_packets (
      id, cluster_id, source_type, primary_url, title, summary,
      raw_content, deep_fetch_content, metadata, enrichment, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    packet.id,
    packet.clusterId ?? null,
    packet.sourceType,
    packet.primaryUrl ?? null,
    packet.title ?? null,
    packet.summary ?? null,
    packet.rawContent ?? null,
    packet.deepFetchContent ?? null,
    packet.metadata ? JSON.stringify(packet.metadata) : null,
    packet.enrichment ? JSON.stringify(packet.enrichment) : null,
    status,
  );

  return getPacket(db, packet.id)!;
}

export function getPacket(db: Database.Database, id: string): SourcePacket | null {
  const row = db.prepare("SELECT * FROM source_packets WHERE id = ?").get(id) as SourcePacketRow | undefined;
  if (!row) {
    // Try prefix match
    const prefixRow = db.prepare("SELECT * FROM source_packets WHERE id LIKE ? LIMIT 1").get(`${id}%`) as SourcePacketRow | undefined;
    return prefixRow ? rowToPacket(prefixRow) : null;
  }
  return rowToPacket(row);
}

export function getPackets(db: Database.Database, filter?: PacketFilter): SourcePacket[] {
  let query = "SELECT * FROM source_packets WHERE 1=1";
  const params: (string | number)[] = [];

  if (filter?.status) {
    if (Array.isArray(filter.status)) {
      const placeholders = filter.status.map(() => "?").join(", ");
      query += ` AND status IN (${placeholders})`;
      params.push(...filter.status);
    } else {
      query += " AND status = ?";
      params.push(filter.status);
    }
  }

  if (filter?.sourceType) {
    query += " AND source_type = ?";
    params.push(filter.sourceType);
  }

  if (filter?.since) {
    query += " AND created_at >= ?";
    params.push(filter.since);
  }

  query += " ORDER BY created_at DESC";

  if (filter?.limit) {
    query += " LIMIT ?";
    params.push(filter.limit);
  }

  const rows = db.prepare(query).all(...params) as SourcePacketRow[];
  return rows.map(rowToPacket);
}

/**
 * Get packets ready for morning review (status = queued, limited to top N).
 */
export function getReviewQueue(db: Database.Database, limit = 3): SourcePacket[] {
  return getPackets(db, { status: "queued", limit });
}

export function updatePacket(
  db: Database.Database,
  id: string,
  fields: Partial<Pick<SourcePacket, "title" | "summary" | "status" | "enrichment" | "metadata" | "promotedIdeaId" | "rawContent" | "deepFetchContent">>,
): SourcePacket | null {
  const existing = getPacket(db, id);
  if (!existing) return null;

  const sets: string[] = ["updated_at = datetime('now')"];
  const params: (string | null)[] = [];

  if (fields.title !== undefined) { sets.push("title = ?"); params.push(fields.title ?? null); }
  if (fields.summary !== undefined) { sets.push("summary = ?"); params.push(fields.summary ?? null); }
  if (fields.status !== undefined) {
    sets.push("status = ?");
    params.push(fields.status);
    if (fields.status === "review") { sets.push("reviewed_at = datetime('now')"); }
    if (fields.status === "promoted") { sets.push("promoted_at = datetime('now')"); }
  }
  if (fields.enrichment !== undefined) { sets.push("enrichment = ?"); params.push(JSON.stringify(fields.enrichment)); }
  if (fields.metadata !== undefined) { sets.push("metadata = ?"); params.push(JSON.stringify(fields.metadata)); }
  if (fields.promotedIdeaId !== undefined) { sets.push("promoted_idea_id = ?"); params.push(fields.promotedIdeaId ?? null); }
  if (fields.rawContent !== undefined) { sets.push("raw_content = ?"); params.push(fields.rawContent ?? null); }
  if (fields.deepFetchContent !== undefined) { sets.push("deep_fetch_content = ?"); params.push(fields.deepFetchContent ?? null); }

  params.push(existing.id);
  db.prepare(`UPDATE source_packets SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  return getPacket(db, existing.id);
}

/**
 * Link scrapes to a packet via the junction table.
 */
export function linkScrapesToPacket(
  db: Database.Database,
  packetId: string,
  scrapeIds: string[],
  role: "primary" | "secondary" | "supporting" = "primary",
): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO packet_scrapes (packet_id, scrape_id, role)
    VALUES (?, ?, ?)
  `);

  for (const scrapeId of scrapeIds) {
    stmt.run(packetId, scrapeId, role);
  }
}

/**
 * Get all scrape IDs linked to a packet.
 */
export function getPacketScrapeIds(db: Database.Database, packetId: string): string[] {
  const rows = db.prepare(
    "SELECT scrape_id FROM packet_scrapes WHERE packet_id = ? ORDER BY role, created_at"
  ).all(packetId) as { scrape_id: string }[];
  return rows.map(r => r.scrape_id);
}

/**
 * Get the packet associated with a scrape (if any).
 */
export function getPacketForScrape(db: Database.Database, scrapeId: string): SourcePacket | null {
  const row = db.prepare(`
    SELECT sp.* FROM source_packets sp
    JOIN packet_scrapes ps ON ps.packet_id = sp.id
    WHERE ps.scrape_id = ?
    LIMIT 1
  `).get(scrapeId) as SourcePacketRow | undefined;
  return row ? rowToPacket(row) : null;
}

/**
 * Search packets via FTS5.
 */
export function searchPackets(db: Database.Database, query: string, limit = 10): SourcePacket[] {
  const terms = query.split(/\s+/).filter(Boolean).map(t => t.replace(/[*()":^$]/g, "")).filter(Boolean);
  if (terms.length === 0) return [];

  const ftsQuery = terms.join(" ");

  try {
    const rows = db.prepare(`
      SELECT sp.* FROM source_packets_fts fts
      JOIN source_packets sp ON fts.rowid = sp.rowid
      WHERE source_packets_fts MATCH ?
      ORDER BY bm25(source_packets_fts)
      LIMIT ?
    `).all(ftsQuery, limit) as SourcePacketRow[];
    return rows.map(rowToPacket);
  } catch (err) {
    logger.debug({ error: err, query }, "Source packets FTS search failed");
    return [];
  }
}

/**
 * Promote a packet to an idea. Returns the new idea ID.
 * This is the key transition point — ideas only exist after explicit promotion.
 */
export function promotePacket(
  db: Database.Database,
  packetId: string,
  overrides?: {
    title?: string;
    content?: string;
    tags?: string[];
    status?: string;
  },
): { packetId: string; ideaId: string } | null {
  const packet = getPacket(db, packetId);
  if (!packet) {
    logger.warn({ packetId }, "Cannot promote: packet not found");
    return null;
  }

  if (packet.status === "promoted") {
    logger.info({ packetId, ideaId: packet.promotedIdeaId }, "Packet already promoted");
    return packet.promotedIdeaId
      ? { packetId, ideaId: packet.promotedIdeaId }
      : null;
  }

  // Build idea from packet + enrichment
  const enrichment = packet.enrichment;
  const candidate = enrichment?.candidate;

  const now = new Date();
  const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
  const titleText = overrides?.title ?? candidate?.title ?? packet.title ?? "Untitled";
  const slug = titleText.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const ideaId = `synth_${now.toISOString().slice(5, 10).replace("-", "")}_${slug}`;

  const content = overrides?.content
    ?? (candidate ? `${candidate.content}\n\n**Why this matters:** ${candidate.relevance}` : packet.rawContent ?? "");

  const tags = overrides?.tags ?? candidate?.tags ?? packet.metadata?.extractedTopics ?? [];

  const context = [
    candidate?.confidence !== undefined ? `Confidence: ${candidate.confidence.toFixed(2)}` : null,
    enrichment?.critique?.passed !== undefined ? `Critique: ${enrichment.critique.passed ? "passed" : "rejected"}` : null,
    packet.metadata?.scrapeIds?.length ? `Provenance: ${packet.metadata.scrapeIds.join(", ")}` : null,
  ].filter(Boolean).join(" | ");

  // Use smartSaveIdea for dedup at promotion-time
  const { smartSaveIdea } = require("./smart-save.js");

  const parsed = {
    id: ideaId,
    title: titleText,
    status: overrides?.status ?? "review",
    source: candidate?.source ?? packet.sourceType,
    content,
    context: context || undefined,
    link: candidate?.link || packet.primaryUrl || undefined,
    tags: [...tags, "synthesized"],
    timestamp,
    enrichment: enrichment ? JSON.stringify(enrichment) : undefined,
  };

  const saveResult = smartSaveIdea(parsed, db);
  const finalIdeaId = saveResult.ideaId;

  // Update packet status
  db.prepare(`
    UPDATE source_packets SET
      status = 'promoted',
      promoted_idea_id = ?,
      promoted_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(finalIdeaId, packet.id);

  // Link idea back to packet
  try {
    db.prepare("UPDATE ideas SET source_packet_id = ? WHERE id = ?").run(packet.id, finalIdeaId);
  } catch { /* column may not exist in older schemas — non-fatal */ }

  logger.info({ packetId, ideaId: finalIdeaId, title: titleText, action: saveResult.action }, "Packet promoted to idea");
  return { packetId, ideaId: finalIdeaId };
}

/**
 * Count packets by status.
 */
export function countByStatus(db: Database.Database): Record<PacketStatus, number> {
  const rows = db.prepare(
    "SELECT status, COUNT(*) as count FROM source_packets GROUP BY status"
  ).all() as { status: string; count: number }[];

  const counts: Record<string, number> = {
    raw: 0, queued: 0, review: 0, approved: 0, promoted: 0, archived: 0, discarded: 0,
  };
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts as Record<PacketStatus, number>;
}
