/**
 * Per-Executor Attachment Handler
 *
 * Formats file attachments appropriately for each executor type.
 * Different executors expect different formats for file content.
 */

import type { ExecutorType } from "./router.js";

export interface Attachment {
  id: string;
  filename: string;
  content: string;
  mimeType?: string;
}

/**
 * Format attachments for a specific executor
 */
export function formatAttachments(
  attachments: Attachment[],
  executor: ExecutorType | "claude"
): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }

  const formatted = attachments.map((att) => formatSingleAttachment(att, executor));
  return formatted.join("\n\n");
}

/**
 * Format a single attachment for a specific executor
 */
export function formatSingleAttachment(
  attachment: Attachment,
  executor: ExecutorType | "claude"
): string {
  const { id, filename, content, mimeType } = attachment;

  switch (executor) {
    case "claude":
    case "codex":
      // XML attachment tags for Claude/Codex
      return `<attachment id="${id}" filename="${filename}"${mimeType ? ` type="${mimeType}"` : ""}>
${content}
</attachment>`;

    case "gemini-cli":
    case "gemini-api":
      // Code blocks with filename for Gemini
      const lang = getLanguageFromFilename(filename);
      return `File: ${filename}
\`\`\`${lang}
${content}
\`\`\``;

    case "kimi":
      // Long context - full content inline with header
      return `[File: ${filename}]
${content}`;

    default:
      // Fallback: simple text format
      return `--- ${filename} ---
${content}
--- end ${filename} ---`;
  }
}

/**
 * Format attachment references (for executors that can't handle full content)
 */
export function formatAttachmentRefs(
  attachments: Attachment[],
  _executor: ExecutorType | "claude"
): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }

  const refs = attachments.map((att) => `[Attached: ${att.filename}]`);
  return refs.join("\n");
}

/**
 * Build a message with attachments prepended
 */
export function buildMessageWithAttachments(
  message: string,
  attachments: Attachment[],
  executor: ExecutorType | "claude"
): string {
  if (!attachments || attachments.length === 0) {
    return message;
  }

  const formattedAttachments = formatAttachments(attachments, executor);
  return `${formattedAttachments}\n\n${message}`;
}

/**
 * Get language identifier from filename extension
 */
function getLanguageFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  const langMap: Record<string, string> = {
    // Web
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    html: "html",
    css: "css",
    scss: "scss",
    less: "less",
    vue: "vue",
    svelte: "svelte",

    // Backend
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    scala: "scala",
    cs: "csharp",
    cpp: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",

    // Data/Config
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    csv: "csv",
    sql: "sql",

    // Shell/Scripts
    sh: "bash",
    bash: "bash",
    zsh: "zsh",
    fish: "fish",
    ps1: "powershell",

    // Docs
    md: "markdown",
    mdx: "markdown",
    txt: "",
    log: "",

    // Other
    dockerfile: "dockerfile",
    makefile: "makefile",
    graphql: "graphql",
    gql: "graphql",
    prisma: "prisma",
    proto: "protobuf",
  };

  return langMap[ext] || ext;
}

/**
 * Determine if an attachment should be sent as content or reference
 *
 * Large files or binary files should be referenced, not embedded.
 */
export function shouldEmbedContent(
  attachment: Attachment,
  executor: ExecutorType | "claude"
): boolean {
  // Check content size (limit varies by executor)
  const maxSizeBytes: Record<string, number> = {
    claude: 100_000,      // 100KB
    codex: 100_000,       // 100KB
    "gemini-cli": 50_000, // 50KB
    "gemini-api": 50_000, // 50KB
    kimi: 500_000,        // 500KB (long context)
  };

  const limit = maxSizeBytes[executor] || 50_000;
  const contentSize = Buffer.byteLength(attachment.content, "utf-8");

  if (contentSize > limit) {
    return false;
  }

  // Check mime type for binary content
  const binaryMimeTypes = [
    "application/octet-stream",
    "application/pdf",
    "image/",
    "audio/",
    "video/",
    "application/zip",
    "application/gzip",
  ];

  if (attachment.mimeType) {
    if (binaryMimeTypes.some((t) => attachment.mimeType?.startsWith(t))) {
      return false;
    }
  }

  return true;
}
