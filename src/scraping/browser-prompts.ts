/**
 * Shared browser scraping prompts and options.
 *
 * All Twitter/X scraping callers (ingest.ts, ideas-explore.ts, twitter.ts)
 * import from here to ensure consistent tool documentation, constraints,
 * and browserOnly mode.
 */

import type { ClaudeExecutorOptions } from "../executors/claude.js";

// ============================================
// TOOL DOCUMENTATION
// ============================================

export const AGENT_BROWSER_TOOLS = `TOOLS AVAILABLE (via bash):
- agent-browser connect 9222             # connect to Chrome DevTools
- agent-browser snapshot -i -c           # interactive elements only, compact (smallest token footprint)
- agent-browser snapshot -i -c -s "sel"  # scoped to CSS selector (use for targeted reads)
- agent-browser open <url>               # navigate to URL
- agent-browser click @ref               # click element by ref from snapshot
- agent-browser scroll down [px]         # scroll down (optional pixel amount)
- agent-browser scrollintoview @ref      # scroll element into view
- agent-browser wait <sel|ms>            # wait for element or milliseconds
- agent-browser screenshot [path]        # take screenshot (for visual debugging)
- agent-browser eval <js>                # run JavaScript on page`;

// ============================================
// BOOKMARK EXTRACTION — MARKERS
// ============================================

export const BOOKMARK_JSON_START = "__HOMER_X_BOOKMARKS_JSON_START__";
export const BOOKMARK_JSON_END = "__HOMER_X_BOOKMARKS_JSON_END__";

// ============================================
// PROMPT BUILDERS
// ============================================

/**
 * Phase 1: Extraction-only bookmark scrape.
 * No deep-fetching, no enrichment, no analysis.
 * Returns marker-wrapped JSON array of raw bookmark facts.
 */
export function buildBookmarkScrapePrompt(maxItems: number): string {
  return `Extract up to ${maxItems} visible bookmarks from X bookmarks page. EXTRACTION ONLY — no analysis.

${AGENT_BROWSER_TOOLS}

STEPS:
1. agent-browser connect 9222
2. agent-browser open "https://x.com/i/bookmarks"
3. agent-browser wait 3000
4. agent-browser snapshot -i -c
5. From the snapshot, extract each visible bookmark:
   - id: the numeric tweet ID from /status/DIGITS in the permalink (REQUIRED — skip bookmark if not found)
   - author: the username from /@username link (REQUIRED — skip if not found)
   - url: canonical tweet URL https://x.com/{author}/status/{id}
   - text: full visible tweet text content (REQUIRED — min 15 chars, skip if too short)
   - external_urls: array of non-X URLs visible in the tweet (empty array if none)
6. If fewer than ${maxItems} valid bookmarks found, scroll and extract more:
   - agent-browser scroll down 900
   - agent-browser wait 2500
   - agent-browser snapshot -i -c
   - Extract new bookmarks (skip duplicates by id)
7. Repeat step 6 up to 2 more times or until ${maxItems} reached.

RULES:
- id MUST come from actual /status/DIGITS URLs in the snapshot. SKIP any bookmark without a real numeric ID.
- author MUST come from actual /@username links. Never fabricate.
- text must be the complete visible tweet text, not truncated.
- external_urls must exclude x.com and twitter.com URLs. Use empty array [] if none.
- Do NOT open tweet detail pages — extract only from bookmark card snapshots.
- Do NOT open external URLs — that happens in a separate step.
- Do NOT add analysis, summaries, titles, hook analysis, or deep-link hints.
- If bookmarks page requires login or is empty, return an empty array.
- If browser connection fails, return an empty array.

OUTPUT CONTRACT — output exactly these 3 sections:
${BOOKMARK_JSON_START}
[{"id":"1234567890","author":"example","url":"https://x.com/example/status/1234567890","text":"Visible tweet text here","external_urls":["https://example.com/article"]}]
${BOOKMARK_JSON_END}

No markdown fences. No prose. No commentary outside the markers.`;
}

export function buildTweetReadPrompt(url: string): string {
  // Extract author from URL for thread filtering (e.g. x.com/OpenAIDevs/status/123 → OpenAIDevs)
  const authorMatch = url.match(/x\.com\/([^/]+)\/status/);
  const author = authorMatch?.[1] ?? "";

  return `Read a Twitter/X thread and return the ORIGINAL AUTHOR's content only.

You MUST execute these bash commands in sequence — do not just list them, actually RUN them:

Step 1: agent-browser connect 9222
Step 2: agent-browser open "${url}"
Step 3: agent-browser wait 3000
Step 4: agent-browser snapshot -i -c

Read the snapshot output carefully:
- If it says "doesn't exist" or "Something went wrong", return ONLY the word: FAILED
- Otherwise, extract ONLY tweets by @${author || "the original author"} — skip all replies and comments from other users
- If the thread continues, run: agent-browser scroll down && agent-browser wait 2000 && agent-browser snapshot -i -c
- Extract any additional tweets by the same author from the new snapshot

Return the thread as plain text, one tweet per paragraph.
Do NOT include replies or comments from other users.
Do NOT try alternative URLs if the page fails — just return FAILED.`;
}

// ============================================
// CONTENT SCRAPER PROMPTS (Medium + LinkedIn)
// ============================================

const MEDIUM_URL = process.env.MEDIUM_PROFILE_URL ?? "";
const LINKEDIN_HANDLE = process.env.LINKEDIN_HANDLE ?? "";
const LINKEDIN_URL = LINKEDIN_HANDLE ? `https://www.linkedin.com/in/${LINKEDIN_HANDLE}/recent-activity/all/` : "";
const LINKEDIN_ALT_URL_1 = LINKEDIN_HANDLE ? `https://www.linkedin.com/in/${LINKEDIN_HANDLE}/details/recent-activity/posts/` : "";
const LINKEDIN_ALT_URL_2 = LINKEDIN_HANDLE ? `https://www.linkedin.com/in/${LINKEDIN_HANDLE}/details/recent-activity/shares/` : "";

export function buildMediumScrapePrompt(): string {
  return `Scrape all published articles from a Medium profile page using agent-browser CLI.

You MUST execute these bash commands in sequence — do not just list them, actually RUN them:

${AGENT_BROWSER_TOOLS}

Step 1: agent-browser connect 9222
Step 2: agent-browser open "${MEDIUM_URL}"
Step 3: agent-browser wait 3000
Step 4: agent-browser snapshot -i -c

Read the snapshot carefully. For each article card visible, extract:
- **Title**: the article headline text
- **URL**: the href from the article title link (MUST be from actual @ref)
- **Date**: publication date exactly as shown (e.g. "Jan 15, 2026")
- **Read time**: if visible in the card
- **Preview text**: the subtitle/preview snippet shown on the card

Step 5: agent-browser scroll down
Step 6: agent-browser wait 2000
Step 7: agent-browser snapshot -i -c
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

export function buildMediumForYouScrapePrompt(maxItems: number = 5): string {
  return `Find the top ${maxItems} most compelling articles currently visible in Medium's "For you" feed using agent-browser CLI.

You MUST execute these bash commands in sequence — do not just list them, actually RUN them:

${AGENT_BROWSER_TOOLS}

Step 1: agent-browser connect 9222
Step 2: agent-browser open "https://medium.com/"
Step 3: agent-browser wait 4000
Step 4: agent-browser snapshot -i -c
Step 5: If a "For you" tab or link is visible, click it, agent-browser wait 2000, then snapshot -i -c again
Step 6: Rank the visible "For you" article cards by prominence and interest. Work on the top ${maxItems}.
Step 7: For each selected article, open it and try to extract:
  - title
  - author
  - date
  - first meaningful paragraph
  - as much body text as is accessible
Step 8: If the article is member-only or partially blocked, retry via:
  agent-browser open "https://medium.com/m/global-identity?redirectUrl=<ENCODED_URL>"
  then agent-browser wait 4000, snapshot -c, scroll down, agent-browser wait 2000, snapshot -c
Step 9: If the body still is not accessible, keep the title plus first meaningful paragraph only
Step 10: Analyze the hook: explain why the headline + opening paragraph are likely to pull readers in, or why they are weak

CRITICAL RULES:
- Stay on the signed-in Medium session via CDP
- Do not fabricate body text, clap counts, or authors
- "For you" is the source of truth, not tag pages or generic trending pages
- content must contain the best available article text: full body if accessible, otherwise the first paragraph

OUTPUT FORMAT - Return ONLY a JSON array:
[{
  "title": "Article title",
  "author": "Author name",
  "date": "Mar 9, 2026",
  "link": "https://medium.com/...",
  "first_paragraph": "Opening paragraph",
  "hook_analysis": "Why the hook works",
  "content": "Full body text if accessible, otherwise the opening paragraph",
  "source": "medium-for-you",
  "read_time": "5 min"
}]

If sign-in is required or the feed cannot be read, return []`;
}

export function buildLinkedInScrapePrompt(): string {
  return `Scrape all published posts from a LinkedIn activity page using agent-browser CLI.

You MUST execute these bash commands in sequence — do not just list them, actually RUN them:

${AGENT_BROWSER_TOOLS}

Step 1: agent-browser connect 9222
Step 2: agent-browser open "${LINKEDIN_URL}"
Step 3: agent-browser wait 2000
Step 4: agent-browser snapshot -i -c

If the initial page has no post cards or redirects, try these alternate public activity URLs:
- agent-browser open "${LINKEDIN_ALT_URL_1}" && agent-browser wait 2000 && agent-browser snapshot -i -c
- agent-browser open "${LINKEDIN_ALT_URL_2}" && agent-browser wait 2000 && agent-browser snapshot -i -c

FIRST: Check if the page shows "Sign in", "Join LinkedIn", or a login modal. If so, return ONLY the text: AUTH_REQUIRED

For each post visible:
- **Content**: the FULL post text. If a post is truncated with "...see more", click the "see more" link using agent-browser click @ref, wait 1s, then snapshot again to get the full text.
- **Date**: relative date exactly as shown (e.g. "2d", "1w", "1mo")
- **Reactions**: count of reactions/likes (number only, MUST be visible)
- **Comments**: count of comments (number only, MUST be visible)
- **Links**: any external URLs in the post

Step 5: agent-browser scroll down
Step 6: agent-browser wait 1000
Step 7: agent-browser snapshot -i -c
Step 8: For any new posts with truncated text, click "see more" and capture the full text
Step 9: Extract any NEW posts not already in your list (compare by first 10 words of content)
Step 10: Repeat Steps 5-9 until no new posts appear in two consecutive scrolls

CRITICAL RULES:
- Reaction/comment counts MUST come from actual numbers shown in the snapshot. If not visible, use null.
- Do NOT fabricate or estimate engagement numbers.
- Click "see more" to get FULL post text — truncated posts lose value.
- If a "Verification Required" or CAPTCHA appears, return ONLY the text: BOT_DETECTED
- Stop scrolling after 2 consecutive scrolls with no new content, or after 10 scrolls total.

OUTPUT FORMAT - Return ONLY a JSON array, no other text:
[{"title": "First 10 words as title", "date": "2d", "reactions": 5, "comments": 2, "content": "Full visible post text", "link": "https://..."}]

If login required, return ONLY: AUTH_REQUIRED
If verification or CAPTCHA appears, return ONLY: BOT_DETECTED
If page loads but no posts are visible, return ONLY: []`;
}

export function buildLinkedInTopPostPrompt(): string {
  return `Find the single hottest or most-trendy recent Yanqing Jiang LinkedIn activity item and return it as JSON.

You MUST execute these bash commands in sequence — do not just list them, actually RUN them:

${AGENT_BROWSER_TOOLS}

Step 1: agent-browser connect 9222
Step 2: agent-browser open "${LINKEDIN_URL}"
Step 3: agent-browser wait 3000
Step 4: agent-browser snapshot -i -c

If the initial page has no post cards or redirects, try these alternate URLs:
- agent-browser open "${LINKEDIN_ALT_URL_1}" && agent-browser wait 2000 && agent-browser snapshot -i -c
- agent-browser open "${LINKEDIN_ALT_URL_2}" && agent-browser wait 2000 && agent-browser snapshot -i -c

If the page shows "Sign in", "Join LinkedIn", or a login modal, return ONLY: AUTH_REQUIRED
If a verification wall or CAPTCHA appears, return ONLY: BOT_DETECTED

WORKFLOW:
1. Inspect recent activity items authored by Yanqing Jiang.
2. Expand "see more" where needed to read the opening clearly.
3. Compare items using visible reactions/comments and obvious recency/prominence signals.
4. Pick the hottest single item.
5. Extract:
   - title: use the linked article headline if there is one, otherwise write a concise title from the post opening
   - date
   - reactions
   - comments
   - link
   - first_paragraph: first meaningful paragraph or opening 1-3 sentences
   - content: the best visible body text from the selected item
   - hook_analysis: 2-4 sentences on why the opening hook works or falls flat

OUTPUT FORMAT - Return ONLY a JSON array with one object:
[{
  "title": "Concise title",
  "date": "2d",
  "reactions": 85,
  "comments": 14,
  "link": "https://www.linkedin.com/...",
  "first_paragraph": "Opening paragraph or opening 1-3 sentences",
  "hook_analysis": "Why this hook works",
  "content": "Best visible body text from the selected post or article",
  "source": "linkedin-top-post",
  "author": "Yanqing Jiang"
}]

If page loads but no authored activity is visible, return []`;
}

export function buildLinkedInPublicFallbackPrompt(maxItems: number = 20): string {
  const ownerName = process.env.OWNER_DISPLAY_NAME ?? "the profile owner";
  const linkedinHandle = process.env.LINKEDIN_HANDLE ?? "";
  return `Find PUBLIC LinkedIn posts authored by ${ownerName} using web search (no browser automation).

Goal:
- Recover data when direct LinkedIn scraping returns AUTH_REQUIRED.
- Return up to ${maxItems} posts from public LinkedIn URLs indexed on the web.

Search strategy (run multiple queries):
1) site:linkedin.com/posts "${ownerName}"
2) site:linkedin.com/feed/update "${ownerName}"
3) site:linkedin.com "${linkedinHandle}" "linkedin.com/posts"

For each relevant result, extract:
- title: First 8-12 words of the post text or snippet
- date: Date shown in search snippet or page preview if available (otherwise omit)
- reactions: number if clearly visible, else null
- comments: number if clearly visible, else null
- content: short excerpt/summary (40-280 chars)
- link: canonical linkedin.com post URL

Rules:
- Include only posts very likely authored by Yanqing Jiang.
- Do not fabricate engagement metrics.
- Exclude duplicate URLs.
- If no reliable results, return []

OUTPUT FORMAT:
Return ONLY a JSON array:
[{"title":"...","date":"...","reactions":null,"comments":null,"content":"...","link":"https://www.linkedin.com/..."}]`;
}

// Medium partner publication domains — session cookies are medium.com-scoped
// and may not apply here; apply body-first logic before returning PAYWALL.
const MEDIUM_PARTNER_HOSTS = [
  "towardsdatascience.com",
  "betterprogramming.pub",
  "uxdesign.cc",
  "levelup.gitconnected.com",
  "itnext.io",
  "javascript.plainenglish.io",
  "blog.devgenius.io",
];

function safeHostname(rawUrl: string): string {
  try { return new URL(rawUrl).hostname.toLowerCase(); } catch { return ""; }
}

function isMediumPartnerHost(host: string): boolean {
  if (!host || host === "medium.com" || host.endsWith(".medium.com")) return false;
  return MEDIUM_PARTNER_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Deep-fetch a single article URL and return its full body text.
 * Used for Medium trending articles (RSS only has teasers).
 *
 * Key fix: BODY-FIRST detection — Medium always shows "Member-only story" badge
 * even when the article is unlocked for logged-in members. Only return PAYWALL
 * if NO article body paragraphs exist after scrolling.
 */
export function buildArticleDeepFetchPrompt(url: string): string {
  const host = safeHostname(url);
  const partner = isMediumPartnerHost(host);

  const partnerNote = partner
    ? `PARTNER-DOMAIN NOTE (host: "${host}"):
- Medium session cookie (medium.com-scoped) may not apply to this domain.
- Do NOT return PAYWALL just because "Member-only story" badge is visible.
- If no article body found after scrolling, retry with canonical Medium URL:
  open "https://medium.com/m/global-identity?redirectUrl=${encodeURIComponent(url)}"
  Then: agent-browser wait 4000 → snapshot -c → scroll down → agent-browser wait 2000 → snapshot -c.
  Re-apply BODY-FIRST DECISION LOGIC after retry.`
    : `If redirected to a partner publication domain, still apply body-first logic before deciding PAYWALL.`;

  return `Fetch the full text of this article using agent-browser CLI.

You MUST execute these commands in order and actually RUN them:

${AGENT_BROWSER_TOOLS}

Step 1: agent-browser connect 9222
Step 2: agent-browser open "${url}"
Step 3: agent-browser wait 5000
Step 4: agent-browser snapshot -c -s "article, main, [role=main], .content, #content"
   (If scoped snapshot is empty, fall back to: agent-browser snapshot -c)
Step 5: agent-browser scroll down
Step 6: agent-browser wait 2000
Step 7: agent-browser snapshot -c -s "article, main, [role=main], .content, #content"
Step 8: agent-browser scroll down
Step 9: agent-browser wait 2000
Step 10: agent-browser snapshot -c -s "article, main, [role=main], .content, #content"

BODY-FIRST DECISION LOGIC (apply after all 3 snapshots):
1. Determine if article body exists: look for multiple paragraphs of article prose
   (not nav, sidebar, footer, author bio, comments, or cookie banners).
2. If article body paragraphs exist → extract the full text and return it. DO NOT return PAYWALL.
3. Seeing "Member-only story" label is NOT a reason to return PAYWALL — Medium always
   shows this badge for member content. If paragraphs exist below the badge, this is ACCESS GRANTED.
4. Return ONLY "PAYWALL" if ALL snapshots show a login wall or metered interstitial
   AND NO article body paragraphs are present anywhere in the snapshots.
5. Return ONLY "FAILED" if the page fails to load or shows a hard error state.

${partnerNote}

Extraction scope (when body exists):
- Include: headings, paragraphs, list items from article body
- Exclude: nav, header, recommendations, comments, cookie banners, signup prompts, author cards

OUTPUT:
- Return ONLY plain article text (no JSON, no markdown wrappers)
- Or return exactly: PAYWALL
- Or return exactly: FAILED`;
}

export function buildLinkedInTrendingPrompt(interests: string[], maxItems: number = 25): string {
  return `Find trending public LinkedIn posts and articles relevant to these interests:
${interests.map((i) => `- ${i}`).join("\n")}

Use web search to find recent public LinkedIn content (prefer last 14 days, then 30 days if needed).

Search examples:
- site:linkedin.com/posts "AI" "LinkedIn"
- site:linkedin.com/posts "TypeScript"
- site:linkedin.com/posts "automation" "career"
- site:linkedin.com/posts "quant trading"
- site:linkedin.com/posts "content creation"

Return up to ${maxItems} high-signal results total. Prioritize posts with strong engagement signals in snippets when available.

For each result output:
- title: concise post headline or first 8-12 words
- date: publish/relative date from snippet if available
- reactions: numeric if visible, else null
- comments: numeric if visible, else null
- content: 1-3 sentence summary of the post's core idea (not generic)
- link: direct LinkedIn post/article URL

Rules:
- Keep only LinkedIn URLs.
- Exclude duplicates by URL.
- Do not invent engagement numbers.
- If nothing reliable found, return []

OUTPUT FORMAT (JSON only):
[{"title":"...","date":"...","reactions":123,"comments":14,"content":"...","link":"https://www.linkedin.com/..."}]`;
}

// ============================================
// SHARED OPTIONS
// ============================================

export const SCRAPE_OPTIONS: ClaudeExecutorOptions = {
  cwd: "/tmp/homer-scrape",
  model: "sonnet",
  timeout: 600_000,
};

export const DEEP_FETCH_OPTIONS: ClaudeExecutorOptions = {
  cwd: "/tmp/homer-scrape",
  model: "sonnet",
  timeout: 300_000, // 5 min — CDP startup + sleep 5+2+2=9s + 3 snapshots + scroll + LLM processing
};
