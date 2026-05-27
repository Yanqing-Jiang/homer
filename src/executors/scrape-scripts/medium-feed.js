// Extract Medium "For You" feed cards.
// Returns: [{rank?, title, author?, date?, readTime?, claps?, description?, url}]
(() => {
  const out = [];
  const articles = document.querySelectorAll("article");
  let rank = 0;
  articles.forEach((a) => {
    const titleEl = a.querySelector("h2, h3");
    const title = titleEl ? titleEl.innerText.trim() : "";
    if (!title) return;
    rank += 1;
    // Find the canonical article link — try anchors that point to medium.com or a relative /@author/slug pattern.
    let url = "";
    const anchors = a.querySelectorAll('a[href]');
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      if (!href) continue;
      // Prefer story links (path contains a hyphen-hash slug at end, e.g. /@user/title-abc123)
      if (/medium\.com\/[^?]+-[a-f0-9]{6,}/.test(href) || /\/@[^/]+\//.test(href)) {
        url = href.startsWith("/") ? `https://medium.com${href}` : href;
        break;
      }
    }
    if (!url) {
      // Fallback: any link with /p/ in path, or the first link
      const fallback = a.querySelector('a[href*="/p/"]') || anchors[0];
      if (fallback) {
        const href = fallback.getAttribute("href") || "";
        url = href.startsWith("/") ? `https://medium.com${href}` : href;
      }
    }
    if (!url) return;
    const text = a.innerText || "";
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    // Author: first non-empty line, but skip "In <publication>" / "by"
    let author;
    for (const line of lines) {
      if (line === title) break;
      if (line === "In" || line === "by" || line === "·") continue;
      if (!author) author = line;
      else if (author && (author === "In" || author === "by")) author = line;
      if (/^by\s+/i.test(line)) author = line.replace(/^by\s+/i, "");
    }
    // Date: look for line that parses as a date or matches "Mon DD" / "Mon DD, YYYY"
    const dateLine = lines.find((l) => /^[A-Z][a-z]{2,8}\s+\d{1,2}(,\s*\d{4})?$/.test(l));
    // Read time: "X min read"
    const readTimeLine = lines.find((l) => /\d+\s*min\s*read/i.test(l));
    // Claps: usually a numeric line near the end like "1.2K", "243"
    const lastNumeric = [...lines].reverse().find((l) => /^\d[\d.,]*(K|M)?$/.test(l));
    // Description: line after title that isn't a count/date/readTime
    const titleIdx = lines.indexOf(title);
    const descCandidate = titleIdx >= 0 ? lines.slice(titleIdx + 1).find((l) => l !== readTimeLine && l !== dateLine && l !== lastNumeric && l.length > 20) : undefined;
    out.push({
      rank,
      title,
      author,
      date: dateLine,
      readTime: readTimeLine,
      claps: lastNumeric,
      description: descCandidate,
      url,
    });
  });
  return out;
})();
