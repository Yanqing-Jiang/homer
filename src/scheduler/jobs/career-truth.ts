/**
 * Career Truth — 1 PM Tue/Wed/Thu.
 *
 * Delivers a 100-120 word card in 4 blocks: The Lie / The Truth / The Evidence / The Move.
 * Voice: Gergely-for-evidence, Erik-for-hook, Yishan-for-claim, Lenny-for-move.
 * Private-tone allowed — comp numbers, org politics, patron/ladder dynamics.
 *
 * Signal fusion:
 *   - x-bookmark scrapes tagged career-truth / operator-pattern (last 30d)
 *   - work.md (org dynamics: JT advocacy, Adichi competition, etc.)
 *   - me.md (stated ambition + timeline)
 *   - advisory_state.json (dedup with mentor-layer)
 *
 * Archives each card to ~/memory/career.md (append) so old cards are searchable.
 *
 * Kill switch: advisory-state.ts exposes careerTruthPauseUntil + zero-engagement
 * streak helpers. The *pause honoring* is live below, but automatic engagement
 * detection (Telegram reaction tracking) is a follow-up — no code path currently
 * calls incrementCareerTruthZeroEngagement() or setCareerTruthPause(). The pause
 * can be set manually by editing ~/homer/data/advisory_state.json until that's wired.
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { readFile, appendFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { executeGeminiAPI } from "../../executors/gemini.js";
import { logger } from "../../utils/logger.js";
import { PATHS } from "../../config/paths.js";
import { escapeHtml } from "../../utils/telegram-format.js";
import { loadAdvisoryState, recordAdvisoryTopic } from "./advisory-state.js";

interface CareerCard {
  frameName: string; // 6-word preview
  lie: string;
  truth: string;
  evidence: string;
  move: string;
  topic: string; // kebab-case dedup slug
}

interface CareerSignals {
  recentBookmarks: Array<{ title: string; author: string | null; snippet: string }>;
  workContext: string;
  meContext: string;
  recentTopics: Array<{ topic: string; emitter: string; timestamp: string }>;
}

const CAREER_ARCHIVE_PATH = join(PATHS.memory, "career.md");

export async function runCareerTruth(
  db: Database.Database,
  _jobRunId?: number
): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const state = await loadAdvisoryState();

    // Kill-switch: honor active pause.
    if (state.careerTruthPauseUntil) {
      const pauseUntil = new Date(state.careerTruthPauseUntil);
      if (!Number.isNaN(pauseUntil.getTime()) && pauseUntil.getTime() > Date.now()) {
        const output = `Career-truth paused until ${state.careerTruthPauseUntil} (zero-engagement streak).`;
        logger.info({ pauseUntil: state.careerTruthPauseUntil }, "Career-truth skipped — paused");
        return { success: true, output };
      }
    }

    const signals = await gatherCareerSignals(db, state.recentTopics);
    const card = await composeCareerCard(signals);

    const tg = formatCardAsTelegramHtml(card);
    await archiveToCareerMd(card);
    await recordAdvisoryTopic({
      topic: card.topic,
      emitter: "career-truth",
      title: card.frameName,
    });

    logger.info({ topic: card.topic, frame: card.frameName }, "Career-truth emitted card");
    return { success: true, output: tg };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Career-truth failed");
    return { success: false, output: "", error: msg };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Signal gathering
// ────────────────────────────────────────────────────────────────────────

async function gatherCareerSignals(
  db: Database.Database,
  recentTopics: Array<{ topic: string; emitter: string; timestamp: string }>
): Promise<CareerSignals> {
  const [recentBookmarks, workContext, meContext] = await Promise.all([
    getRecentCareerBookmarks(db),
    readSafe(PATHS.work, 8000),
    readSafe(PATHS.me, 4000),
  ]);

  return {
    recentBookmarks,
    workContext,
    meContext,
    recentTopics,
  };
}

async function getRecentCareerBookmarks(
  db: Database.Database
): Promise<Array<{ title: string; author: string | null; snippet: string }>> {
  try {
    // Bookmarks tagged/tied to career themes. Prefer scrapes whose raw_content
    // mentions career/leverage/promotion/operator/compensation vocabulary.
    const rows = db
      .prepare(
        `SELECT title, author, raw_content
         FROM scrapes
         WHERE source LIKE 'x-bookmark%'
           AND scraped_at > datetime('now', '-30 days')
           AND (
             raw_content LIKE '%operator%' OR raw_content LIKE '%career%' OR
             raw_content LIKE '%comp %' OR raw_content LIKE '%compensation%' OR
             raw_content LIKE '%promotion%' OR raw_content LIKE '%leverage%' OR
             raw_content LIKE '%hiring%' OR raw_content LIKE '%leadership%' OR
             raw_content LIKE '%经营%' OR raw_content LIKE '%螺丝钉%'
           )
         ORDER BY scraped_at DESC
         LIMIT 12`
      )
      .all() as Array<{ title: string | null; author: string | null; raw_content: string | null }>;

    return rows.map((r) => ({
      title: r.title?.trim() ?? "(untitled)",
      author: r.author,
      snippet: (r.raw_content ?? "").slice(0, 400).replace(/\s+/g, " "),
    }));
  } catch {
    return [];
  }
}

async function readSafe(path: string, limit: number): Promise<string> {
  if (!existsSync(path)) return "";
  try {
    return (await readFile(path, "utf-8")).slice(0, limit);
  } catch {
    return "";
  }
}

// ────────────────────────────────────────────────────────────────────────
// LLM composition
// ────────────────────────────────────────────────────────────────────────

async function composeCareerCard(signals: CareerSignals): Promise<CareerCard> {
  const bookmarksText =
    signals.recentBookmarks.length > 0
      ? signals.recentBookmarks
          .slice(0, 10)
          .map(
            (b, i) =>
              `${i + 1}. "${b.title}" by ${b.author ?? "?"} — ${b.snippet.slice(0, 300)}`
          )
          .join("\n")
      : "(no recent career bookmarks)";

  const recentTopicsText =
    signals.recentTopics.length > 0
      ? signals.recentTopics
          .slice(0, 8)
          .map(
            (t) => `- ${t.topic} (${t.emitter}, ${t.timestamp.slice(0, 10)})`
          )
          .join("\n")
      : "(none)";

  const systemPrompt = `You are Yanqing's career advisor — a private one, not a coach. You say things publications won't publish. Voice: Gergely-for-evidence (name the numbers), Erik-for-hook (bold, unfashionable claim), Yishan-for-truth (the executive-reality nobody admits), Lenny-for-move (one concrete action).

You are delivering at 1 PM sharp on a workday. He is mid-afternoon, about to start his high-energy block. The card must either sharpen his afternoon or get ignored — it cannot distract. 100-120 words total. Private tone. You can name people (JT, Adichi, Carl) and use comp numbers.

CRITICAL RULES:
- Structure: "The Lie" (common assumption) → "The Truth" (what's actually happening) → "The Evidence" (from his own logs) → "The Move" (one action before EOD).
- DO NOT echo the recent topics below — pick a different career-truth angle.
- Forbidden language: "leverage" (except in "patron/ladder" sense), "unlock", "at the end of the day", "in the rapidly evolving landscape", "thought leadership", "personal brand". LinkedIn-style hooks are banned.
- "The Move" must include a recipient OR subject line OR command. Not "think about X" — actual action.

Return ONLY JSON in this schema:
{
  "frameName": "6-word title, declarative, no colons, no question marks",
  "lie": "1-2 sentences naming the common (wrong) assumption",
  "truth": "2-3 sentences with the actual executive-reality",
  "evidence": "1-2 sentences citing his own logs — specific numbers, dates, or names",
  "move": "One concrete action, max 35 words, with recipient/subject/command",
  "topic": "kebab-case slug, 2-4 words, identifies the theme for dedup"
}`;

  const userPrompt = `## Recent topics already covered (DO NOT echo)
${recentTopicsText}

## Recent career-adjacent X bookmarks (last 30 days)
${bookmarksText}

## His current work situation (work.md excerpt)
${signals.workContext || "(empty)"}

## His stated ambitions (me.md excerpt)
${signals.meContext || "(empty)"}

## Your task
Pick ONE uncomfortable career truth from the bookmark cluster OR the work-situation signals. Write the card in the 4-block schema. Keep it 100-120 words total.`;

  const result = await executeGeminiAPI(userPrompt, {
    model: "gemini-3-flash-preview" as any,
    systemPrompt,
    temperature: 0.5,
    responseMimeType: "application/json",
  });

  if (result.exitCode !== 0 || !result.output) {
    throw new Error(`Gemini composition failed: exit=${result.exitCode}`);
  }

  const card = parseCareerCardJson(result.output);
  if (!card) {
    throw new Error(`Career-truth card JSON parse failed: ${result.output.slice(0, 400)}`);
  }
  return card;
}

function parseCareerCardJson(raw: string): CareerCard | null {
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const obj = JSON.parse(text);
    if (
      typeof obj?.frameName !== "string" ||
      typeof obj?.lie !== "string" ||
      typeof obj?.truth !== "string" ||
      typeof obj?.evidence !== "string" ||
      typeof obj?.move !== "string" ||
      typeof obj?.topic !== "string"
    ) {
      return null;
    }
    return {
      frameName: obj.frameName.trim(),
      lie: obj.lie.trim(),
      truth: obj.truth.trim(),
      evidence: obj.evidence.trim(),
      move: obj.move.trim(),
      topic: obj.topic.trim().toLowerCase().replace(/\s+/g, "-"),
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Telegram formatting + archival
// ────────────────────────────────────────────────────────────────────────

function formatCardAsTelegramHtml(card: CareerCard): string {
  return [
    `🎯 <b>Career Truth</b> — <b>${escapeHtml(card.frameName)}</b>`,
    "━━━━━━━━━━━━",
    `<b>The Lie:</b> ${escapeHtml(card.lie)}`,
    "",
    `<b>The Truth:</b> ${escapeHtml(card.truth)}`,
    "",
    `<b>The Evidence:</b> ${escapeHtml(card.evidence)}`,
    "",
    `<b>The Move:</b> ${escapeHtml(card.move)}`,
  ].join("\n");
}

async function archiveToCareerMd(card: CareerCard): Promise<void> {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  const block = [
    "",
    `## ${stamp} — ${card.frameName}`,
    "",
    `**The Lie:** ${card.lie}`,
    "",
    `**The Truth:** ${card.truth}`,
    "",
    `**The Evidence:** ${card.evidence}`,
    "",
    `**The Move:** ${card.move}`,
    "",
    `_topic: ${card.topic}_`,
    "",
    "---",
    "",
  ].join("\n");

  if (!existsSync(CAREER_ARCHIVE_PATH)) {
    const header = "# Career Truth Archive\n\nCards delivered by Homer at 1 PM Tue/Wed/Thu. Newest appended at bottom.\n\n---\n";
    await writeFile(CAREER_ARCHIVE_PATH, header + block, "utf-8");
    return;
  }
  await appendFile(CAREER_ARCHIVE_PATH, block, "utf-8");
}
