/**
 * Job Hunt Discovery — internal scheduler handler.
 * Scrapes LinkedIn via agent-browser, deduplicates, scores, queues qualified jobs.
 */

import { readFileSync } from "fs";
import { createHash } from "crypto";
// @ts-ignore
import type Database from "better-sqlite3";
import { scoreJob, type ScoringResult, detectWorkArrangement } from "../../job-hunt/scorer.js";
import { generateSearchUrls } from "../../job-hunt/taxonomy.js";
import { isDuplicatePosting } from "../../job-hunt/dedup.js";
import { RateLimiter } from "../../job-hunt/rate-limiter.js";
import { createLinkedInBreaker } from "../../job-hunt/circuit-breaker.js";
import { runBrowser, safeNavigate, safeEval } from "../../job-hunt/browser-utils.js";
import { logger } from "../../utils/logger.js";

const TARGET_ROLES_PATH = "/Users/yj/job-hunt/config/target-roles.md";
const MAX_JOBS_PER_RUN = 30;
const PAGE_DELAY_MS = 2000;
const QUALIFICATION_THRESHOLD = 0.55;

interface RawJob {
  url: string;
  title: string;
  company: string;
}

interface JobDetails {
  description: string;
  location: string;
  workArrangement: string;
  isEasyApply: boolean;
}

export async function runJobHuntDiscover(db: Database.Database): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const stats = { searched: 0, discovered: 0, scored: 0, qualified: 0, rejected: 0, skipped: 0, deduped: 0, errors: 0 };
  const limiter = new RateLimiter(db);
  const breaker = createLinkedInBreaker(db);

  try {
    return await breaker.execute(async () => {
      // 1. Get search URLs from config + taxonomy
      const searchUrls = getSearchUrls();
      const taxonomyUrls = generateSearchUrls(
        ["ml-engineer", "analytics-engineer", "ai-engineer", "data-platform",
         "data-science", "applied-science", "engineering-management",
         "staff-engineer", "principal-engineer", "analytics-manager", "data-science-manager"],
        "Seattle, WA",
        "past_week"
      );
      const allUrls = [...new Set([...searchUrls, ...taxonomyUrls.map((u) => u.url)])];

      logger.info({ urlCount: allUrls.length }, "Job hunt discovery starting");

      // 2. Connect to browser
      const connected = await runBrowser(["connect", "9222"]);
      if (!connected) {
        return { success: false, output: "", error: "Could not connect to browser on port 9222" };
      }

      // 3. For each search URL, extract and process jobs
      let totalNewJobs = 0;

      for (const url of allUrls) {
        if (totalNewJobs >= MAX_JOBS_PER_RUN) break;

        // Rate limit LinkedIn searches
        const { allowed } = await limiter.checkLimit("linkedin_search");
        if (!allowed) {
          logger.info("LinkedIn search rate limit reached, stopping");
          break;
        }

        try {
          stats.searched++;
          await limiter.recordAction("linkedin_search");
          const jobs = await extractJobList(url);
          logger.info({ url: url.slice(0, 80), jobCount: jobs.length }, "Extracted job list");

          for (const job of jobs) {
            if (totalNewJobs >= MAX_JOBS_PER_RUN) break;

            // Dedup check (URL + company/title/description)
            const dedup = isDuplicatePosting({ url: job.url, company: job.company, title: job.title }, db);
            if (dedup.isDuplicate) {
              stats.deduped++;
              continue;
            }

            // Get full JD
            const details = await getJobDetails(job.url);
            if (!details.description || details.description.length < 50) {
              logger.warn({ url: job.url }, "Could not extract JD");
              stats.errors++;
              continue;
            }

            // Full dedup with description
            const dedupFull = isDuplicatePosting(
              { url: job.url, company: job.company, title: job.title, description: details.description },
              db
            );
            if (dedupFull.isDuplicate) {
              stats.deduped++;
              continue;
            }

            // Insert into DB
            const jobId = `job_${createHash("sha256").update(job.url).digest("hex").slice(0, 12)}`;
            const arrangement = details.workArrangement
              ? details.workArrangement.toLowerCase()
              : detectWorkArrangement(details.description, details.location) ?? null;
            const appType = details.isEasyApply ? "easy_apply" : "external";
            db.prepare(`
              INSERT OR IGNORE INTO job_postings (id, url, company, title, location, description, work_arrangement, application_type, status, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovered', 'linkedin')
            `).run(jobId, job.url, job.company, job.title, details.location, details.description, arrangement, appType);

            stats.discovered++;
            totalNewJobs++;

            // Score the job
            const result = scoreJob({
              id: jobId,
              title: job.title,
              company: job.company,
              location: details.location,
              description: details.description,
            });

            // Update score + rejection reason
            const status = result.totalScore === 0 ? "rejected" : result.totalScore >= QUALIFICATION_THRESHOLD ? "queued_for_approval" : "matched";
            const rejectionReason = result.totalScore === 0
              ? (result.dealBreakers.length > 0 ? result.dealBreakers.join("; ") : result.disqualifyReasons.join("; "))
              : null;
            db.prepare(`
              UPDATE job_postings SET match_score = ?, match_analysis = ?, status = ?, rejection_reason = ?
              WHERE id = ?
            `).run(result.totalScore, result.matchAnalysis, status, rejectionReason, jobId);

            stats.scored++;
            if (result.totalScore === 0) {
              stats.rejected++;
            } else if (result.totalScore >= QUALIFICATION_THRESHOLD) {
              stats.qualified++;
              queueForApproval(db, jobId, result);
            }

            await sleep(PAGE_DELAY_MS);
          }
        } catch (err) {
          logger.warn({ url: url.slice(0, 80), error: err }, "Search URL failed");
          stats.errors++;
        }
      }

      // 4. Score any unscored existing jobs
      const unscored = db.prepare(
        "SELECT id, title, company, location, description FROM job_postings WHERE match_score IS NULL AND status = 'discovered'"
      ).all() as Array<{ id: string; title: string; company: string; location: string; description: string }>;

      for (const job of unscored) {
        const result = scoreJob({
          id: job.id,
          title: job.title,
          company: job.company,
          location: job.location,
          description: job.description,
        });
        const unscoredStatus = result.totalScore === 0 ? "rejected" : result.totalScore >= QUALIFICATION_THRESHOLD ? "queued_for_approval" : "matched";
        const unscoredRejection = result.totalScore === 0
          ? (result.dealBreakers.length > 0 ? result.dealBreakers.join("; ") : result.disqualifyReasons.join("; "))
          : null;
        db.prepare(`
          UPDATE job_postings SET match_score = ?, match_analysis = ?, status = ?, rejection_reason = ?
          WHERE id = ?
        `).run(result.totalScore, result.matchAnalysis, unscoredStatus, unscoredRejection, job.id);
        stats.scored++;
        if (result.totalScore >= QUALIFICATION_THRESHOLD) {
          stats.qualified++;
          queueForApproval(db, job.id, result);
        }
      }

      // 5. Record run in job_search_runs
      db.prepare(`
        INSERT INTO job_search_runs (id, source, query, filters, results_count, new_count, qualified_count)
        VALUES (?, 'linkedin', ?, ?, ?, ?, ?)
      `).run(
        `run_${Date.now()}`,
        JSON.stringify({ urls: allUrls.length }),
        JSON.stringify(stats),
        stats.discovered,
        stats.qualified - stats.rejected,
        stats.qualified
      );

      const output = formatSummary(db, stats);
      logger.info({ stats }, "Job hunt discovery completed");

      return { success: true, output };
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error }, "Job hunt discovery failed");
    return { success: false, output: "", error: msg };
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function getSearchUrls(): string[] {
  try {
    const content = readFileSync(TARGET_ROLES_PATH, "utf8");
    const urls: string[] = [];
    const matches = content.matchAll(/https:\/\/www\.linkedin\.com\/jobs\/search\/\S+/g);
    for (const match of matches) {
      urls.push(match[0].replace(/```/g, "").trim());
    }
    return [...new Set(urls)];
  } catch {
    return [];
  }
}

async function extractJobList(searchUrl: string): Promise<RawJob[]> {
  const navResult = await safeNavigate(searchUrl);
  logger.info({ searchUrl: searchUrl.slice(0, 80), navResult: navResult.slice(0, 100) }, "safeNavigate result");
  await sleep(5000);

  // Scroll to load more results
  for (let i = 0; i < 3; i++) {
    await runBrowser(["scroll", "down", "800"]);
    await sleep(2000);
  }

  // Debug: check current page title and link count
  const titleCheck = await safeEval("document.title + ' | links:' + document.querySelectorAll('a[href*=\"/jobs/view/\"]').length");
  logger.info({ titleCheck }, "Page state before extraction");

  // Return array directly — agent-browser eval wraps string returns in extra quotes,
  // so avoid JSON.stringify and let agent-browser serialize the array as plain JSON.
  const script = `Array.from(document.querySelectorAll('a')).filter(a => a.href.includes('/jobs/view/')).map(a => { const card = a.closest('.job-card-container, .jobs-search-results-list__list-item'); const company = card ? card.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, .job-card-container__company-name') : null; return { url: a.href.split('?')[0], title: a.innerText.split('\\n')[0].trim(), company: company ? company.innerText.trim() : 'Unknown' }; }).filter(j => j.title.length > 5 && j.url.includes('/view/'))`;

  try {
    const raw = await safeEval(script);
    logger.info({ rawLen: raw.length, rawHead: raw.slice(0, 100) }, "safeEval raw result");
    const jsonStart = raw.indexOf("[");
    if (jsonStart === -1) return [];
    return JSON.parse(raw.substring(jsonStart));
  } catch (err: any) {
    logger.warn({ error: err?.message }, "extractJobList parse failed");
    return [];
  }
}

async function getJobDetails(url: string): Promise<JobDetails> {
  await safeNavigate(url);
  await sleep(5000);

  // Click "See more" if present
  await safeEval(
    'document.querySelector("button.jobs-description__footer-button, button[aria-label=\\"Show more\\"]")?.click()'
  );
  await sleep(2000);

  // Return object directly — agent-browser eval serializes objects as plain JSON (no extra quoting)
  const script = `(function() { const descEl = document.querySelector(".jobs-description__content, .jobs-box__html-content, .description__text, .show-more-less-html__markup") || document.querySelector("main"); const locEl = document.querySelector(".jobs-unified-top-card__bullet, .job-card-container__metadata-item"); const wpEl = document.querySelector(".jobs-unified-top-card__workplace-type"); const applyBtn = document.querySelector("button.jobs-apply-button"); const isEasy = applyBtn ? applyBtn.innerText.toLowerCase().includes("easy apply") : false; return { description: descEl ? descEl.innerText.trim() : "", location: locEl ? locEl.innerText.trim() : "", workArrangement: wpEl ? wpEl.innerText.trim() : "", isEasyApply: isEasy }; })()`;

  try {
    const raw = await safeEval(script);
    const jsonStart = raw.indexOf("{");
    if (jsonStart === -1) return { description: "", location: "", workArrangement: "", isEasyApply: false };
    return JSON.parse(raw.substring(jsonStart));
  } catch (err: any) {
    logger.warn({ error: err?.message }, "getJobDetails parse failed");
    return { description: "", location: "", workArrangement: "", isEasyApply: false };
  }
}

function queueForApproval(db: Database.Database, jobId: string, result: ScoringResult): void {
  const existing = db.prepare(
    "SELECT 1 FROM approval_queue WHERE job_id = ? AND decision = 'pending'"
  ).get(jobId);
  if (existing) return;

  const queueId = createHash("sha256")
    .update(`${jobId}${Date.now()}`)
    .digest("hex")
    .slice(0, 12);

  db.prepare(`
    INSERT INTO approval_queue (id, job_id, match_score, match_summary, priority_rank)
    VALUES (?, ?, ?, ?, ?)
  `).run(queueId, jobId, result.totalScore, result.matchAnalysis, Math.round(result.totalScore * 100));

  db.prepare("UPDATE job_postings SET approval_id = ? WHERE id = ?").run(queueId, jobId);
}

function formatSummary(db: Database.Database, stats: { searched: number; discovered: number; scored: number; qualified: number; rejected: number; skipped: number; deduped: number; errors: number }): string {
  const pendingCount = (db.prepare(
    "SELECT COUNT(*) as c FROM approval_queue WHERE decision = 'pending'"
  ).get() as { c: number }).c;

  const topJobs = db.prepare(`
    SELECT jp.title, jp.company, jp.match_score
    FROM job_postings jp
    WHERE jp.status = 'queued_for_approval' AND jp.match_score >= ?
    ORDER BY jp.match_score DESC LIMIT 5
  `).all(QUALIFICATION_THRESHOLD) as Array<{ title: string; company: string; match_score: number }>;

  const lines: string[] = [
    `Job Hunt Discovery: ${stats.discovered} new, ${stats.qualified} qualified, ${stats.rejected} rejected`,
  ];

  if (stats.deduped > 0) lines[0] += `, ${stats.deduped} deduped`;

  if (topJobs.length > 0) {
    lines.push("\nTop matches:");
    for (const j of topJobs) {
      lines.push(`  ${j.company} - ${j.title} (${j.match_score.toFixed(2)})`);
    }
  }

  lines.push(`\nQueue: ${pendingCount} jobs awaiting approval`);
  if (stats.errors > 0) lines.push(`Errors: ${stats.errors}`);
  if (stats.skipped > 0) lines.push(`Skipped (already known): ${stats.skipped}`);

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
