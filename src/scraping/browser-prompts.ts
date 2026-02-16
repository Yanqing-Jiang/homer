/**
 * Shared browser scraping prompts and options.
 *
 * All Twitter/X scraping callers (ingest.ts, ideas-explore.ts, twitter.ts)
 * import from here to ensure consistent tool documentation, constraints,
 * and browserOnly mode.
 */

import type { OpenCodeCLIOptions } from "../executors/opencode-cli.js";

// ============================================
// TOOL DOCUMENTATION
// ============================================

export const AGENT_BROWSER_TOOLS = `TOOLS AVAILABLE (via bash):
- agent-browser connect 9222          # connect to Chrome DevTools
- agent-browser snapshot -i           # get interactive elements with @refs
- agent-browser open <url>            # navigate to URL
- agent-browser click @ref            # click element
- agent-browser scroll down           # scroll page down`;

// ============================================
// PROMPT BUILDERS
// ============================================

export function buildBookmarkScrapePrompt(maxItems: number): string {
  return `Scrape Twitter/X bookmarks using agent-browser CLI. Return the bookmarks as JSON.

${AGENT_BROWSER_TOOLS}

WORKFLOW:
1. Connect to browser: agent-browser connect 9222
2. Navigate to Twitter bookmarks: agent-browser open "https://x.com/i/bookmarks"
3. Wait for page load, then snapshot -i
4. Extract bookmark content from the snapshot. Each bookmark is an <article> element containing:
   - **Tweet text**: the main text content inside the article
   - **Author username**: from the link like /@username (e.g. /OpenAIDevs → "OpenAIDevs")
   - **Tweet ID**: CRITICAL — extract from the permalink URL like /@user/status/1234567890 — the numeric part is the ID. Do NOT invent IDs.
   - **External URLs**: any https://t.co/ or other non-twitter links
5. Scroll down to get more bookmarks (up to ${maxItems})
6. After each scroll, snapshot -i and extract new bookmarks

CRITICAL RULES:
- Tweet IDs MUST come from the actual permalink URLs in the snapshot (e.g. /username/status/2021725246244671606)
- Do NOT guess or fabricate tweet IDs — if you can't find the permalink URL, omit the "id" field
- Author usernames MUST come from the actual /@username links in the snapshot

OUTPUT FORMAT:
Return ONLY a JSON array, no other text:
[{"id": "tweet_id", "text": "tweet content", "author": "username", "urls": ["https://..."]}]

If bookmarks page is empty or requires login, return: []
If you can't connect to the browser, return: []`;
}

export function buildTweetReadPrompt(url: string): string {
  // Extract author from URL for thread filtering (e.g. x.com/OpenAIDevs/status/123 → OpenAIDevs)
  const authorMatch = url.match(/x\.com\/([^/]+)\/status/);
  const author = authorMatch?.[1] ?? "";

  return `Read a Twitter/X thread and return the ORIGINAL AUTHOR's content only.

You MUST execute these bash commands in sequence — do not just list them, actually RUN them:

Step 1: agent-browser connect 9222
Step 2: agent-browser open "${url}"
Step 3: sleep 2
Step 4: agent-browser snapshot

Read the snapshot output carefully:
- If it says "doesn't exist" or "Something went wrong", return ONLY the word: FAILED
- Otherwise, extract ONLY tweets by @${author || "the original author"} — skip all replies and comments from other users
- If the thread continues, run: agent-browser scroll down && sleep 1 && agent-browser snapshot
- Extract any additional tweets by the same author from the new snapshot

Return the thread as plain text, one tweet per paragraph.
Do NOT include replies or comments from other users.
Do NOT try alternative URLs if the page fails — just return FAILED.`;
}

// ============================================
// SHARED OPTIONS
// ============================================

export const SCRAPE_OPTIONS: OpenCodeCLIOptions = {
  model: "google/gemini-3-flash-preview",
  browserOnly: true,
  timeout: 600_000,
};

export const DEEP_FETCH_OPTIONS: OpenCodeCLIOptions = {
  model: "google/gemini-3-flash-preview",
  browserOnly: true,
  timeout: 120_000,
};
