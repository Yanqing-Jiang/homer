/**
 * Job Scanner — discover fresh postings, verify them on the employer's own
 * ATS feed, filter + LLM-score, and email a ranked top-10 digest to
 * hi@yanqing.app. Notify-only: no auto-apply, no resume tailoring.
 *
 * Plan of record: ~/homer/output/research/job-scanner-plan-2026-08-16.md
 */

import { mkdirSync, writeFileSync } from "fs";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import type { RegisteredJob } from "../types.js";
import { runInternalJobHarness } from "../executor.js";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { storeJobArtifact } from "./artifact-store.js";
import { PATHS } from "../../config/paths.js";
import { searchHiringCafe, normalizeHit } from "../../job-scanner/hiring-cafe.js";
import { discoveryQueries } from "../../job-scanner/taxonomy.js";
import { applyRules, digestKeyFromFingerprint } from "../../job-scanner/filters.js";
import { verifyJob, resetVerifyCache } from "../../job-scanner/verify.js";
import {
  upsertPosting, markFiltered, setCategory, setVerification,
  setFitScore, setRankScore, getEmailCandidates, getPostingsNeedingScore,
  getRecentlyEmailedFingerprints, getDismissedKeys, markEmailed, recordRun, recordEmail,
  hoursSinceLastSentEmail,
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
    // the source's ~55-hit slice is spent on postings that can pass the
    // local geography gate.
    const survivors: NormalizedJob[] = [];
    const seenThisRun = new Set<string>();
    for (const { query } of discoveryQueries()) {
      if (ctx.signal?.aborted) throw new Error("aborted");
      let hits: Record<string, unknown>[] = [];
      try {
        hits = await searchHiringCafe(query, {
          dateWindowDays: DATE_WINDOW_DAYS,
          signal: ctx.signal,
        });
      } catch (error) {
        stats.errors.push(`discovery "${query}": ${String(error).slice(0, 120)}`);
        continue;
      }
      for (const hit of hits) {
        const job = normalizeHit(hit);
        if (!job || seenThisRun.has(job.id)) continue;
        seenThisRun.add(job.id);
        stats.discovered++;

        const isNew = upsertPosting(db, job);
        if (!isNew) continue;
        stats.newJobs++;

        // ── 2. Rules gate ───────────────────────────────────────
        const verdict = applyRules(job);
        if (!verdict.pass) {
          markFiltered(db, job.id, verdict.reason ?? "rules");
          continue;
        }
        setCategory(db, job.id, verdict.category!, verdict.categoryWeight!);
        job.category = verdict.category!;
        job.categoryWeight = verdict.categoryWeight!;
        stats.rulesPassed++;
        survivors.push(job);
      }
      // Politeness gap between requests against the unofficial route.
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
        const job = normalizeHit(JSON.parse(row.raw_json) as Record<string, unknown>);
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

    // ── 6. Digest email ───────────────────────────────────────────
    // Runs with qualifying roles email immediately. Quiet runs stay silent
    // and let candidates keep queueing — except the midday (12:00) run,
    // which sends at most one "no qualifying roles" status per day so a
    // jobless stretch is confirmed once, mid-day, instead of pinging every
    // run or going ambiguously silent (Yanqing, 2026-08-18).
    const now = new Date();
    if (ranked.length === 0) {
      const isMiddayRun = now.getHours() >= 11 && now.getHours() < 14;
      const sinceLastSent = hoursSinceLastSentEmail(db);
      if (!isMiddayRun || (sinceLastSent !== null && sinceLastSent < 20)) {
        stats.emailStatus = "skipped:no_candidates";
      } else {
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
      }
    } else {
      const runLabel = `${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${now.getHours() < 12 ? "AM" : "PM"}`;
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
