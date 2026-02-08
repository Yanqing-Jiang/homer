import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import type Database from "better-sqlite3";
import { parseIdeasMd, saveIdeaFile, loadIdeasFromDir, type ParsedIdea } from "./parser.js";
import { logger } from "../utils/logger.js";
import { executeGeminiWithFallback } from "../executors/opencode-cli.js";

const MEMORY_PATH = process.env.MEMORY_PATH ?? "/Users/yj/memory";
const IDEAS_FILE = join(MEMORY_PATH, "ideas.md");
const DENY_HISTORY_FILE = join(MEMORY_PATH, "deny-history.md");

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
// TWITTER/X SCRAPING
// ============================================

async function runBirdCommand(args: string[]): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn("bird", args, {
      timeout: 60000,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      resolve({
        success: code === 0,
        output: stdout || stderr,
      });
    });

    proc.on("error", (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

async function scrapeTwitterBookmarks(): Promise<ParsedIdea[]> {
  logger.info("Scraping Twitter/X bookmarks via bird CLI");

  const result = await runBirdCommand(["bookmarks", "-n", "20", "--json"]);
  if (!result.success) {
    logger.warn({ output: result.output }, "Bird CLI failed to fetch bookmarks");
    return [];
  }

  let bookmarks: TwitterBookmark[] = [];
  try {
    bookmarks = JSON.parse(result.output);
  } catch {
    logger.warn("Failed to parse bird CLI output as JSON");
    return [];
  }

  const ideas: ParsedIdea[] = [];
  const now = new Date();
  const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;

  for (const bookmark of bookmarks) {
    // Extract URLs from bookmark
    const urls = bookmark.urls || [];
    const hasExternalLink = urls.some(u => !u.includes("twitter.com") && !u.includes("x.com"));

    // Create idea from bookmark
    const idea: ParsedIdea = {
      id: `tweet_${bookmark.id}`,
      title: `X: ${bookmark.text.slice(0, 60)}${bookmark.text.length > 60 ? "..." : ""}`,
      status: "draft",
      source: "x-bookmarks",
      content: `**@${bookmark.author}**: ${bookmark.text}`,
      link: `https://x.com/i/status/${bookmark.id}`,
      tags: ["x-bookmark"],
      timestamp,
    };

    // If there's an external link, add it for deep fetching
    if (hasExternalLink) {
      const externalUrl = urls.find(u => !u.includes("twitter.com") && !u.includes("x.com"));
      if (externalUrl) {
        idea.context = `External link: ${externalUrl}`;
      }
    }

    ideas.push(idea);
  }

  logger.info({ count: ideas.length }, "Extracted ideas from Twitter bookmarks");
  return ideas;
}

// YouTube scraping has been moved to Telegram → overnight pipeline.
// See src/youtube/transcript.ts and src/youtube/summarizer.ts

// ============================================
// DEEP URL FETCHING
// ============================================

async function deepFetchUrl(url: string, ideaTitle: string): Promise<string | null> {
  if (!url) return null;

  // Handle Twitter/X URLs with bird CLI
  if (url.includes("twitter.com") || url.includes("x.com")) {
    const tweetIdMatch = url.match(/status\/(\d+)/);
    if (tweetIdMatch && tweetIdMatch[1]) {
      const result = await runBirdCommand(["read", tweetIdMatch[1], "--json"]);
      if (result.success) {
        try {
          const thread = JSON.parse(result.output);
          if (Array.isArray(thread) && thread.length > 0) {
            return thread.map((t: { author?: string; text?: string }) =>
              `@${t.author}: ${t.text}`
            ).join("\n\n");
          }
        } catch {
          return result.output.slice(0, 2000);
        }
      }
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
    const result = await executeGeminiWithFallback(prompt, "", {
      model: "gemini-3-flash-preview",
      sandbox: true,
      timeout: 60000,
    });

    if (result.exitCode === 0 && result.output && result.output.length > 100) {
      return result.output.trim();
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

  // Load existing ideas
  const existingIdeas = loadIdeasFromDir();
  const existingIds = new Set(existingIdeas.map((i) => i.id));
  const existingTitles = new Set(existingIdeas.map((i) => i.title.toLowerCase()));

  // Check for archived ideas that need to go to deny-history
  result.archivedToDeny = checkAndArchiveToDeny(existingIdeas);

  // ========== SOURCE 1: Twitter/X Bookmarks ==========
  try {
    const twitterIdeas = await scrapeTwitterBookmarks();
    for (const idea of twitterIdeas) {
      if (existingIds.has(idea.id) || existingTitles.has(idea.title.toLowerCase())) {
        result.skipped++;
        continue;
      }

      // Deep fetch external links if present
      if (idea.context?.startsWith("External link:")) {
        const externalUrl = idea.context.replace("External link: ", "");
        const enriched = await deepFetchUrl(externalUrl, idea.title);
        if (enriched) {
          idea.content += `\n\n## Linked Content Analysis\n\n${enriched}`;
          result.enriched++;
        }
      }

      saveIdeaFile(idea);
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

          saveIdeaFile(idea);
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
}
