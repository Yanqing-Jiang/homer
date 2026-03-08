/**
 * HTML-to-Markdown converter for Medium RSS content.
 *
 * Preserves deep links, headers, images, bold/italic, lists, and code blocks.
 * Strips tracking pixels, iframes, scripts, and Medium noise.
 */

export interface DeepLink {
  text: string;
  url: string;
}

export interface ImageRef {
  alt: string;
  src: string;
}

/**
 * Convert Medium RSS HTML (content:encoded) to Markdown,
 * preserving links, headers, images, bold/italic, and lists.
 */
export function htmlToMarkdown(html: string): string {
  let md = html;

  // Remove tracking pixels, iframes, scripts
  md = md.replace(/<img[^>]+width=["']1["'][^>]*>/gi, "");
  md = md.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  md = md.replace(/<script[\s\S]*?<\/script>/gi, "");
  md = md.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Figure with image + optional figcaption
  md = md.replace(
    /<figure>\s*<img[^>]*?alt="([^"]*)"[^>]*?src="([^"]+)"[^>]*?\/?>\s*(?:<figcaption>([\s\S]*?)<\/figcaption>)?\s*<\/figure>/gi,
    (_, alt, src, caption) => {
      const desc = caption ? caption.replace(/<[^>]+>/g, "").trim() : alt;
      return desc ? `\n![${desc}](${src})\n\n` : `\n![](${src})\n\n`;
    },
  );
  // Standalone img (alt then src)
  md = md.replace(/<img[^>]*?alt="([^"]*)"[^>]*?src="([^"]+)"[^>]*?\/?>/gi, "\n![$1]($2)\n\n");
  // Standalone img (src then alt)
  md = md.replace(/<img[^>]*?src="([^"]+)"[^>]*?alt="([^"]*)"[^>]*?\/?>/gi, "\n![$2]($1)\n\n");

  // Headers h1-h6
  md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, level, content) => {
    const text = content.replace(/<[^>]+>/g, "").trim();
    return "\n" + "#".repeat(parseInt(level)) + " " + text + "\n\n";
  });

  // Bold and italic (before links, so nested formatting inside links works)
  md = md.replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");
  md = md.replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");

  // Links — preserve href as markdown link
  md = md.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) => {
    const cleanText = text.replace(/<[^>]+>/g, "").trim();
    if (!cleanText) return "";
    return `[${cleanText}](${url})`;
  });

  // Blockquotes (before lists, since they can contain inline elements)
  md = md.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    const text = content.replace(/<[^>]+>/g, "").trim();
    return (
      text
        .split("\n")
        .map((l: string) => "> " + l.trim())
        .join("\n") + "\n\n"
    );
  });

  // Code blocks
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => {
    return "```\n" + content.replace(/<[^>]+>/g, "").trim() + "\n```\n\n";
  });
  md = md.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");

  // Lists
  md = md.replace(/<li>([\s\S]*?)<\/li>/gi, (_, content) => {
    return "- " + content.replace(/<[^>]+>/g, "").trim() + "\n";
  });
  md = md.replace(/<\/?(?:ul|ol)[^>]*>/gi, "\n");

  // Paragraphs
  md = md.replace(/<\/p>/gi, "\n\n");
  md = md.replace(/<p[^>]*>/gi, "");

  // Line breaks
  md = md.replace(/<br\s*\/?>/gi, "\n");

  // Horizontal rules
  md = md.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Strip remaining HTML tags
  md = md.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  md = decodeHtmlEntities(md);

  // Clean up excessive whitespace
  md = md.replace(/\n{3,}/g, "\n\n").trim();

  return md;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec)));
}

/**
 * Extract all deep links from HTML content.
 * Skips Medium tracking/embed URLs.
 */
export function extractDeepLinks(html: string): DeepLink[] {
  const links: DeepLink[] = [];
  const seen = new Set<string>();
  const regex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const url = match[1]!;
    const text = match[2]!.replace(/<[^>]+>/g, "").trim();

    // Skip tracking/noise URLs
    if (url.includes("medium.com/_/stat")) continue;
    if (url.includes("medium.com/media/")) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    if (text && url) links.push({ text, url });
  }

  return links;
}

/**
 * Extract all image references from HTML content.
 * Skips tracking pixels.
 */
export function extractImages(html: string): ImageRef[] {
  const images: ImageRef[] = [];
  const seen = new Set<string>();
  const regex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const src = match[1]!;
    if (src.includes("medium.com/_/stat")) continue;
    if (src.includes("width=\"1\"") || match[0].includes('width="1"')) continue;
    if (seen.has(src)) continue;
    seen.add(src);

    const altMatch = match[0].match(/alt="([^"]*)"/i);
    images.push({ alt: altMatch?.[1] ?? "", src });
  }

  return images;
}
