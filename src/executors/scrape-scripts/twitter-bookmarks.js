// Extract bookmark cards from x.com/i/bookmarks.
// Returns: [{id, author, name, text, likes, retweets, created_at, url}]
// Schema matches RawBookmark / OpenCLIBookmark for mapper compatibility.
(() => {
  const out = [];
  const seenIds = new Set();
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
    const text = txtEl ? txtEl.innerText : "";
    const timeEl = a.querySelector("time[datetime]");
    const created_at = timeEl ? timeEl.getAttribute("datetime") : undefined;
    const userBlock = a.querySelector('[data-testid="User-Name"]');
    const name = userBlock ? (userBlock.innerText.split("\n")[0] || "").trim() : undefined;
    // Engagement counts — Twitter renders them as [data-testid="reply"|"retweet"|"like"|"bookmark"] with aria-label text.
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
    });
  });
  return out;
})();
