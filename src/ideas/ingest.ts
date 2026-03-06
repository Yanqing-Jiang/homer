import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import type Database from "better-sqlite3";
import { parseIdeasMd, type ParsedIdea } from "./parser.js";
import * as dao from "./dao.js";
import { logger } from "../utils/logger.js";
import { executeOpenCodeCLI } from "../executors/opencode-cli.js";
import { executeClaudeCommand } from "../executors/claude.js";
import { executeBrowserScrape } from "../executors/browser-scrape.js";
import { buildBookmarkScrapePrompt, buildTweetReadPrompt, SCRAPE_OPTIONS, DEEP_FETCH_OPTIONS } from "../scraping/browser-prompts.js";
import { ensureCDP } from "../scraping/chrome-launcher.js";
import { cleanAgentOutput } from "../scraping/clean-output.js";
import { insertScrape } from "../scraping/scrape-store.js";
import { PATHS } from "../config/paths.js";

const IDEAS_FILE = PATHS.ideasMd;
const DENY_HISTORY_FILE = PATHS.denyHistory;

interface SyncState {
  id: string;
  last_synced_at: string | null;
  last_line_number: number;
  last_bookmark_id: string | null;
}

interface IngestResult {
  ingested: number;
  skipped: number;
  enriched: number;
  fromTwitter: number;
  archivedToDeny: number;
  errors: string[];
}

interface TwitterBookmark {
  id: string;
  text: string;
  author: string;
  created_at: string;
  urls?: string[];
}

// ============================================
// SYNC STATE MANAGEMENT
// ============================================

function getSyncState(db: Database.Database): SyncState {
  const row = db.prepare("SELECT * FROM idea_sync_state WHERE id = 'default'").get() as SyncState | undefined;
  return row ?? { id: "default", last_synced_at: null, last_line_number: 0, last_bookmark_id: null };
}

function updateSyncState(db: Database.Database, lineNumber: number): void {
  db.prepare(`
    INSERT INTO idea_sync_state (id, last_synced_at, last_line_number)
    VALUES ('default', CURRENT_TIMESTAMP, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_synced_at = CURRENT_TIMESTAMP,
      last_line_number = excluded.last_line_number
  `).run(lineNumber);
}

function ensureIdeaId(idea: ParsedIdea): void {
  if (!idea.id || idea.id.length < 8) {
    const tsHash = idea.timestamp.replace(/[- :]/g, "").slice(-8);
    idea.id = `idea_${tsHash}_${Math.random().toString(36).slice(2, 6)}`;
  }
}

// ============================================
// TWITTER/X SCRAPING (via Gemini Flash + agent-browser)
// ============================================

async function scrapeTwitterBookmarks(): Promise<ParsedIdea[]> {
  logger.info("Scraping Twitter/X bookmarks via Gemini Flash + agent-browser");

  try {
    const result = await executeBrowserScrape(
      buildBookmarkScrapePrompt(20),
      "",
      SCRAPE_OPTIONS,
    );

    if (result.exitCode !== 0) {
      logger.warn({ exitCode: result.exitCode, output: result.output?.slice(0, 300) }, "Browser bookmark scrape failed");
      return [];
    }

    // Extract JSON array from output with structured fallback
    const output = result.output ?? "";
    let bookmarks: TwitterBookmark[] = [];

    // Attempt 1: Direct JSON array match
    const arrayMatch = output.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        bookmarks = JSON.parse(arrayMatch[0]);
      } catch {
        // Attempt 2: Extract from markdown code block
        const codeBlockMatch = output.match(/```json\n?([\s\S]*?)\n?```/);
        if (codeBlockMatch?.[1]) {
          try {
            bookmarks = JSON.parse(codeBlockMatch[1]);
          } catch {
            logger.warn("Failed to parse bookmark JSON from code block");
          }
        }
      }
    }

    // Attempt 3: Regex extraction fallback — extract URLs + surrounding text
    if (bookmarks.length === 0 && output.length > 100) {
      const urlPattern = /https?:\/\/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/g;
      let match;
      while ((match = urlPattern.exec(output)) !== null) {
        const author = match[1] ?? "unknown";
        const tweetId = match[2] ?? "";
        // Extract surrounding text as content (50 chars before/after URL)
        const idx = match.index;
        const contextStart = Math.max(0, idx - 100);
        const contextEnd = Math.min(output.length, idx + match[0].length + 100);
        const surrounding = output.slice(contextStart, contextEnd).replace(/["\n\r]/g, " ").trim();

        bookmarks.push({
          id: tweetId,
          text: surrounding,
          author,
          created_at: new Date().toISOString(),
        });
      }
      if (bookmarks.length > 0) {
        logger.warn({ count: bookmarks.length }, "Used regex fallback for bookmark extraction");
      }
    }

    if (bookmarks.length === 0) {
      logger.warn({ outputLen: output.length }, "No bookmarks extracted from browser output");
      return [];
    }

    const ideas: ParsedIdea[] = [];
    const now = new Date();
    const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;

    for (const bookmark of bookmarks) {
      const urls = bookmark.urls || [];
      const hasExternalLink = urls.some(u => !u.includes("twitter.com") && !u.includes("x.com"));

      const idea: ParsedIdea = {
        id: `tweet_${bookmark.id}`,
        title: `X: ${bookmark.text.slice(0, 60)}${bookmark.text.length > 60 ? "..." : ""}`,
        status: "draft",
        source: "x-bookmarks",
        content: `**@${bookmark.author}**: ${bookmark.text}`,
        link: `https://x.com/${bookmark.author}/status/${bookmark.id}`,
        tags: ["x-bookmark"],
        timestamp,
      };

      if (hasExternalLink) {
        const externalUrl = urls.find(u => !u.includes("twitter.com") && !u.includes("x.com"));
        if (externalUrl) {
          idea.context = `External link: ${externalUrl}`;
        }
      }

      ideas.push(idea);
    }

    logger.info({ count: ideas.length }, "Extracted ideas from Twitter bookmarks via agent-browser");
    return ideas;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, "Browser bookmark scrape error");
    return [];
  }
}

// YouTube scraping has been moved to Telegram → overnight pipeline.
// See src/youtube/transcript.ts and src/youtube/summarizer.ts

// ============================================
// DEEP URL FETCHING
// ============================================

// cleanAgentOutput imported from ../scraping/clean-output.js

async function deepFetchUrl(url: string, ideaTitle: string): Promise<string | null> {
  if (!url) return null;

  // Handle Twitter/X URLs via agent-browser
  if (url.includes("twitter.com") || url.includes("x.com")) {
    try {
      const result = await executeBrowserScrape(
        buildTweetReadPrompt(url),
        "",
        DEEP_FETCH_OPTIONS,
      );
      if (result.exitCode === 0 && result.output && result.output.length > 50 && !result.output.includes("FAILED")) {
        const cleaned = cleanAgentOutput(result.output);
        return cleaned.slice(0, 10000) || null;
      }
    } catch {
      // Fall through to return null
    }
    return null;
  }

  // YouTube URLs are now handled by the Telegram → overnight pipeline
  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    return null;
  }

  // Handle other URLs with standard fetch
  const prompt = `Fetch and analyze this URL: ${url}

Context: This is linked from an idea titled "${ideaTitle}"

Instructions:
1. Fetch the URL content
2. Extract the key information (what is it about, main features, why it matters)
3. Summarize in 2-3 paragraphs
4. If it's a GitHub repo, include: stars, language, main purpose, notable features
5. If it's an article, include: main thesis, key points, author's conclusion

Return ONLY the analysis, no preamble.`;

  try {
    // Primary: OpenCode Gemini Flash
    const result = await executeOpenCodeCLI(prompt, "", {
      model: "google/gemini-3-flash-preview",
      researchOnly: true,
      timeout: 60000,
    });

    if (result.exitCode === 0 && result.output && result.output.length > 100) {
      return result.output.trim();
    }

    // Fallback: Claude Code Sonnet
    const fallback = await executeClaudeCommand(prompt, {
      cwd: process.env.HOME ?? "/Users/yj",
      model: "sonnet",
      timeout: 60000,
    });

    if (fallback.exitCode === 0 && fallback.output && fallback.output.length > 100) {
      return fallback.output.trim();
    }

    return null;
  } catch (error) {
    logger.warn({ url, error }, "Deep fetch failed");
    return null;
  }
}

// ============================================
// DENY HISTORY MANAGEMENT
// ============================================

function addToDenyHistory(idea: ParsedIdea, reason: string): void {
  if (!existsSync(DENY_HISTORY_FILE)) {
    logger.warn("deny-history.md not found, skipping");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const entry = `
### [${today}] ${idea.title}
- **Source:** ${idea.source}
- **Link:** ${idea.link || "N/A"}
- **Reason:** ${reason}
- **ID:** ${idea.id}
`;

  // Append to Denied Items section
  const content = readFileSync(DENY_HISTORY_FILE, "utf-8");
  if (content.includes("## Denied Items")) {
    const updated = content.replace(
      "## Denied Items",
      `## Denied Items\n${entry}`
    );
    writeFileSync(DENY_HISTORY_FILE, updated, "utf-8");
    logger.info({ id: idea.id, title: idea.title }, "Added to deny history");
  } else {
    // Append at end if section not found
    appendFileSync(DENY_HISTORY_FILE, `\n## Denied Items\n${entry}`);
  }
}

function checkAndArchiveToDeny(existingIdeas: ParsedIdea[]): number {
  let archived = 0;

  for (const idea of existingIdeas) {
    if (idea.status === "archived" && idea.notes?.toLowerCase().includes("denied")) {
      // Already archived with denial - add to deny history
      addToDenyHistory(idea, idea.notes || "User archived/denied");
      archived++;
    }
  }

  return archived;
}

// ============================================
// MAIN INGESTION FUNCTION
// ============================================

export async function ingestIdeasFromLegacy(db: Database.Database): Promise<IngestResult> {
  const result: IngestResult = {
    ingested: 0,
    skipped: 0,
    enriched: 0,
    fromTwitter: 0,
    archivedToDeny: 0,
    errors: [],
  };

  // Ensure Chrome CDP is available for bookmark scraping
  let chromeHandle: { pid: number; cleanup: () => void } | null = null;
  try {
    chromeHandle = await ensureCDP();
    logger.info({ pid: chromeHandle.pid }, "Chrome CDP ready for idea ingest");
  } catch (err) {
    logger.warn({ error: String(err) }, "Chrome CDP launch failed — bookmark scrape may fail");
  }

  try {

  // Load existing ideas from DB (fallback to files)
  const existingIdeas = dao.getAllIdeas(db);
  const existingIds = new Set(existingIdeas.map((i) => i.id));
  const existingTitles = new Set(existingIdeas.map((i) => i.title.toLowerCase()));

  // Check for archived ideas that need to go to deny-history
  result.archivedToDeny = checkAndArchiveToDeny(existingIdeas);

  // ========== SOURCE 1: Twitter/X Bookmarks ==========
  try {
    const twitterIdeas = await scrapeTwitterBookmarks();
    const newIdeas = twitterIdeas.filter(
      (idea) => !existingIds.has(idea.id) && !existingTitles.has(idea.title.toLowerCase()),
    );
    result.skipped += twitterIdeas.length - newIdeas.length;

    // Deep-link tweet threads + external URLs in parallel (3 at a time)
    const CONCURRENCY = 3;
    for (let i = 0; i < newIdeas.length; i += CONCURRENCY) {
      const batch = newIdeas.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (idea) => {
        // Deep-link the tweet thread itself for full content
        if (idea.link) {
          const threadContent = await deepFetchUrl(idea.link, idea.title);
          if (threadContent) {
            const author = idea.link.split("/")[3] ?? "";
            idea.content = `**@${author}**: ${threadContent}`;
            // Fix title if it was empty from bookmark list (X Articles, long threads)
            if (idea.title === "X: " || idea.title === "X:" || !idea.title.replace(/^X:\s*/, "").trim()) {
              const firstLine = threadContent.split("\n")[0]?.trim() ?? "";
              const titleText = firstLine.slice(0, 80).replace(/[#*_~`]/g, "").trim();
              idea.title = titleText ? `X: ${titleText}${firstLine.length > 80 ? "..." : ""}` : `X: @${author} thread`;
            }
            result.enriched++;
          }
        }

        // Also deep-fetch external links if present
        if (idea.context?.startsWith("External link:")) {
          const externalUrl = idea.context.replace("External link: ", "");
          const enriched = await deepFetchUrl(externalUrl, idea.title);
          if (enriched) {
            idea.content += `\n\n## Linked Content\n\n${enriched}`;
          }
        }
      }));
    }

    for (const idea of newIdeas) {
      // Write to scrapes table for provenance tracking
      insertScrape(db, {
        id: idea.id,
        source: "x-bookmark",
        url: idea.link,
        title: idea.title,
        author: idea.content.match(/@(\w+)/)?.[1] ?? undefined,
        raw_content: idea.content,
        metadata: JSON.stringify({ tags: idea.tags }),
      });

      // Save idea to DB (+ mirror file)
      if (process.env.LEGACY_INGEST !== "0") {
        dao.createIdea(db, idea);
      }
      existingIds.add(idea.id);
      existingTitles.add(idea.title.toLowerCase());
      result.ingested++;
      result.fromTwitter++;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Twitter scrape failed: ${msg}`);
    logger.error({ error }, "Twitter scraping failed");
  }

  // YouTube ingestion is now handled via Telegram → overnight pipeline
  // (see src/youtube/ and src/bot/handlers/youtube.ts)

  // ========== SOURCE 2: Legacy ideas.md ==========
  if (existsSync(IDEAS_FILE)) {
    const content = readFileSync(IDEAS_FILE, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;

    const syncState = getSyncState(db);
    const lastSyncedLine = syncState.last_line_number;

    if (totalLines > lastSyncedLine) {
      const allIdeas = parseIdeasMd(content);
      const newIdeas: ParsedIdea[] = [];

      let currentLine = 0;
      let currentIdea: ParsedIdea | null = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const ideaMatch = line.match(/^### \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (.+)$/);
        if (ideaMatch) {
          if (currentIdea && currentLine > lastSyncedLine) {
            newIdeas.push(currentIdea);
          }
          currentLine = i;
          const matchingIdea = allIdeas.find(
            (idea) => idea.timestamp === ideaMatch[1] && idea.title === ideaMatch[2]
          );
          currentIdea = matchingIdea ?? null;
        }
      }

      if (currentIdea && currentLine > lastSyncedLine) {
        newIdeas.push(currentIdea);
      }

      for (const idea of newIdeas) {
        try {
          if (existingIds.has(idea.id) || existingTitles.has(idea.title.toLowerCase())) {
            result.skipped++;
            continue;
          }

          ensureIdeaId(idea);

          // Deep fetch linked URL
          if (idea.link) {
            const enriched = await deepFetchUrl(idea.link, idea.title);
            if (enriched) {
              idea.content = (idea.content || "") + `\n\n## Deep Fetch Analysis\n\n${enriched}`;
              result.enriched++;
            }
          }

          // Write to scrapes table
          insertScrape(db, {
            id: idea.id,
            source: "legacy-ideas-md",
            url: idea.link,
            title: idea.title,
            raw_content: idea.content || "",
          });

          // Save idea to DB (+ mirror file)
          if (process.env.LEGACY_INGEST !== "0") {
            dao.createIdea(db, idea);
          }
          existingIds.add(idea.id);
          existingTitles.add(idea.title.toLowerCase());
          result.ingested++;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push(`Failed to ingest "${idea.title}": ${msg}`);
        }
      }

      updateSyncState(db, totalLines);
    }
  }

  logger.info({
    ingested: result.ingested,
    enriched: result.enriched,
    fromTwitter: result.fromTwitter,
    archivedToDeny: result.archivedToDeny,
    skipped: result.skipped,
    errors: result.errors.length,
  }, "Idea ingestion complete");

  return result;

  } finally {
    // Clean up Chrome CDP if we launched it
    if (chromeHandle && chromeHandle.pid > 0) {
      chromeHandle.cleanup();
      logger.debug("Chrome CDP cleaned up after idea ingest");
    }
  }
}
