/**
 * Job posting deduplication — catches same-company/title reposts,
 * JD text similarity, and cross-platform duplicates.
 */

// @ts-ignore
import type Database from "better-sqlite3";

interface DedupResult {
  isDuplicate: boolean;
  matchedJobId?: string;
  reason?: string;
}

/**
 * Check if a job posting is a duplicate of an existing one.
 */
export function isDuplicatePosting(
  newJob: { company: string; title: string; location?: string; description?: string; url?: string },
  db: Database.Database
): DedupResult {
  // 1. Exact URL match
  if (newJob.url) {
    const urlMatch = db.prepare(
      "SELECT id FROM job_postings WHERE url = ?"
    ).get(newJob.url) as { id: string } | undefined;
    if (urlMatch) {
      return { isDuplicate: true, matchedJobId: urlMatch.id, reason: "Same URL" };
    }
  }

  // 2. Same company + same title + same location
  const companyTitleMatch = db.prepare(`
    SELECT id FROM job_postings
    WHERE LOWER(company) = LOWER(?) AND LOWER(title) = LOWER(?)
      AND (LOWER(COALESCE(location, '')) = LOWER(COALESCE(?, '')) OR location IS NULL OR ? IS NULL)
    LIMIT 1
  `).get(newJob.company, newJob.title, newJob.location ?? null, newJob.location ?? null) as { id: string } | undefined;

  if (companyTitleMatch) {
    return { isDuplicate: true, matchedJobId: companyTitleMatch.id, reason: "Same company + title + location" };
  }

  // 3. JD text similarity (Jaccard on bigrams)
  if (newJob.description && newJob.description.length > 100) {
    const newBigrams = getBigrams(newJob.description);
    const recentJobs = db.prepare(`
      SELECT id, description FROM job_postings
      WHERE LOWER(company) = LOWER(?) AND description IS NOT NULL
        AND datetime(discovered_at) > datetime('now', '-30 days')
    `).all(newJob.company) as Array<{ id: string; description: string }>;

    for (const existing of recentJobs) {
      const existingBigrams = getBigrams(existing.description);
      const similarity = jaccardSimilarity(newBigrams, existingBigrams);
      if (similarity > 0.85) {
        return { isDuplicate: true, matchedJobId: existing.id, reason: `JD similarity: ${(similarity * 100).toFixed(0)}%` };
      }
    }
  }

  return { isDuplicate: false };
}

function getBigrams(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const bigrams = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  return bigrams;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
