// Extract a single tweet's full content (article body or long tweet).
// Returns: {author, content, title?, url}
(() => {
  const article = document.querySelector('article[data-testid="tweet"]') || document.querySelector("article");
  if (!article) return null;
  // Author: from User-Name block
  const userBlock = article.querySelector('[data-testid="User-Name"]');
  let author = "";
  if (userBlock) {
    const handleSpan = Array.from(userBlock.querySelectorAll("span")).map((s) => s.innerText).find((t) => /^@\w+/.test(t));
    author = handleSpan ? handleSpan.replace(/^@/, "") : (userBlock.innerText.split("\n")[1] || "").replace(/^@/, "");
  }
  // X Articles have inline article body element; fallback to tweetText for normal tweets
  const articleBodyEl = article.querySelector('[data-testid="tweetText"]') || article.querySelector('[data-testid="article"]');
  let content = "";
  if (articleBodyEl) {
    // Capture the entire article DOM as innerText (preserves paragraph breaks).
    content = articleBodyEl.innerText.trim();
  } else {
    content = article.innerText.trim();
  }
  // Title: H1/H2 in article, else first non-empty line
  const titleEl = article.querySelector("h1, h2");
  const title = titleEl ? titleEl.innerText.trim() : undefined;
  return {
    author,
    content,
    title,
    url: window.location.href,
  };
})();
