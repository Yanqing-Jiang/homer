/**
 * Schema mappers: opencli JSON output → Homer data types.
 *
 * Each mapper converts the raw opencli response into the exact shape
 * that Homer's existing pipelines expect, preserving data contracts.
 */

import type { OpenCLIBookmark, OpenCLILinkedInPost, OpenCLIMediumPost, OpenCLIArticle } from "./opencli.js";

// ============================================
// URL EXTRACTION (shared)
// ============================================

const URL_REGEX = /https?:\/\/[^\s"'<>\])}，。]+/g;
// t.co intentionally NOT skipped — we resolve it downstream to get the real article URL
const SKIP_DOMAINS = new Set(["x.com", "twitter.com", "linkedin.com", "instagram.com"]);

function extractExternalUrls(text: string): string[] {
  const urls = text.match(URL_REGEX) || [];
  return urls.filter(u => {
    try {
      const host = new URL(u).hostname;
      return !SKIP_DOMAINS.has(host) && !host.endsWith(".jpg") && !host.endsWith(".png");
    } catch {
      return false;
    }
  });
}

function deriveTitle(text: string, author: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || clean.length < 5) return `X: @${author} bookmark`;
  // URL-only tweets: the text IS a link, not a sentence
  if (/^https?:\/\/\S+$/.test(clean)) return `X: @${author} shared link`;
  // Strip leading URLs before deriving title (media tweets start with t.co links)
  const withoutLeadingUrl = clean.replace(/^https?:\/\/\S+\s*/, "").trim();
  const source = withoutLeadingUrl.length > 10 ? withoutLeadingUrl : clean;
  const firstSentence = source.split(/[.!?\n]/)[0]?.trim() || source;
  return firstSentence.length > 80 ? `${firstSentence.slice(0, 77)}...` : firstSentence;
}

// ============================================
// TWITTER BOOKMARKS → TwitterBookmark
// ============================================

export interface TwitterBookmark {
  id: string;
  text: string;
  author: string;
  authorName?: string;
  title: string;
  urls: string[];
  likes?: number;
  retweets?: number;
  createdAt?: string;
}

export function mapOpenCLIBookmark(b: OpenCLIBookmark): TwitterBookmark {
  return {
    id: b.id,
    text: b.text,
    author: b.author,
    authorName: b.name,
    title: deriveTitle(b.text, b.author),
    urls: extractExternalUrls(b.text),
    likes: b.likes,
    retweets: b.retweets,
    createdAt: b.created_at,
  };
}

export function mapOpenCLIBookmarks(bookmarks: OpenCLIBookmark[]): TwitterBookmark[] {
  return bookmarks
    .filter(b => b.id && b.text && b.text.length >= 15 && b.author)
    .map(mapOpenCLIBookmark);
}

// ============================================
// TWITTER ARTICLE → full thread text
// ============================================

export function mapOpenCLIArticleToText(article: OpenCLIArticle): string {
  return article.content || "";
}

// ============================================
// LINKEDIN TIMELINE → ScrapedPost
// ============================================

export interface ScrapedPost {
  title: string;
  date?: string;
  read_time?: string;
  claps?: number | null;
  responses?: number | null;
  reactions?: number | null;
  comments?: number | null;
  content: string;
  link?: string;
  source?: string;
  author?: string;
  topic?: string;
  first_paragraph?: string;
  hook_analysis?: string;
  access?: string;
}

export function mapLinkedInPost(p: OpenCLILinkedInPost): ScrapedPost {
  const content = p.text || "";
  const firstParagraph = content.split("\n").filter(l => l.trim())[0]?.trim();
  return {
    title: deriveTitle(content, p.author),
    date: p.posted_at,
    reactions: typeof p.reactions === "number" ? p.reactions : null,
    comments: typeof p.comments === "number" ? p.comments : null,
    content,
    link: p.url || p.author_url,
    source: "linkedin-trending",
    author: p.author,
    first_paragraph: firstParagraph,
  };
}

export function mapLinkedInTimeline(posts: OpenCLILinkedInPost[]): ScrapedPost[] {
  return posts
    .filter(p => p.text && p.text.length > 10)
    .map(mapLinkedInPost);
}

// ============================================
// MEDIUM FEED → ScrapedPost (discovery only — no full content)
// ============================================

export function mapMediumPost(p: OpenCLIMediumPost): ScrapedPost {
  return {
    title: p.title,
    date: p.date || undefined,
    read_time: p.readTime || undefined,
    claps: typeof p.claps === "number" ? p.claps : null,
    content: p.description || p.title,
    link: p.url,
    source: "medium-trending",
    author: p.author,
    first_paragraph: p.description,
  };
}

export function mapMediumFeed(posts: OpenCLIMediumPost[]): ScrapedPost[] {
  return posts
    .filter(p => p.title && p.url)
    .map(mapMediumPost);
}

// ============================================
// TWITTER BOOKMARKS → RawDiscoveryItem
// ============================================

export interface RawDiscoveryItem {
  id: string;
  source: string;
  fetchedAt: Date;
  title: string;
  description: string;
  url: string;
  author?: string;
  metadata: {
    tweetId?: string;
    likeCount?: number;
    retweetCount?: number;
    bookmarkedAt?: Date;
    externalUrls?: string[];
    [key: string]: unknown;
  };
  rawContent?: string;
}

export function mapBookmarkToDiscoveryItem(b: OpenCLIBookmark): RawDiscoveryItem {
  const externalUrls = extractExternalUrls(b.text);
  return {
    id: `tweet_${b.id}`,
    source: "twitter_bookmarks",
    fetchedAt: new Date(),
    title: deriveTitle(b.text, b.author),
    description: b.text.slice(0, 300),
    url: externalUrls[0] || b.url,
    author: b.author,
    metadata: {
      tweetId: b.id,
      likeCount: b.likes,
      retweetCount: b.retweets,
      bookmarkedAt: new Date(),
      externalUrls,
    },
    rawContent: b.text,
  };
}
