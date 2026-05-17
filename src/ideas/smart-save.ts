/**
 * Smart Idea Save — dedup-at-write with enhancement
 *
 * Before writing any idea, checks existing ideas via DAO.
 * If similar exists: enhance it with new context.
 * If nothing new to add: skip.
 * Never creates duplicates.
 */

import { type ParsedIdea } from "./parser.js";
import { createFingerprint, fingerprintSimilarity } from "./fingerprint.js";
import { logger } from "../utils/logger.js";
// @ts-ignore
import type Database from "better-sqlite3";
import * as dao from "./dao.js";

export interface SmartSaveResult {
  action: "created" | "enhanced" | "skipped";
  ideaId: string;
  title: string;
  matchedExisting?: string;
}

/**
 * Smart save with DB-backed dedup. DB is required — every caller passes one.
 */
export function smartSaveIdea(newIdea: ParsedIdea, db: Database.Database): SmartSaveResult {
  // TIER 1: URL match via canonical_url index
  if (newIdea.link) {
    const match = dao.findByCanonicalUrl(db, newIdea.link);
    if (match) return enhanceOrSkip(db, match, newIdea);
  }

  // TIER 2: Title fingerprint similarity
  const existing = dao.getAllIdeas(db);
  const newFp = createFingerprint(newIdea.title);
  for (const e of existing) {
    const sim = fingerprintSimilarity(newFp, createFingerprint(e.title));
    if (sim >= 0.7) return enhanceOrSkip(db, e, newIdea);
  }

  // No match — save new
  dao.createIdea(db, newIdea);
  return { action: "created", ideaId: newIdea.id, title: newIdea.title };
}

function enhanceOrSkip(db: Database.Database, existing: ParsedIdea, incoming: ParsedIdea): SmartSaveResult {
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
