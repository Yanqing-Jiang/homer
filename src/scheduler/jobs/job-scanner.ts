/**
 * Job Scanner — discover fresh postings, verify them on the employer's own
 * ATS feed, filter + LLM-score. Scans run three times a day; only the midday
 * run emails, one daily ranked top-10 digest to hi@yanqing.app.
 * Notify-only: no auto-apply, no resume tailoring.
 *
 * Plan of record: ~/homer/output/research/job-scanner-plan-2026-08-16.md
 */

import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import type { RegisteredJob } from "../types.js";
import { runInternalJobHarness } from "../executor.js";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { storeJobArtifact } from "./artifact-store.js";
import { PATHS } from "../../config/paths.js";
import { searchHiringCafe, normalizeHit } from "../../job-scanner/hiring-cafe.js";
import { searchTrueUp, normalizeTrueUpHit } from "../../job-scanner/trueup.js";
import { discoveryQueries } from "../../job-scanner/taxonomy.js";
import { applyRules, digestKeyFromFingerprint } from "../../job-scanner/filters.js";
import { verifyJob, resetVerifyCache } from "../../job-scanner/verify.js";
import {
  upsertPosting, markFiltered, setCategory, setVerification,
  setFitScore, setRankScore, getEmailCandidates, getPostingsNeedingScore,
  getRecentlyEmailedFingerprints, getDismissedKeys, markEmailed, recordRun, recordEmail,
  sentDigestToday,
} from "../../job-scanner/store.js";
import { buildScoringPrompt, computeRankScore, FitScoreSchema } from "../../job-scanner/scoring.js";
import { renderDigestHtml, renderDigestText, renderQuietDayHtml, renderQuietDayText } from "../../job-scanner/digest.js";
import { sendHtmlEmail, GmailAuthError } from "../../job-scanner/gmail.js";
import type { NormalizedJob, RankedJob, RunStats } from "../../job-scanner/types.js";

const RECIPIENT = process.env.JOB_SCANNER_TO ?? "hi@yanqing.app";
const FROM_ADDRESS = process.env.JOB_SCANNER_FROM ?? "hi@yanqing.app";
const DATE_WINDOW_DAYS = 7; // source-side coarse filter only; first-seen dedup is the real clock
const MAX_LLM_JOBS = 25;
const TOP_N = 10;
const FRESH_HOURS = 72;
// Digests only carry roles worth acting on: below this rank the backlog drip
// degrades into rank-60s filler, so the send is skipped instead.
const RANK_FLOOR = 70;
const EMAILED_FP_DAYS = 7; // re-cut requisitions of an emailed role stay out this long
const OUTPUT_DIR = `${PATHS.homerRoot}/output/job-scanner`;
// Human-reviewable audit trail: one block per refresh with the ranked list,
// so what each scan surfaced (and whether it emailed) is greppable without
// the DB or homer.log.
const RUN_LOG = `${PATHS.homerRoot}/logs/job-scanner.log`;

export interface JobScannerContext {
  stateManager: StateManager;
  jobRunId?: number;
  signal?: AbortSignal;
  job?: RegisteredJob;
  startedAt?: Date;
}

export async function runJobScanner(
  ctx: JobScannerContext,
): Promise<{ success: boolean; output: string; error?: string; sideEffectDelivered?: boolean }> {
  const startedAt = ctx.startedAt ?? new Date();
  const stats: RunStats = {
    discovered: 0, newJobs: 0, rulesPassed: 0, verifiedLive: 0,
    scored: 0, emailed: 0, emailStatus: "skipped", errors: [],
  };

  if (!ctx.job) return { success: false, output: "", error: "Registered job context required" };

  try {
    const db = ctx.stateManager.getDb();
    resetVerifyCache();

    // ── 1. Discover ─────────────────────────────────────────────
    // Seattle-locality only (fully-remote roles are excluded outright), so
    // each source's slice is spent on postings that can pass the local
    // geography gate. Two sources per query: hiringcafe.com and Lenny's Jobs
    // (TrueUp). Cross-source repeats of one role collapse later at the digest
    // fingerprint; here they just cost a cheap seen-id skip.
    const survivors: NormalizedJob[] = [];
    const seenThisRun = new Set<string>();

    /** Upsert one normalized hit and run it through the rules gate. */
    const ingest = (job: NormalizedJob | null): void => {
      if (!job || seenThisRun.has(job.id)) return;
      seenThisRun.add(job.id);
      stats.discovered++;

      const isNew = upsertPosting(db, job);
      if (!isNew) return;
      stats.newJobs++;

      // ── 2. Rules gate ─────────────────────────────────────────
      const verdict = applyRules(job);
      if (!verdict.pass) {
        markFiltered(db, job.id, verdict.reason ?? "rules");
        return;
      }
      setCategory(db, job.id, verdict.category!, verdict.categoryWeight!);
      job.category = verdict.category!;
      job.categoryWeight = verdict.categoryWeight!;
      stats.rulesPassed++;
      survivors.push(job);
    };

    for (const { query } of discoveryQueries()) {
      if (ctx.signal?.aborted) throw new Error("aborted");

      try {
        const hits = await searchHiringCafe(query, { dateWindowDays: DATE_WINDOW_DAYS, signal: ctx.signal });
        for (const hit of hits) ingest(normalizeHit(hit));
      } catch (error) {
        stats.errors.push(`hiring.cafe "${query}": ${String(error).slice(0, 120)}`);
      }

      try {
        const hits = await searchTrueUp(query, { dateWindowDays: DATE_WINDOW_DAYS, signal: ctx.signal });
        for (const hit of hits) ingest(normalizeTrueUpHit(hit));
      } catch (error) {
        stats.errors.push(`lennys "${query}": ${String(error).slice(0, 120)}`);
      }

      // Politeness gap between requests against the unofficial routes.
      await new Promise((r) => setTimeout(r, 1_000));
    }

    // ── 3. Verify against employer ATS feeds ──────────────────────
    const verified: NormalizedJob[] = [];
    for (const job of survivors) {
      if (ctx.signal?.aborted) throw new Error("aborted");
      const result = await verifyJob(job, ctx.signal);
      setVerification(db, job.id, result.live, result.method);
      if (result.live === false) continue; // confirmed gone: never surfaces
      if (result.live === true) stats.verifiedLive++;
      verified.push(job);
    }

    // ── 4. LLM fit scoring (one batched harness call) ─────────────
    // Batch = every fresh candidate still lacking a real LLM score, so an
    // outage in one run is repaired by the next.
    const needingScore = getPostingsNeedingScore(db, FRESH_HOURS, MAX_LLM_JOBS);
    const toScore: NormalizedJob[] = [];
    for (const row of needingScore) {
      try {
        const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
        // raw_json shape depends on the discovery source; the wrong normalizer
        // returns null and strands the posting on the heuristic score forever.
        const job = row.id.startsWith("trueup___") ? normalizeTrueUpHit(raw) : normalizeHit(raw);
        if (job) toScore.push(job);
      } catch { /* unparseable raw payload: leave for heuristic */ }
    }

    if (toScore.length > 0) {
      try {
        const harnessResult = await runInternalJobHarness(ctx.job, buildScoringPrompt(toScore), {
          stage: "score",
          startedAt,
          emitCompletedEvent: false,
        });
        if (harnessResult.exitCode === 0 && harnessResult.output) {
          const parsed = parseSwarmJSON(harnessResult.output, FitScoreSchema);
          const byId = new Map(parsed.map((p) => [p.id, p]));
          for (const job of toScore) {
            const s = byId.get(job.id);
            if (s) {
              setFitScore(db, job.id, s.fit, s.rationale);
              stats.scored++;
            }
          }
        } else {
          stats.errors.push(`LLM scoring failed: ${harnessResult.error?.slice(0, 150) ?? "no output"}`);
        }
      } catch (error) {
        stats.errors.push(`LLM scoring: ${String(error).slice(0, 150)}`);
      }
    }
    // Heuristic fallback so a scoring outage degrades instead of going silent.
    for (const row of needingScore) {
      const existing = db
        .prepare("SELECT fit_score, category_weight FROM job_scan_postings WHERE id = ?")
        .get(row.id) as { fit_score: number | null; category_weight: number | null } | undefined;
      if (existing && existing.fit_score == null) {
        setFitScore(db, row.id, (existing.category_weight ?? 0.5) * 6.5, "heuristic score (LLM unavailable)");
      }
    }

    // ── 5. Rank + pick top N across the fresh window ──────────────
    const candidates = getEmailCandidates(db, FRESH_HOURS);
    for (const p of candidates) {
      p.rank_score = computeRankScore(p);
      setRankScore(db, p.id, p.rank_score);
    }
    // One digest slot per role: drop permanently dismissed roles (applied /
    // rejected) and re-cuts of anything emailed recently, then keep only the
    // best-ranked posting per fingerprint, and never let the backlog drip pad
    // the list below the quality floor.
    const emailedKeys = new Set(
      [...getRecentlyEmailedFingerprints(db, EMAILED_FP_DAYS)].map(digestKeyFromFingerprint),
    );
    for (const key of getDismissedKeys(db)) emailedKeys.add(key);
    const seenKeys = new Set<string>();
    const ranked: RankedJob[] = candidates
      .filter((p) => (p.rank_score ?? 0) >= RANK_FLOOR)
      .sort((a, b) => (b.rank_score ?? 0) - (a.rank_score ?? 0))
      .filter((p) => {
        const key = digestKeyFromFingerprint(p.fingerprint);
        if (emailedKeys.has(key) || seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      })
      .map((job) => ({ job, rankScore: job.rank_score ?? 0 }))
      .slice(0, TOP_N);

    // ── 6. Digest email — once a day, at midday ───────────────────
    // Scans run three times a day to keep the queue fresh, but only the
    // midday (12:00) run emails: one daily digest ranking every un-emailed
    // fresh candidate into a top 10, or one "no qualifying roles" status
    // when nothing clears the bar. Morning/evening runs stay silent and let
    // candidates queue for the next midday send (Yanqing, 2026-08-18).
    // Once-a-day is a local-calendar-day gate, not a rolling cooldown, so a
    // manual or late send never suppresses the next day's midday digest.
    const now = new Date();
    const isMiddayRun = now.getHours() >= 11 && now.getHours() < 14;
    const alreadySentToday = sentDigestToday(db);
    if (!isMiddayRun || alreadySentToday) {
      stats.emailStatus = alreadySentToday
        ? "skipped:already_sent_today"
        : ranked.length === 0 ? "skipped:no_candidates" : "skipped:awaiting_midday";
    } else if (ranked.length === 0) {
      const nearMisses: RankedJob[] = candidates
        .filter((p) => !emailedKeys.has(digestKeyFromFingerprint(p.fingerprint)))
        .sort((a, b) => (b.rank_score ?? 0) - (a.rank_score ?? 0))
        .slice(0, 5)
        .map((job) => ({ job, rankScore: job.rank_score ?? 0 }));
      const dayLabel = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const subject = `Job Scanner: no qualifying roles — ${dayLabel}`;
      const html = renderQuietDayHtml(nearMisses, dayLabel, stats);
      try {
        const sent = await sendHtmlEmail(
          { from: FROM_ADDRESS, to: RECIPIENT, subject, html, text: renderQuietDayText(nearMisses, dayLabel) },
          ctx.signal,
        );
        recordEmail(db, RECIPIENT, subject, [], sent.messageId, "sent");
        stats.emailStatus = "sent:quiet_day";
      } catch (error) {
        const reason = error instanceof GmailAuthError ? "auth_dead" : String(error).slice(0, 200);
        recordEmail(db, RECIPIENT, subject, [], null, `failed:${reason}`);
        stats.emailStatus = `failed:${reason}`;
        stats.errors.push(error instanceof GmailAuthError ? error.message : `email send: ${reason}`);
      }
    } else {
      const runLabel = now.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const html = renderDigestHtml(ranked, runLabel, stats);
      const text = renderDigestText(ranked, runLabel);
      const subject = `Job Scanner: ${ranked.length} fresh role${ranked.length === 1 ? "" : "s"} — ${runLabel}`;

      mkdirSync(OUTPUT_DIR, { recursive: true });
      const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, "-");
      writeFileSync(`${OUTPUT_DIR}/digest-${stamp}.html`, html);

      const jobIds = ranked.map((r) => r.job.id);
      try {
        const sent = await sendHtmlEmail({ from: FROM_ADDRESS, to: RECIPIENT, subject, html, text }, ctx.signal);
        recordEmail(db, RECIPIENT, subject, jobIds, sent.messageId, "sent");
        markEmailed(db, jobIds);
        stats.emailed = ranked.length;
        stats.emailStatus = "sent";
      } catch (error) {
        const reason = error instanceof GmailAuthError ? "auth_dead" : String(error).slice(0, 200);
        recordEmail(db, RECIPIENT, subject, jobIds, null, `failed:${reason}`);
        stats.emailStatus = `failed:${reason}`;
        stats.errors.push(error instanceof GmailAuthError ? error.message : `email send: ${reason}`);
        // Postings stay un-emailed so the next successful send includes them.
      }
    }

    // ── 7. Bookkeeping (recordRun lives in the finally) ───────────
    try {
      const logLines = [
        `[${now.toISOString()}] discovered=${stats.discovered} new=${stats.newJobs} rules_passed=${stats.rulesPassed} verified=${stats.verifiedLive} scored=${stats.scored} email=${stats.emailStatus}`,
        ...ranked.map((r, i) => `  ${i + 1}. [rank ${r.rankScore.toFixed(0)}] ${r.job.title} — ${r.job.company} (${r.job.location ?? "n/a"})`),
      ];
      if (stats.errors.length > 0) logLines.push(`  errors: ${stats.errors.join(" | ").slice(0, 400)}`);
      appendFileSync(RUN_LOG, logLines.join("\n") + "\n");
    } catch { /* audit log is best effort */ }

    const durationMs = Date.now() - startedAt.getTime();
    if (ctx.jobRunId) {
      storeJobArtifact(db, ctx.jobRunId, "job-scanner", "digest", "json",
        JSON.stringify({ ranked: ranked.map((r) => ({ id: r.job.id, title: r.job.title, company: r.job.company, rank: r.rankScore })), stats }),
        { discovered: stats.discovered, emailed: stats.emailed });
    }

    const output =
      `Job scanner: ${stats.discovered} discovered, ${stats.newJobs} new, ${stats.rulesPassed} passed rules, ` +
      `${stats.verifiedLive} ATS-verified, top ${ranked.length} ranked, email ${stats.emailStatus} to ${RECIPIENT}.` +
      (stats.errors.length > 0 ? ` Issues: ${stats.errors.join(" | ").slice(0, 400)}` : "");
    logger.info({ ...stats, durationMs }, "job-scanner run complete");

    // Email-auth failure must surface even with notifyOnFailure suppression off-path:
    // treat a dead email channel as a failed run so the failure_alert intent fires.
    if (stats.emailStatus.startsWith("failed:auth_dead")) {
      return { success: false, output, error: "Digest email blocked: Gmail OAuth needs re-auth (node ~/homer/scripts/gmail-reauth.mjs)" };
    }
    return { success: true, output, sideEffectDelivered: stats.emailStatus === "sent" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "job-scanner run failed");
    return { success: false, output: "", error: msg };
  } finally {
    // Every invocation — scheduled, manual, killed mid-run — leaves a run row.
    try {
      recordRun(ctx.stateManager.getDb(), { ...stats, durationMs: Date.now() - startedAt.getTime() });
    } catch { /* best effort */ }
  }
}
