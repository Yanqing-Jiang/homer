/**
 * Telegram Formatter — shared utility for all Telegram output.
 *
 * Telegram HTML supports ONLY: <b>, <i>, <u>, <s>, <code>, <pre>,
 * <a href="...">, <blockquote>, <tg-spoiler>. Everything else is rejected.
 *
 * No <table>, <div>, <p>, <br>, <img>, <h1-h6>, <ul>, <li>.
 * Max message: 4096 UTF-16 code units. Max 100 entities per message.
 */

const SAFE_CHUNK = 4000;

// ── HTML escaping ──────────────────────────────────────────────

/** Escape text for safe embedding inside Telegram HTML. Preserves already-escaped entities. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&(?!#?\w+;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Card layout (replaces tables) ──────────────────────────────

export interface CardItem {
  title: string;
  fields: Array<{ label: string; value: string }>;
}

/**
 * Format structured data as vertical cards — mobile-friendly alternative to tables.
 *
 * Example output:
 *   ◼ weekly-consolidation
 *   Was → Gemini Pro API
 *   Now → Opus 1M
 *   Timeout → 10 min
 */
export function formatCards(items: CardItem[]): string {
  return items
    .map((item) => {
      const title = `◼ <b>${escapeHtml(item.title)}</b>`;
      const fields = item.fields
        .map((f) => `  ${escapeHtml(f.label)} → ${escapeHtml(f.value)}`)
        .join("\n");
      return `${title}\n${fields}`;
    })
    .join("\n\n");
}

/**
 * Format a simple key-value list (no card header needed).
 *
 * Example:
 *   Model: Opus 1M
 *   Duration: 42s
 */
export function formatKV(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(v)}`).join("\n");
}

// ── Markdown → Telegram HTML conversion ────────────────────────

/**
 * Convert markdown-ish text to Telegram-safe HTML.
 * Handles: headers → bold, **bold**, *italic*, `code`, ```blocks```,
 * [links](url), bullet lists → •, numbered lists preserved.
 * Strips unsupported markdown table syntax into pre-formatted blocks.
 */
export function mdToTelegramHtml(md: string): string {
  let out = md.replace(/\r\n/g, "\n");

  // Fenced code blocks → <pre>
  out = out.replace(/```(?:[^\n`]*)\n?([\s\S]*?)```/g, (_m, code: string) => {
    const trimmed = code.trim();
    return trimmed ? `<pre>${escapeHtml(trimmed)}</pre>` : "";
  });

  // Markdown tables → <pre> block (best we can do in Telegram)
  out = out.replace(
    /(?:^|\n)(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)+)/gm,
    (_m, header: string, _sep: string, body: string) => {
      const rows = [header, ...body.trim().split("\n")];
      return `\n<pre>${escapeHtml(rows.join("\n"))}</pre>\n`;
    },
  );

  // Process line by line for structure
  const lines = out.split("\n");
  out = lines
    .map((line) => {
      // Headers → bold
      if (/^\s*#{1,6}\s+/.test(line)) {
        return line.replace(/^\s*#{1,6}\s+(.*)/, "<b>$1</b>");
      }
      // Bullets
      if (/^\s*[-*]\s+/.test(line)) {
        return line.replace(/^\s*[-*]\s+/, "• ");
      }
      return line;
    })
    .join("\n");

  // Inline formatting (skip inside <pre> blocks)
  const parts = out.split(/(<pre>[\s\S]*?<\/pre>)/g);
  out = parts
    .map((part) => {
      if (part.startsWith("<pre>")) return part;
      // Links
      let p = part.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_m, label: string, url: string) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
      );
      // Inline code
      p = p.replace(/`([^`\n]+)`/g, (_m, t: string) => `<code>${escapeHtml(t)}</code>`);
      // Bold (**text** or __text__)
      p = p.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
      p = p.replace(/__([^_\n]+)__/g, "<b>$1</b>");
      // Italic (*text*)
      p = p.replace(/(?:^|\s)\*([^*\n]+)\*(?:\s|$)/g, (m, t: string) =>
        m.replace(`*${t}*`, `<i>${t}</i>`),
      );
      return p;
    })
    .join("");

  // Clean up excessive newlines
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// ── Chunking ───────────────────────────────────────────────────

/**
 * Split text into Telegram-safe chunks (≤4000 chars each).
 * Breaks at paragraph > line > sentence > word boundaries.
 * If text contains HTML tags, tries not to split inside a tag.
 */
export function chunkForTelegram(text: string): string[] {
  if (text.length <= SAFE_CHUNK) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= SAFE_CHUNK) {
      chunks.push(remaining);
      break;
    }

    let bp = findBreak(remaining, SAFE_CHUNK);

    // Avoid splitting inside an HTML tag
    const lastOpenAngle = remaining.lastIndexOf("<", bp);
    const lastCloseAngle = remaining.lastIndexOf(">", bp);
    if (lastOpenAngle > lastCloseAngle && lastOpenAngle > bp - 100) {
      bp = lastOpenAngle;
    }

    chunks.push(remaining.slice(0, bp).trimEnd());
    remaining = remaining.slice(bp).trimStart();
  }

  return chunks;
}

function findBreak(text: string, max: number): number {
  const half = max * 0.5;
  const tryBreak = (idx: number) => (idx > half ? idx : -1);

  const pp = tryBreak(text.lastIndexOf("\n\n", max));
  if (pp > 0) return pp + 2;

  const nl = tryBreak(text.lastIndexOf("\n", max));
  if (nl > 0) return nl + 1;

  for (const sep of [". ", "! ", "? "]) {
    const s = tryBreak(text.lastIndexOf(sep, max));
    if (s > 0) return s + sep.length;
  }

  const sp = tryBreak(text.lastIndexOf(" ", max));
  if (sp > 0) return sp + 1;

  return max;
}

// ── Streaming-safe HTML ────────────────────────────────────────

/**
 * Ensure partial streaming text has balanced HTML tags.
 * Closes any unclosed <b>, <i>, <code>, <pre>, etc.
 * Telegram rejects malformed HTML, so this is needed for
 * streaming with parse_mode=HTML.
 */
export function balanceHtmlTags(html: string): string {
  const openTags: string[] = [];
  const tagPattern = /<\/?([a-z]+)(?:\s[^>]*)?\s*>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const full = match[0];
    const tag = (match[1] ?? "").toLowerCase();

    // Skip self-closing or void tags
    if (full.endsWith("/>")) continue;

    if (full.startsWith("</")) {
      // Closing tag — pop matching open
      const idx = openTags.lastIndexOf(tag);
      if (idx >= 0) openTags.splice(idx, 1);
    } else {
      openTags.push(tag);
    }
  }

  // Close remaining open tags in reverse order
  const closers = openTags.reverse().map((t) => `</${t}>`).join("");
  return html + closers;
}
