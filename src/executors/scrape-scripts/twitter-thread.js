// Extract a thread (root + replies) from a single-tweet URL.
// Returns: [{id, author, text, likes?, retweets?, in_reply_to?, created_at?, url?}]
(() => {
  const out = [];
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  const seenIds = new Set();
  let rootId = null;
  // Best guess: root is the first article whose URL matches window.location pathname.
  const pathMatch = window.location.pathname.match(/\/status\/(\d+)/);
  if (pathMatch) rootId = pathMatch[1];
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
      text,
      likes: readCount("like"),
      retweets: readCount("retweet"),
      in_reply_to: rootId && id !== rootId ? rootId : undefined,
      created_at,
      url: `https://x.com/${author}/status/${id}`,
    });
  });
  return out;
})();
