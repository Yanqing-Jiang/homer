/**
 * Smart Idea Save — dedup-at-write with enhancement
 *
 * Before writing any idea, checks existing ideas.
 * If similar exists: enhance it with new context.
 * If nothing new to add: skip.
 * Never creates duplicates.
 *
 * Uses DAO (DB) when db is provided, falls back to file I/O otherwise.
 */

import { loadIdeasFromDir, saveIdeaFile, type ParsedIdea } from "./parser.js";
import { createFingerprint, fingerprintSimilarity } from "./fingerprint.js";
import { canonicalizeUrl } from "./canonical-url.js";
import { logger } from "../utils/logger.js";
import type Database from "better-sqlite3";
import * as dao from "./dao.js";

export interface SmartSaveResult {
  action: "created" | "enhanced" | "skipped";
  ideaId: string;
  title: string;
  matchedExisting?: string;
}

/**
 * Smart save with DB-backed dedup (preferred path).
 * Falls back to file-based if db is not provided.
 */
export function smartSaveIdea(newIdea: ParsedIdea, db?: Database.Database): SmartSaveResult {
  if (db) {
    return smartSaveIdeaDB(db, newIdea);
  }
  return smartSaveIdeaFiles(newIdea);
}

function smartSaveIdeaDB(db: Database.Database, newIdea: ParsedIdea): SmartSaveResult {
  // TIER 1: URL match via canonical_url index
  if (newIdea.link) {
    const match = dao.findByCanonicalUrl(db, newIdea.link);
    if (match) return enhanceOrSkipDB(db, match, newIdea);
  }

  // TIER 2: Title fingerprint similarity
  const existing = dao.getAllIdeas(db);
  const newFp = createFingerprint(newIdea.title);
  for (const e of existing) {
    const sim = fingerprintSimilarity(newFp, createFingerprint(e.title));
    if (sim >= 0.7) return enhanceOrSkipDB(db, e, newIdea);
  }

  // No match — save new
  dao.createIdea(db, newIdea);
  return { action: "created", ideaId: newIdea.id, title: newIdea.title };
}

function enhanceOrSkipDB(db: Database.Database, existing: ParsedIdea, incoming: ParsedIdea): SmartSaveResult {
  const result = computeEnhancement(existing, incoming);
  if (result.skip) {
    return {
      action: "skipped",
      ideaId: existing.id,
      title: incoming.title,
      matchedExisting: existing.title,
    };
  }

  // Merge enrichment JSON when enhancing
  let mergedEnrichment = existing.enrichment;
  if (incoming.enrichment) {
    try {
      const existingEnr = existing.enrichment ? JSON.parse(existing.enrichment) : {};
      const incomingEnr = JSON.parse(incoming.enrichment);
      // Incoming enrichment wins for each top-level key, preserving existing keys not in incoming
      mergedEnrichment = JSON.stringify({ ...existingEnr, ...incomingEnr });
    } catch {
      // If parse fails, prefer incoming
      mergedEnrichment = incoming.enrichment;
    }
  }

  dao.updateIdea(db, existing.id, {
    content: existing.content + result.enhancement,
    tags: [...new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])])],
    enrichment: mergedEnrichment,
  });

  return {
    action: "enhanced",
    ideaId: existing.id,
    title: incoming.title,
    matchedExisting: existing.title,
  };
}

// ============================================
// File-based fallback (legacy path)
// ============================================

function smartSaveIdeaFiles(newIdea: ParsedIdea): SmartSaveResult {
  logger.warn({ ideaId: newIdea.id }, "smartSaveIdea: DB unavailable, using file-only path (mutations invisible to DB)");
  const existing = loadIdeasFromDir();

  // TIER 1: URL match
  if (newIdea.link) {
    const canonical = canonicalizeUrl(newIdea.link);
    const urlMatch = existing.find((e) => {
      if (!e.link) return false;
      return canonicalizeUrl(e.link).canonical === canonical.canonical;
    });
    if (urlMatch) return enhanceOrSkipFiles(urlMatch, newIdea);
  }

  // TIER 2: Title fingerprint similarity
  const newFp = createFingerprint(newIdea.title);
  for (const e of existing) {
    const sim = fingerprintSimilarity(newFp, createFingerprint(e.title));
    if (sim >= 0.7) return enhanceOrSkipFiles(e, newIdea);
  }

  // No match — save new
  saveIdeaFile(newIdea);
  return { action: "created", ideaId: newIdea.id, title: newIdea.title };
}

function enhanceOrSkipFiles(existing: ParsedIdea, incoming: ParsedIdea): SmartSaveResult {
  const result = computeEnhancement(existing, incoming);
  if (result.skip) {
    return {
      action: "skipped",
      ideaId: existing.id,
      title: incoming.title,
      matchedExisting: existing.title,
    };
  }

  const enhanced: ParsedIdea = {
    ...existing,
    content: existing.content + result.enhancement,
    tags: [...new Set([...(existing.tags ?? []), ...(incoming.tags ?? [])])],
  };
  saveIdeaFile(enhanced);
  return {
    action: "enhanced",
    ideaId: existing.id,
    title: incoming.title,
    matchedExisting: existing.title,
  };
}

// ============================================
// Shared logic
// ============================================

function computeEnhancement(
  existing: ParsedIdea,
  incoming: ParsedIdea
): { skip: boolean; enhancement: string } {
  const existingText = `${existing.content} ${existing.context ?? ""} ${existing.notes ?? ""}`;
  const incomingText = `${incoming.content} ${incoming.context ?? ""}`;

  const incomingWords = new Set(
    incomingText.toLowerCase().split(/\s+/).filter((w) => w.length > 4)
  );
  const existingWords = new Set(
    existingText.toLowerCase().split(/\s+/).filter((w) => w.length > 4)
  );
  const overlap = [...incomingWords].filter((w) => existingWords.has(w)).length;
  const overlapRatio = incomingWords.size > 0 ? overlap / incomingWords.size : 1;

  if (overlapRatio > 0.7) {
    logger.info(
      { existing: existing.title, incoming: incoming.title },
      "Smart-save: skipped redundant"
    );
    return { skip: true, enhancement: "" };
  }

  const enhancement = `\n\n---\n**Enhanced** (${incoming.timestamp}, source: ${incoming.source}):\n${incoming.content}`;
  return { skip: false, enhancement };
}
