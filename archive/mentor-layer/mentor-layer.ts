/**
 * Mentor Layer — active-work mentor, Mon/Wed/Fri 08:30.
 *
 * Reads weighted signals (stalled plans, ambition-vs-output delta, recent session themes)
 * and emits ONE prescriptive card in the 4-block format:
 *   Title → Claim → Evidence → The Move
 *
 * Voice: temporal-delta framing + "If I ran this" + Bungay Stanier smallest-next-move.
 * First run emits a hardcoded pilot card (Director-of-Agents). Subsequent runs are LLM-generated.
 *
 * Shares state with career-truth.ts via ~/homer/data/advisory_state.json for topic dedup.
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { readFile, readdir, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { executeGeminiAPI } from "../../executors/gemini.js";
import { logger } from "../../utils/logger.js";
import { PATHS } from "../../config/paths.js";
import { escapeHtml } from "../../utils/telegram-format.js";
import {
  loadAdvisoryState,
  recordAdvisoryTopic,
  type AdvisoryState,
} from "./advisory-state.js";

export interface MentorCard {
  title: string;
  claim: string;
  evidence: string[];
  move: string;
  topic: string; // short slug for dedup tracking
}

interface Signals {
  stalledPlans: Array<{ name: string; status: string; daysSinceUpdate: number }>;
  ambitionGaps: string[];
  recentSessionThemes: string[];
  currentPriorities: string;
  draftOverflow: { reviewCount: number; shipped7d: number } | null;
  recentDailyLog: string;
}

const MENTOR_OUTPUT_DIR = join(PATHS.homerRoot, "output", "mentor");

export async function runMentorLayer(
  db: Database.Database,
  _jobRunId?: number
): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const state = await loadAdvisoryState();

    // Pilot card: first-ever run emits the hardcoded Director-of-Agents card.
    if (!state.firstCardSent) {
      const card = buildPilotCard();
      const tg = formatCardAsTelegramHtml(card, { emitter: "mentor" });
      await archiveCard(card, tg);
      await recordAdvisoryTopic({ topic: card.topic, emitter: "mentor", markFirstCardSent: true });
      logger.info({ topic: card.topic, title: card.title }, "Mentor layer emitted pilot card");
      return { success: true, output: tg };
    }

    // Subsequent runs: gather signals, let Gemini Flash compose.
    const signals = await gatherSignals(db);
    const card = await composeCard(signals, state);

    const tg = formatCardAsTelegramHtml(card, { emitter: "mentor" });
    await archiveCard(card, tg);
    await recordAdvisoryTopic({ topic: card.topic, emitter: "mentor" });
    logger.info({ topic: card.topic, title: card.title }, "Mentor layer emitted card");

    return { success: true, output: tg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Mentor layer failed");
    return { success: false, output: "", error: msg };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Signal gathering
// ────────────────────────────────────────────────────────────────────────

async function gatherSignals(db: Database.Database): Promise<Signals> {
  const [stalledPlans, recentSessionThemes, currentPriorities, draftOverflow, recentDailyLog] =
    await Promise.all([
      getStalledTodos(db),
      getRecentSessionThemes(db),
      getCurrentPriorities(),
      getDraftOverflow(db),
      getRecentDailyLog(),
    ]);

  const ambitionGaps = extractAmbitionGaps(currentPriorities);

  return {
    stalledPlans,
    ambitionGaps,
    recentSessionThemes,
    currentPriorities,
    draftOverflow,
    recentDailyLog,
  };
}

/**
 * Stalled W-category todos: P1 untouched ≥3d, P2 untouched ≥7d.
 * Replaces the old plan-folder scan (file-first Plans feature was retired in
 * migration 095). The `stalledPlans` signal name is preserved in the prompt
 * for now — re-label in a later revision if useful.
 */
async function getStalledTodos(
  db: Database.Database,
): Promise<Array<{ name: string; status: string; daysSinceUpdate: number }>> {
  try {
    const rows = db.prepare(`
      SELECT
        title AS name,
        priority AS status,
        CAST(julianday('now') - julianday(updated_at) AS INTEGER) AS daysSinceUpdate
      FROM todo_index
      WHERE status = 'open'
        AND category = 'W'
        AND (
          (priority = 'P1' AND updated_at < datetime('now','-3 days'))
          OR (priority = 'P2' AND updated_at < datetime('now','-7 days'))
        )
      ORDER BY
        CASE priority WHEN 'P1' THEN 0 ELSE 1 END,
        datetime(updated_at) ASC
      LIMIT 6
    `).all() as Array<{ name: string; status: string; daysSinceUpdate: number }>;
    return rows;
  } catch {
    // todo_index may not yet exist (pre-migration); fall back to empty.
    return [];
  }
}

async function getRecentSessionThemes(db: Database.Database): Promise<string[]> {
  try {
    const rows = db
      .prepare(
        `SELECT subject, summary
         FROM session_summaries
         WHERE created_at > datetime('now', '-7 days')
         ORDER BY created_at DESC
         LIMIT 30`
      )
      .all() as Array<{ subject: string | null; summary: string | null }>;
    return rows
      .map((r) => r.subject?.trim())
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .slice(0, 20);
  } catch {
    return [];
  }
}

async function getCurrentPriorities(): Promise<string> {
  const parts: string[] = [];
  for (const p of [PATHS.me, PATHS.work]) {
    if (!existsSync(p)) continue;
    try {
      const content = await readFile(p, "utf-8");
      parts.push(`### ${p.split("/").pop()}\n${content.slice(0, 6000)}`);
    } catch {
      // skip
    }
  }
  return parts.join("\n\n");
}

async function getDraftOverflow(
  db: Database.Database
): Promise<{ reviewCount: number; shipped7d: number } | null> {
  try {
    const review = db
      .prepare(`SELECT count(*) as c FROM ideas WHERE status IN ('review','draft','exploring')`)
      .get() as { c: number } | undefined;
    const shipped = db
      .prepare(
        `SELECT count(*) as c FROM ideas WHERE status='shipped' AND updated_at > datetime('now','-7 days')`
      )
      .get() as { c: number } | undefined;
    return { reviewCount: review?.c ?? 0, shipped7d: shipped?.c ?? 0 };
  } catch {
    return null;
  }
}

async function getRecentDailyLog(): Promise<string> {
  const dir = PATHS.daily;
  if (!existsSync(dir)) return "";
  try {
    const entries = (await readdir(dir))
      .filter((e) => e.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort()
      .reverse()
      .slice(0, 1);
    if (entries.length === 0) return "";
    const first = entries[0];
    if (!first) return "";
    const content = await readFile(join(dir, first), "utf-8");
    return content.slice(0, 4000);
  } catch {
    return "";
  }
}

function extractAmbitionGaps(priorities: string): string[] {
  const gaps: string[] = [];
  // Heuristic markers — stated ambitions often show as bullet points near words like "goal", "target".
  const lines = priorities.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 20) continue;
    if (/target|goal|aim|ambition|pivot|narrative|director|\$\d/i.test(trimmed)) {
      gaps.push(trimmed.slice(0, 200));
      if (gaps.length >= 8) break;
    }
  }
  return gaps;
}

// ────────────────────────────────────────────────────────────────────────
// LLM composition
// ────────────────────────────────────────────────────────────────────────

async function composeCard(signals: Signals, state: AdvisoryState): Promise<MentorCard> {
  const recentTopicsList =
    state.recentTopics.length > 0
      ? state.recentTopics
          .slice(0, 8)
          .map((t: { topic: string; emitter: string; timestamp: string }) => `- ${t.topic} (${t.emitter}, ${t.timestamp.slice(0, 10)})`)
          .join("\n")
      : "(none yet)";

  const stalledPlansText =
    signals.stalledPlans.length > 0
      ? signals.stalledPlans
          .map((p) => `- ${p.name} (status: ${p.status}, untouched ${p.daysSinceUpdate} days)`)
          .join("\n")
      : "(no plans stalled >7 days)";

  const themes =
    signals.recentSessionThemes.length > 0
      ? signals.recentSessionThemes.slice(0, 15).map((t) => `- ${t}`).join("\n")
      : "(no recent sessions)";

  const draftLine = signals.draftOverflow
    ? `ideas in review/draft: ${signals.draftOverflow.reviewCount}; shipped last 7d: ${signals.draftOverflow.shipped7d}`
    : "(no idea-DB signal)";

  const systemPrompt = `You are Yanqing's personal mentor. You read his active work and prescribe ONE move. You don't summarize, you push. Voice: direct, second-person, no hedging. Like a chief-of-staff who doesn't work for anyone else.

CRITICAL RULES:
- Pick the sharpest signal — the ambition-vs-output delta, or the stalled plan with highest consequence. Ignore cosmetic signals.
- The card MUST terminate in ONE concrete move with a recipient, subject line, or command — not a menu.
- Avoid the listed recent topics — do not echo.
- Forbidden language: "leverage", "unlock", "synergy", "in the rapidly evolving landscape", "thought leadership", "at the end of the day", any LinkedIn-style hook.
- Prose must be prescriptive, not diagnostic. Don't describe what he did; prescribe what he does next.

Return ONLY JSON in this exact schema:
{
  "title": "6-10 word declarative headline (no question marks, no colons)",
  "claim": "2-3 sentences stating the sharpest truth from the signals. Use temporal-delta framing where applicable ('X days since you named it, 0 external artifacts').",
  "evidence": ["bullet 1 from his own logs", "bullet 2", "bullet 3"],
  "move": "ONE concrete action with an exact recipient / subject line / command / deliverable. Max 40 words.",
  "topic": "kebab-case slug, 2-4 words, identifies the theme for dedup tracking"
}`;

  const userPrompt = `## Recent topics already covered (DO NOT echo)
${recentTopicsList}

## Stalled plans (most-stalled first)
${stalledPlansText}

## Recent session themes (last 7 days)
${themes}

## Idea-DB signal
${draftLine}

## Yanqing's stated ambitions / current priorities
${signals.currentPriorities.slice(0, 8000)}

## Most recent daily log (excerpt)
${signals.recentDailyLog || "(none)"}

## Your task
Pick ONE gap between stated ambition and external output. Write the card. Make The Move specific enough that he could execute it before lunch.`;

  const result = await executeGeminiAPI(userPrompt, {
    model: "gemini-3.5-flash" as any,
    systemPrompt,
    temperature: 0.4,
    responseMimeType: "application/json",
  });

  if (result.exitCode !== 0 || !result.output) {
    throw new Error(`Gemini composition failed: exit=${result.exitCode}`);
  }

  const card = parseCardJson(result.output);
  if (!card) {
    throw new Error(`Mentor card JSON parse failed: ${result.output.slice(0, 400)}`);
  }
  return card;
}

function parseCardJson(raw: string): MentorCard | null {
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const obj = JSON.parse(text);
    if (
      typeof obj?.title !== "string" ||
      typeof obj?.claim !== "string" ||
      !Array.isArray(obj?.evidence) ||
      typeof obj?.move !== "string" ||
      typeof obj?.topic !== "string"
    ) {
      return null;
    }
    return {
      title: obj.title.trim(),
      claim: obj.claim.trim(),
      evidence: obj.evidence.map((e: unknown) => String(e).trim()).filter((e: string) => e.length > 0),
      move: obj.move.trim(),
      topic: obj.topic.trim().toLowerCase().replace(/\s+/g, "-"),
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Pilot card (first run only)
// ────────────────────────────────────────────────────────────────────────

function buildPilotCard(): MentorCard {
  return {
    title: "You're Building a Secret",
    claim:
      "\"Director of Agents\" has been your identity for 63 days. You have zero external recipients. That's not a strategy, it's a journal entry. The story exists, but the market has never heard it — and Adichi is pitching a competing prototype.",
    evidence: [
      "me.md names \"Director of Agents\" first logged around 2026-02-13",
      "0 recruiter outreach, 0 public artifacts, 0 LinkedIn updates since",
      "Career OS Phase 2: \"1 switch-flip from live\" for 45 consecutive days",
      "Shadow Data Pulse cited in 4 weekly summaries, externalized 0 times",
    ],
    move:
      "Pick ONE VP-adjacent person today. Send them the Shadow Data Pulse one-pager this afternoon — not for feedback, for recall. Subject line: \"Bypassing the 18-month data-foundation delay at P&G — 2 min read.\"",
    topic: "director-of-agents-has-no-recipient",
  };
}

// ────────────────────────────────────────────────────────────────────────
// Telegram formatting + archival
// ────────────────────────────────────────────────────────────────────────

export function formatCardAsTelegramHtml(
  card: MentorCard,
  opts: { emitter: "mentor" | "career-truth" }
): string {
  const header = opts.emitter === "mentor" ? "🧭 <b>Mentor</b>" : "🎯 <b>Career Truth</b>";
  const evidence = card.evidence
    .map((line) => `• ${escapeHtml(line)}`)
    .join("\n");

  return [
    `${header} — <b>${escapeHtml(card.title)}</b>`,
    "━━━━━━━━━━━━",
    escapeHtml(card.claim),
    "",
    "<b>EVIDENCE</b>",
    evidence,
    "",
    "<b>THE MOVE</b>",
    escapeHtml(card.move),
  ].join("\n");
}

async function archiveCard(card: MentorCard, telegramHtml: string): Promise<void> {
  if (!existsSync(MENTOR_OUTPUT_DIR)) {
    await mkdir(MENTOR_OUTPUT_DIR, { recursive: true });
  }
  const now = new Date();
  const stamp =
    now.toISOString().slice(0, 10) +
    "-" +
    now.toISOString().slice(11, 16).replace(":", "");
  const path = join(MENTOR_OUTPUT_DIR, `mentor-${stamp}-${card.topic}.md`);
  const md = [
    `# ${card.title}`,
    "",
    `**Date:** ${now.toISOString()}`,
    `**Topic:** ${card.topic}`,
    "",
    "## Claim",
    card.claim,
    "",
    "## Evidence",
    ...card.evidence.map((e) => `- ${e}`),
    "",
    "## The Move",
    card.move,
    "",
    "---",
    "",
    "## Rendered (Telegram HTML)",
    "```",
    telegramHtml,
    "```",
  ].join("\n");
  await writeFile(path, md, "utf-8");
}
