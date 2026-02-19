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
// CONTENT SCRAPER PROMPTS (Medium + LinkedIn)
// ============================================

const MEDIUM_URL = "https://medium.com/@yanqing_j";
const LINKEDIN_URL = "https://www.linkedin.com/in/jiangyanqing/recent-activity/all/";

export function buildMediumScrapePrompt(): string {
  return `Scrape all published articles from a Medium profile page using agent-browser CLI.

You MUST execute these bash commands in sequence — do not just list them, actually RUN them:

${AGENT_BROWSER_TOOLS}

Step 1: agent-browser connect 9222
Step 2: agent-browser open "${MEDIUM_URL}"
Step 3: sleep 3
Step 4: agent-browser snapshot -i

Read the snapshot carefully. For each article card visible, extract:
- **Title**: the article headline text
- **URL**: the href from the article title link (MUST be from actual @ref)
- **Date**: publication date exactly as shown (e.g. "Jan 15, 2026")
- **Read time**: if visible in the card
- **Preview text**: the subtitle/preview snippet shown on the card

Step 5: agent-browser scroll down
Step 6: sleep 2
Step 7: agent-browser snapshot -i
Step 8: Extract any NEW articles not already in your list (compare titles)
Step 9: Repeat Steps 5-8 until no new articles appear in two consecutive scrolls

CRITICAL RULES:
- DO NOT click into individual articles. Extract only what is visible on the profile page.
- Article titles MUST come from actual headline elements in the snapshot. Do NOT fabricate titles.
- Publication dates MUST come from visible date elements, NOT invented.
- Clap counts MUST be visible numbers (e.g., "42 claps", "1.2K"). If not visible, use null.
- If the page shows "Sign in", "Open in app", or a Cloudflare challenge, return ONLY the text: AUTH_REQUIRED
- If the page loads but shows 0 articles, return: []
- Stop scrolling after 2 consecutive scrolls with no new articles, or after 30 scrolls total.

OUTPUT FORMAT - Return ONLY a JSON array, no other text:
[{"title": "Article Title", "date": "Jan 2026", "read_time": "5 min", "claps": 42, "responses": 3, "content": "Preview/subtitle text from the card...", "link": "https://medium.com/..."}]

If any error or blocking, return: []`;
}

export function buildLinkedInScrapePrompt(): string {
  return `Scrape all published posts from a LinkedIn activity page using agent-browser CLI.

You MUST execute these bash commands in sequence — do not just list them, actually RUN them:

${AGENT_BROWSER_TOOLS}

Step 1: agent-browser connect 9222
Step 2: agent-browser open "${LINKEDIN_URL}"
Step 3: sleep 5
Step 4: agent-browser snapshot -i

FIRST: Check if the page shows "Sign in", "Join LinkedIn", or a login modal. If so, return ONLY the text: AUTH_REQUIRED

For each post visible, extract:
- **Content**: the full post text visible in the feed
- **Date**: relative date exactly as shown (e.g. "2d", "1w", "1mo")
- **Reactions**: count of reactions/likes (number only, MUST be visible)
- **Comments**: count of comments (number only, MUST be visible)
- **Links**: any external URLs in the post

Step 5: agent-browser scroll down
Step 6: sleep 3
Step 7: agent-browser snapshot -i
Step 8: Extract any NEW posts not already in your list (compare by first 10 words of content)
Step 9: Repeat Steps 5-8 until no new posts appear in two consecutive scrolls

CRITICAL RULES:
- Reaction/comment counts MUST come from actual numbers shown in the snapshot. If not visible, use null.
- Do NOT fabricate or estimate engagement numbers.
- If a "Verification Required" or CAPTCHA appears, return ONLY the text: BOT_DETECTED
- LinkedIn truncates posts with "...see more". Extract only the visible text, do NOT click "see more".
- Stop scrolling after 2 consecutive scrolls with no new content, or after 20 scrolls total.

OUTPUT FORMAT - Return ONLY a JSON array, no other text:
[{"title": "First 10 words as title", "date": "2d", "reactions": 5, "comments": 2, "content": "Full visible post text", "link": "https://..."}]

If login required or blocked, return: []`;
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
