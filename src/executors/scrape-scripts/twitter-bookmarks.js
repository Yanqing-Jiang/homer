// Extract bookmark cards from x.com/i/bookmarks.
// Returns: [{id, author, name, text, likes, retweets, created_at, url,
//            content_type, article_title, external_urls, needs_detail_fetch}]
// Schema matches RawBookmark / OpenCLIBookmark for mapper compatibility.
(() => {
  const out = [];
  const seenIds = new Set();
  const SOCIAL_HOSTS = ["x.com", "twitter.com", "t.co", "linkedin.com", "instagram.com"];

  function isExternalUrl(href) {
    try {
      const h = new URL(href, location.origin).hostname;
      return !SOCIAL_HOSTS.some((d) => h === d || h.endsWith("." + d));
    } catch {
      return false;
    }
  }

  function extractUrls(article) {
    const urls = [];
    article.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      let full = href;
      try {
        full = href.startsWith("http") ? href : new URL(href, location.origin).href;
      } catch {
        return;
      }
      if (isExternalUrl(full) || full.includes("t.co/")) urls.push(full);
    });
    return [...new Set(urls)];
  }

  function articlePreviewFromLines(article) {
    const lines = (article.innerText || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const articleIdx = lines.findIndex((l) => l === "Article");
    if (articleIdx < 0) return { title: null, preview: null };
    return {
      title: lines[articleIdx + 1] || null,
      preview: lines[articleIdx + 2] || null,
    };
  }

  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  articles.forEach((a) => {
    const link = a.querySelector('a[href*="/status/"]');
    const m = link && link.getAttribute("href").match(/\/([^/]+)\/status\/(\d+)/);
    if (!m) return;
    const author = m[1];
    const id = m[2];
    if (seenIds.has(id)) return;
    seenIds.add(id);

    const txtEl = a.querySelector('[data-testid="tweetText"]');
    let text = txtEl ? txtEl.innerText.trim() : "";

    const socialEl = a.querySelector('[data-testid="socialContext"]');
    const quoteEl = a.querySelector('[data-testid="quoteTweet"]');
    const cardEl = a.querySelector('[data-testid="card.wrapper"]');
    const photoEl = a.querySelector('[data-testid="tweetPhoto"]');
    const articlePreview = articlePreviewFromLines(a);
    const external_urls = extractUrls(a);

    let content_type = "tweet";
    let article_title = null;
    let needs_detail_fetch = false;

    if (!text && articlePreview.title) {
      content_type = "article";
      article_title = articlePreview.title;
      text = [article_title, articlePreview.preview].filter(Boolean).join("\n\n");
      needs_detail_fetch = true;
    } else if (!text && quoteEl) {
      content_type = "quote";
      text = quoteEl.innerText.trim();
      needs_detail_fetch = text.length < 80;
    } else if (!text && cardEl) {
      content_type = "card";
      text = cardEl.innerText.trim();
      needs_detail_fetch = true;
    } else if (!text && photoEl) {
      content_type = "photo";
      text = "[Image post — fetching full tweet]";
      needs_detail_fetch = true;
    } else if (!text && socialEl) {
      content_type = "repost";
      text = socialEl.innerText.trim();
      needs_detail_fetch = true;
    }

    if (cardEl && text) {
      const cardTitle = (cardEl.innerText || "").split("\n")[0];
      if (cardTitle && !text.includes(cardTitle.slice(0, 30))) {
        text += "\n\n[Link card: " + cardTitle + "]";
      }
      if (external_urls.length > 0) needs_detail_fetch = true;
    }

    if (external_urls.length > 0 && (text.length < 60 || /^https?:\/\/\S+$/.test(text))) {
      needs_detail_fetch = true;
    }

    const timeEl = a.querySelector("time[datetime]");
    const created_at = timeEl ? timeEl.getAttribute("datetime") : undefined;
    const userBlock = a.querySelector('[data-testid="User-Name"]');
    const name = userBlock ? (userBlock.innerText.split("\n")[0] || "").trim() : undefined;

    const readCount = (testid) => {
      const el = a.querySelector(`[data-testid="${testid}"]`);
      if (!el) return undefined;
      const label = el.getAttribute("aria-label") || "";
      const numMatch = label.match(/([\d,.]+)/);
      if (!numMatch) return undefined;
      const n = parseFloat(numMatch[1].replace(/,/g, ""));
      return Number.isFinite(n) ? Math.round(n) : undefined;
    };

    out.push({
      id,
      author,
      name,
      text,
      likes: readCount("like") ?? 0,
      retweets: readCount("retweet"),
      created_at,
      url: `https://x.com/${author}/status/${id}`,
      content_type,
      article_title,
      external_urls,
      needs_detail_fetch,
    });
  });
  return out;
})();
