/**
 * Smart Idea Save — dedup-at-write with enhancement
 *
 * Before writing any idea, checks existing ideas.
 * If similar exists: enhance it with new context.
 * If nothing new to add: skip.
 * Never creates duplicates.
 */

import { loadIdeasFromDir, saveIdeaFile, type ParsedIdea } from "./parser.js";
import { createFingerprint, fingerprintSimilarity } from "./fingerprint.js";
import { canonicalizeUrl } from "./canonical-url.js";
import { logger } from "../utils/logger.js";

export interface SmartSaveResult {
  action: "created" | "enhanced" | "skipped";
  ideaId: string;
  title: string;
  matchedExisting?: string;
}

export function smartSaveIdea(newIdea: ParsedIdea): SmartSaveResult {
  const existing = loadIdeasFromDir();

  // TIER 1: URL match
  if (newIdea.link) {
    const canonical = canonicalizeUrl(newIdea.link);
    const urlMatch = existing.find((e) => {
      if (!e.link) return false;
      return canonicalizeUrl(e.link).canonical === canonical.canonical;
    });
    if (urlMatch) return enhanceOrSkip(urlMatch, newIdea);
  }

  // TIER 2: Title fingerprint similarity
  const newFp = createFingerprint(newIdea.title);
  for (const e of existing) {
    const sim = fingerprintSimilarity(newFp, createFingerprint(e.title));
    if (sim >= 0.7) return enhanceOrSkip(e, newIdea);
  }

  // No match — save new
  saveIdeaFile(newIdea);
  return { action: "created", ideaId: newIdea.id, title: newIdea.title };
}

function enhanceOrSkip(existing: ParsedIdea, incoming: ParsedIdea): SmartSaveResult {
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
    return {
      action: "skipped",
      ideaId: existing.id,
      title: incoming.title,
      matchedExisting: existing.title,
    };
  }

  // Has new info — enhance existing idea
  const enhancement = `\n\n---\n**Enhanced** (${incoming.timestamp}, source: ${incoming.source}):\n${incoming.content}`;
  const enhanced: ParsedIdea = {
    ...existing,
    content: existing.content + enhancement,
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
