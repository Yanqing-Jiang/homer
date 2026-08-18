/**
 * Persistence for the job scanner: postings, repost fingerprints, run stats,
 * and email log. All tables created by migration 123_job_scanner.sql.
 */

// @ts-ignore
import type Database from "better-sqlite3";
import type { NormalizedJob, StoredPosting } from "./types.js";
import { fingerprintJob, digestKeyFor } from "./filters.js";

/** Upsert a discovered job. Returns true when the posting id is new. */
export function upsertPosting(db: Database.Database, job: NormalizedJob): boolean {
  const existing = db
    .prepare("SELECT id FROM job_scan_postings WHERE id = ?")
    .get(job.id) as { id: string } | undefined;

  if (existing) {
    db.prepare("UPDATE job_scan_postings SET last_seen_at = datetime('now') WHERE id = ?").run(job.id);
    return false;
  }

  const fingerprint = fingerprintJob(job);
  // Repost history: count DISTINCT posting ids that shared this fingerprint
  // before this one. A prior id with the same company+title+state means the
  // employer re-cut the requisition — a ghost/repost signal.
  const fpRow = db
    .prepare("SELECT times_seen FROM job_scan_fingerprints WHERE fingerprint = ?")
    .get(fingerprint) as { times_seen: number } | undefined;
  const repostCount = fpRow?.times_seen ?? 0;

  db.prepare(
    `INSERT INTO job_scan_fingerprints (fingerprint, company, title, times_seen)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(fingerprint) DO UPDATE SET
       times_seen = times_seen + 1,
       last_seen_at = datetime('now')`,
  ).run(fingerprint, job.company, job.title);

  db.prepare(
    `INSERT INTO job_scan_postings (
       id, discovery_source, ats_source, board_token, requisition_id, external_id,
       title, company, apply_url, location, workplace_type, role_type, seniority,
       yearly_min_comp, yearly_max_comp, comp_transparent, publish_date,
       fingerprint, repost_count, status, raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
  ).run(
    job.id,
    job.discoverySource,
    job.atsSource,
    job.boardToken,
    job.requisitionId,
    job.externalId,
    job.title,
    job.company,
    job.applyUrl,
    job.location,
    job.workplaceType,
    job.roleType,
    job.seniority,
    job.yearlyMinComp,
    job.yearlyMaxComp,
    job.compTransparent ? 1 : 0,
    job.publishDate,
    fingerprint,
    repostCount,
    JSON.stringify(job.raw).slice(0, 100_000),
  );
  return true;
}

export function markFiltered(db: Database.Database, id: string, reason: string): void {
  db.prepare(
    "UPDATE job_scan_postings SET status = 'filtered_out', filter_reason = ? WHERE id = ?",
  ).run(reason.slice(0, 300), id);
}

export function setCategory(db: Database.Database, id: string, category: string, weight: number): void {
  db.prepare("UPDATE job_scan_postings SET category = ?, category_weight = ? WHERE id = ?").run(
    category,
    weight,
    id,
  );
}

export function setVerification(
  db: Database.Database,
  id: string,
  live: boolean | null,
  method: string,
): void {
  db.prepare(
    `UPDATE job_scan_postings
     SET ats_verified_at = datetime('now'), ats_live = ?, verify_method = ?,
         status = CASE WHEN ? = 0 THEN 'expired' ELSE status END
     WHERE id = ?`,
  ).run(live === null ? null : live ? 1 : 0, method, live === false ? 0 : 1, id);
}

export function setFitScore(
  db: Database.Database,
  id: string,
  fit: number,
  rationale: string,
): void {
  db.prepare(
    "UPDATE job_scan_postings SET fit_score = ?, fit_rationale = ?, status = 'scored' WHERE id = ?",
  ).run(fit, rationale.slice(0, 500), id);
}

export function setRankScore(db: Database.Database, id: string, rank: number): void {
  db.prepare("UPDATE job_scan_postings SET rank_score = ? WHERE id = ?").run(rank, id);
}

/**
 * Fresh rules-passing postings that still lack a real LLM fit score
 * (never scored, or carrying a heuristic fallback score). Self-healing:
 * a scoring outage in one run gets repaired by the next.
 */
export function getPostingsNeedingScore(
  db: Database.Database,
  freshHours: number,
  cap: number,
): { id: string; raw_json: string }[] {
  return db
    .prepare(
      `SELECT id, raw_json FROM job_scan_postings
       WHERE first_seen_at >= datetime('now', ?)
         AND status IN ('new', 'scored')
         AND category IS NOT NULL
         AND (ats_live IS NULL OR ats_live = 1)
         AND (fit_score IS NULL OR fit_rationale LIKE '%heuristic%')
       ORDER BY category_weight DESC, first_seen_at DESC
       LIMIT ?`,
    )
    .all(`-${freshHours} hours`, cap) as { id: string; raw_json: string }[];
}

/** Scored, still-live postings first seen in the last `freshHours`, not yet
 * emailed. The publish-date clause also ages out stale postings already in the
 * backlog from before MAX_POSTING_AGE_DAYS existed as an ingest rule. */
export function getEmailCandidates(db: Database.Database, freshHours = 72): StoredPosting[] {
  return db
    .prepare(
      `SELECT * FROM job_scan_postings
       WHERE status = 'scored'
         AND emailed_at IS NULL
         AND (ats_live IS NULL OR ats_live = 1)
         AND first_seen_at >= datetime('now', ?)
         AND (publish_date IS NULL OR substr(publish_date, 1, 10) >= date('now', '-30 days'))
       ORDER BY rank_score DESC`,
    )
    .all(`-${freshHours} hours`) as StoredPosting[];
}

/** Digest keys of roles permanently suppressed (applied / rejected / dismissed). */
export function getDismissedKeys(db: Database.Database): Set<string> {
  const rows = db.prepare("SELECT digest_key FROM job_scan_dismissals").all() as { digest_key: string }[];
  return new Set(rows.map((r) => r.digest_key));
}

/** Permanently suppress a role from future digests. Idempotent. */
export function addDismissal(db: Database.Database, company: string, title: string, reason: string): string {
  const key = digestKeyFor(company, title);
  db.prepare(
    `INSERT INTO job_scan_dismissals (digest_key, company, title, reason) VALUES (?, ?, ?, ?)
     ON CONFLICT(digest_key) DO UPDATE SET reason = excluded.reason`,
  ).run(key, company, title, reason.slice(0, 300));
  return key;
}

/** Fingerprints of postings emailed in the last `days` — used to keep
 * re-cut requisitions of an already-surfaced role out of fresh digests. */
export function getRecentlyEmailedFingerprints(db: Database.Database, days = 7): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT fingerprint FROM job_scan_postings
       WHERE emailed_at >= datetime('now', ?) AND fingerprint IS NOT NULL`,
    )
    .all(`-${days} days`) as { fingerprint: string }[];
  return new Set(rows.map((r) => r.fingerprint));
}

export function markEmailed(db: Database.Database, ids: string[]): void {
  const stmt = db.prepare(
    "UPDATE job_scan_postings SET status = 'emailed', emailed_at = datetime('now') WHERE id = ?",
  );
  for (const id of ids) stmt.run(id);
}

export function recordRun(
  db: Database.Database,
  stats: {
    discovered: number;
    newJobs: number;
    rulesPassed: number;
    verifiedLive: number;
    scored: number;
    emailed: number;
    emailStatus: string;
    errors: string[];
    durationMs: number;
  },
): void {
  db.prepare(
    `INSERT INTO job_scan_runs
       (discovered, new_jobs, rules_passed, verified_live, scored, emailed, email_status, errors, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stats.discovered,
    stats.newJobs,
    stats.rulesPassed,
    stats.verifiedLive,
    stats.scored,
    stats.emailed,
    stats.emailStatus,
    stats.errors.length > 0 ? JSON.stringify(stats.errors).slice(0, 2_000) : null,
    stats.durationMs,
  );
}

export function recordEmail(
  db: Database.Database,
  recipient: string,
  subject: string,
  jobIds: string[],
  gmailMessageId: string | null,
  status: string,
): void {
  db.prepare(
    "INSERT INTO job_scan_emails (recipient, subject, job_ids, gmail_message_id, status) VALUES (?, ?, ?, ?, ?)",
  ).run(recipient, subject, JSON.stringify(jobIds), gmailMessageId, status.slice(0, 300));
}
