/**
 * Idea Deduplication System v3
 *
 * 3-tier deduplication:
 * - TIER 1: URL canonicalization (exact match)
 * - TIER 2: Repo ID extraction (owner/repo match)
 * - TIER 3: Semantic fingerprinting (title similarity)
 *
 * Changes from v2:
 * - Includes archived ideas in dedup (deletes them too)
 * - Uses canonical URLs instead of raw URLs
 * - Uses semantic fingerprints for title matching
 * - Keeper strategy: highest status wins
 * - LLM budget: max 5 calls per run
 * - Same URL different tags: merge them
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { logger } from "../utils/logger.js";
import { executeGeminiWithFallback } from "../executors/opencode-cli.js";
import { GEMINI_CLI_FLASH_MODEL } from "../executors/gemini-cli.js";
import { loadIdeasFromDir, type ParsedIdea } from "./parser.js";
import * as dao from "./dao.js";
import { canonicalizeUrl, extractRepoId } from "./canonical-url.js";
import { createFingerprint, fingerprintSimilarity } from "./fingerprint.js";
import { storeJobArtifact } from "../scheduler/jobs/artifact-store.js";
import type Database from "better-sqlite3";
import { PATHS } from "../config/paths.js";

const DENY_HISTORY_FILE = PATHS.denyHistory;

// Max LLM calls per batch run
const MAX_LLM_CALLS = 5;

type IdeaStatus = "draft" | "review" | "discussion" | "planning" | "execution" | "archived";

interface Idea {
  id: string;
  timestamp: string;
  source: string;
  status: IdeaStatus;
  title: string;
  content: string;
  context?: string;
  link?: string;
  notes?: string;
  tags?: string[];
  // Computed fields for dedup
  canonicalUrl?: string;
  repoId?: string | null;
}

interface DedupResult {
  deleted: number;
  kept: number;
  urlMatches: number;
  repoMatches: number;
  semanticMatches: number;
  llmMatches: number;
  blocklistAdded: string[];
}

/**
 * Status priority for keeper selection (higher = more important to keep)
 * User's preference: highest status wins
 */
function statusPriority(status: IdeaStatus): number {
  switch (status) {
    case "execution": return 5;
    case "planning": return 4;
    case "discussion": return 3;
    case "review": return 2;
    case "draft": return 1;
    case "archived": return 0;
    default: return 0;
  }
}

/**
 * Content score for tiebreaker (more content = more valuable)
 */
function contentScore(idea: Idea): number {
  return (idea.content?.length ?? 0) +
         (idea.context?.length ?? 0) +
         (idea.notes?.length ?? 0);
}

/**
 * Select the keeper from a group of duplicate ideas
 * Strategy: highest status wins, then most content
 */
function selectKeeper(ideas: Idea[]): Idea {
  return ideas.reduce((best, cur) => {
    const bestPriority = statusPriority(best.status);
    const curPriority = statusPriority(cur.status);

    if (curPriority > bestPriority) return cur;
    if (curPriority < bestPriority) return best;

    // Same priority: prefer more content
    return contentScore(cur) > contentScore(best) ? cur : best;
  });
}

/**
 * Update deny-history.md blocklist with repos that had duplicates
 */
function updateDenyHistoryBlocklist(repos: string[]): string[] {
  if (repos.length === 0) return [];
  if (!existsSync(DENY_HISTORY_FILE)) return [];

  const content = readFileSync(DENY_HISTORY_FILE, "utf-8");
  const alreadyTrackingHeader = "### Already Tracking (Skip Duplicates)";
  if (!content.includes(alreadyTrackingHeader)) {
    return [];
  }

  const existing = new Set(
    content
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.replace(/^- /, "").trim().toLowerCase())
  );

  const additions = repos
    .filter((r) => {
      const repoName = r.split("/")[1] ?? r;
      return !existing.has(repoName.toLowerCase()) &&
             !existing.has(r.toLowerCase());
    })
    .map((r) => {
      const repoName = r.split("/")[1] ?? r;
      return `${repoName} (${r})`;
    });

  if (additions.length === 0) return [];

  const updated = content.replace(
    alreadyTrackingHeader,
    `${alreadyTrackingHeader}\n${additions.map((r) => `- ${r}`).join("\n")}`
  );

  writeFileSync(DENY_HISTORY_FILE, updated, "utf-8");
  return additions;
}

/**
 * Use LLM to find semantic duplicates that local checks might miss
 * Only called for ambiguous cases, limited by MAX_LLM_CALLS
 */
async function findLLMDuplicates(
  ideas: Idea[],
  maxCalls: number
): Promise<{ groups: string[][]; callsUsed: number }> {
  if (ideas.length < 5 || maxCalls <= 0) {
    return { groups: [], callsUsed: 0 };
  }

  // Only send ideas that weren't already clustered
  const summaries = ideas.slice(0, 50).map((i) => ({
    id: i.id,
    status: i.status,
    title: i.title,
    link: i.link ?? "",
    repo: i.repoId ?? "",
  }));

  const prompt = `Identify duplicate idea groups. These are ideas about the same project/topic.
Only return groups when you are highly confident. Look for:
- Same GitHub repo with different titles
- Same project mentioned differently
- Obvious semantic duplicates

Ideas:
${JSON.stringify(summaries, null, 2)}

Return ONLY valid JSON (no markdown):
{"groups": [["id1","id2"], ["id3","id4"]]}
If none found: {"groups":[]}`;

  const parseGroups = (output: string): string[][] => {
    try {
      // Try direct JSON parse first
      const directParsed = JSON.parse(output.trim());
      if (Array.isArray(directParsed.groups)) return directParsed.groups;
    } catch {
      // Try extracting from markdown code block
      const match = output.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
      if (match?.[1]) {
        try {
          const parsed = JSON.parse(match[1]);
          return Array.isArray(parsed.groups) ? parsed.groups : [];
        } catch {
          return [];
        }
      }
    }
    return [];
  };

  try {
    const result = await executeGeminiWithFallback(prompt, "", {
      model: GEMINI_CLI_FLASH_MODEL,
      sandbox: true,
      timeout: 120000,
    });

    if (result.exitCode === 0) {
      const groups = parseGroups(result.output);
      logger.info({ groupCount: groups.length }, "LLM found duplicate groups");
      return { groups, callsUsed: 1 };
    }

    logger.warn({ exitCode: result.exitCode }, "Gemini dedup returned non-zero exit");
  } catch (error) {
    logger.warn({ error }, "LLM dedup failed");
  }

  return { groups: [], callsUsed: 1 };
}

/**
 * Main deduplication function for file-based ideas (~/memory/ideas/)
 * Deletes duplicate files, keeping the "best" version of each idea
 */
export async function dedupeIdeasDir(db?: Database.Database, jobRunId?: number): Promise<DedupResult> {
  if (!db) {
    logger.warn("dedupeIdeasDir: DB unavailable, using file-only path (deletions invisible to DB)");
  }
  const ideas = db ? dao.getAllIdeas(db) : loadIdeasFromDir();

  if (ideas.length === 0) {
    return {
      deleted: 0, kept: 0, urlMatches: 0, repoMatches: 0,
      semanticMatches: 0, llmMatches: 0, blocklistAdded: []
    };
  }

  logger.info({ total: ideas.length }, "Starting 3-tier idea deduplication");

  // Convert ParsedIdea to internal format with computed fields
  const ideasForDedup: Idea[] = ideas.map((i) => {
    const canonical = i.link ? canonicalizeUrl(i.link) : null;
    const repoFromLink = canonical?.repoId ?? null;
    const repoFromContent = extractRepoId(i.content) ?? extractRepoId(i.title);

    return {
      id: i.id,
      timestamp: i.timestamp,
      source: i.source,
      status: i.status as IdeaStatus,
      title: i.title,
      content: i.content,
      context: i.context,
      link: i.link,
      notes: i.notes,
      tags: i.tags,
      canonicalUrl: canonical?.canonical,
      repoId: repoFromLink ?? repoFromContent,
    };
  });

  // Build ID to ParsedIdea map for file path access
  const idToIdea = new Map<string, ParsedIdea>();
  ideas.forEach((i) => idToIdea.set(i.id, i));

  // Union-find for grouping duplicates
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return p;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  let urlMatches = 0;
  let repoMatches = 0;
  let semanticMatches = 0;
  let llmMatches = 0;

  // =========================================
  // TIER 1: URL Canonicalization Clustering
  // =========================================
  const urlClusters = new Map<string, Idea[]>();
  for (const idea of ideasForDedup) {
    if (!idea.canonicalUrl) continue;
    const list = urlClusters.get(idea.canonicalUrl) ?? [];
    list.push(idea);
    urlClusters.set(idea.canonicalUrl, list);
  }

  for (const list of urlClusters.values()) {
    if (list.length < 2) continue;
    const primary = list[0]!;
    for (let i = 1; i < list.length; i++) {
      union(primary.id, list[i]!.id);
      urlMatches++;
    }
  }
  logger.info({ urlMatches }, "TIER 1: URL matches found");

  // =========================================
  // TIER 2: Repo ID Clustering
  // =========================================
  const repoClusters = new Map<string, Idea[]>();
  for (const idea of ideasForDedup) {
    if (!idea.repoId) continue;
    const normalizedRepo = idea.repoId.toLowerCase();
    const list = repoClusters.get(normalizedRepo) ?? [];
    list.push(idea);
    repoClusters.set(normalizedRepo, list);
  }

  const blocklistRepos: string[] = [];
  for (const [repo, list] of repoClusters.entries()) {
    if (list.length < 2) continue;
    const primary = list[0]!;
    for (let i = 1; i < list.length; i++) {
      // Only count if not already unioned by URL
      if (find(primary.id) !== find(list[i]!.id)) {
        repoMatches++;
      }
      union(primary.id, list[i]!.id);
    }
    blocklistRepos.push(repo);
  }
  logger.info({ repoMatches }, "TIER 2: Repo ID matches found");

  // =========================================
  // TIER 3: Semantic Fingerprint Clustering
  // =========================================
  const fingerprints = ideasForDedup.map((idea) => ({
    idea,
    fp: createFingerprint(idea.title),
  }));

  // Group by primary entity first for efficiency
  const entityGroups = new Map<string, typeof fingerprints>();
  for (const item of fingerprints) {
    if (!item.fp.primaryEntity) continue;
    const list = entityGroups.get(item.fp.primaryEntity) ?? [];
    list.push(item);
    entityGroups.set(item.fp.primaryEntity, list);
  }

  // Within each entity group, check similarity
  for (const group of entityGroups.values()) {
    if (group.length < 2) continue;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;

        // Skip if already in same group
        if (find(a.idea.id) === find(b.idea.id)) continue;

        const sim = fingerprintSimilarity(a.fp, b.fp);
        if (sim >= 0.7) {  // Slightly lower threshold for same primary entity
          union(a.idea.id, b.idea.id);
          semanticMatches++;
          logger.debug(
            { a: a.idea.title, b: b.idea.title, sim },
            "TIER 3: Semantic match"
          );
        }
      }
    }
  }
  logger.info({ semanticMatches }, "TIER 3: Semantic matches found");

  // =========================================
  // TIER 3.5: LLM Verification (limited)
  // =========================================
  // Only run LLM on ideas not yet clustered
  const unclustered = ideasForDedup.filter((idea) => {
    const root = find(idea.id);
    // Count how many ideas share this root
    const groupSize = ideasForDedup.filter((i) => find(i.id) === root).length;
    return groupSize === 1;
  });

  if (unclustered.length >= 10) {
    const { groups, callsUsed } = await findLLMDuplicates(unclustered, MAX_LLM_CALLS);
    for (const group of groups) {
      if (!Array.isArray(group) || group.length < 2) continue;
      for (let i = 1; i < group.length; i++) {
        const id0 = group[0]!;
        const idI = group[i]!;
        if (find(id0) !== find(idI)) {
          union(id0, idI);
          llmMatches++;
        }
      }
    }
    logger.info({ llmMatches, callsUsed }, "TIER 3.5: LLM matches found");
  }

  // =========================================
  // Build final groups and select keepers
  // =========================================
  const groups = new Map<string, Idea[]>();
  for (const idea of ideasForDedup) {
    const root = find(idea.id);
    const list = groups.get(root) ?? [];
    list.push(idea);
    groups.set(root, list);
  }

  const idsToDelete: string[] = [];

  for (const list of groups.values()) {
    if (list.length < 2) continue;

    // Select keeper: highest status wins
    const keeper = selectKeeper(list);

    // All others get deleted (INCLUDING archived)
    for (const candidate of list) {
      if (candidate.id === keeper.id) continue;
      idsToDelete.push(candidate.id);
    }
  }

  // =========================================
  // Store tombstone journal (before deletion, for recovery)
  // =========================================
  if (db && jobRunId && idsToDelete.length > 0) {
    const tombstoneEntries = idsToDelete.map(id => {
      const idea = idToIdea.get(id);
      const root = find(id);
      const keeperIdea = idToIdea.get(
        [...groups.get(root)!].find(g => !idsToDelete.includes(g.id))?.id ?? root
      );
      return {
        deletedId: id,
        deletedTitle: idea?.title ?? "unknown",
        deletedFilePath: idea?.filePath ?? "unknown",
        deletedContent: idea?.filePath && existsSync(idea.filePath)
          ? readFileSync(idea.filePath, "utf-8")
          : null,
        keeperId: keeperIdea?.id ?? root,
        keeperTitle: keeperIdea?.title ?? "unknown",
      };
    });
    storeJobArtifact(db, jobRunId, "idea-dedup", "tombstone-journal", "json",
      JSON.stringify(tombstoneEntries),
      { deleteCount: idsToDelete.length, urlMatches, repoMatches, semanticMatches, llmMatches });
  }

  // =========================================
  // Delete duplicate files
  // =========================================
  let deleted = 0;
  for (const id of idsToDelete) {
    const idea = idToIdea.get(id);
    if (!idea?.filePath) continue;

    try {
      if (db) {
        dao.deleteIdea(db, id);
      } else if (existsSync(idea.filePath)) {
        unlinkSync(idea.filePath);
      }
      logger.info({ id, title: idea.title, filePath: idea.filePath }, "Deleted duplicate");
      deleted++;
    } catch (error) {
      logger.error({ id, error }, "Failed to delete duplicate idea");
    }
  }

  // Update blocklist with repos that had duplicates
  const blocklistAdded = updateDenyHistoryBlocklist(blocklistRepos);

  const kept = ideas.length - deleted;
  logger.info({ deleted, kept, urlMatches, repoMatches, semanticMatches, llmMatches },
    "Deduplication complete");

  return {
    deleted,
    kept,
    urlMatches,
    repoMatches,
    semanticMatches,
    llmMatches,
    blocklistAdded
  };
}

// Legacy export for backwards compatibility
export async function dedupeIdeasFile(): Promise<{ merged: number; archived: number; blocklistAdded: string[] }> {
  // Redirect to new implementation
  const result = await dedupeIdeasDir();
  return {
    merged: result.deleted,
    archived: 0,  // We now delete instead of archive
    blocklistAdded: result.blocklistAdded,
  };
}
