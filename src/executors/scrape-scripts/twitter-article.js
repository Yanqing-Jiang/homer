// Extract a single tweet's full content (normal tweet, X Article, or link card).
// Returns: {author, content, title?, url, images}
(() => {
  const article = document.querySelector('article[data-testid="tweet"]') || document.querySelector("article");
  if (!article) return null;

  const images = [];
  const seenSrc = new Set();
  article.querySelectorAll('[data-testid="tweetPhoto"] img').forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (!src.includes("pbs.twimg.com/media/")) return;
    if (seenSrc.has(src)) return;
    seenSrc.add(src);
    const alt = (img.getAttribute("alt") || "").trim();
    const item = { url: src };
    if (alt && alt !== "Image") item.alt = alt;
    images.push(item);
  });
  const imageList = images.slice(0, 4);

  const userBlock = article.querySelector('[data-testid="User-Name"]');
  let author = "";
  if (userBlock) {
    const handleSpan = Array.from(userBlock.querySelectorAll("span"))
      .map((s) => s.innerText)
      .find((t) => /^@\w+/.test(t));
    author = handleSpan
      ? handleSpan.replace(/^@/, "")
      : (userBlock.innerText.split("\n")[1] || "").replace(/^@/, "");
  }

  const articleTitleEl = document.querySelector('[data-testid="twitter-article-title"]');
  const articleBodyEl =
    document.querySelector('[data-testid="twitterArticleRichTextView"]') ||
    document.querySelector('[data-testid="longformRichTextComponent"]') ||
    document.querySelector('[data-testid="twitterArticleReadView"]');

  if (articleTitleEl || articleBodyEl) {
    const title = articleTitleEl ? articleTitleEl.innerText.trim() : undefined;
    const body = articleBodyEl ? articleBodyEl.innerText.trim() : "";
    const content = title && body ? `# ${title}\n\n${body}` : body || title || "";
    return { author, content, title, url: window.location.href, images: imageList };
  }

  const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
  if (tweetTextEl) {
    let content = tweetTextEl.innerText.trim();
    const cardEl = article.querySelector('[data-testid="card.wrapper"]');
    if (cardEl) {
      const cardText = cardEl.innerText.trim();
      if (cardText && !content.includes(cardText.slice(0, 40))) {
        content += (content ? "\n\n" : "") + "[Link card]\n" + cardText;
      }
    }
    const quoteEl = article.querySelector('[data-testid="quoteTweet"]');
    if (quoteEl) {
      const quoteText = quoteEl.innerText.trim();
      if (quoteText && !content.includes(quoteText.slice(0, 40))) {
        content += (content ? "\n\n" : "") + "[Quoted tweet]\n" + quoteText;
      }
    }
    return { author, content, url: window.location.href, images: imageList };
  }

  const legacyArticleEl = article.querySelector('[data-testid="article"]');
  if (legacyArticleEl) {
    const content = legacyArticleEl.innerText.trim();
    const titleEl = article.querySelector("h1, h2");
    const title = titleEl ? titleEl.innerText.trim() : undefined;
    return { author, content, title, url: window.location.href, images: imageList };
  }

  return { author, content: article.innerText.trim(), url: window.location.href, images: imageList };
})();
