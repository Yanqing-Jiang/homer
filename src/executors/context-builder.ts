import type { StateManager, ThreadMessage } from "../state/manager.js";

/** Internal unified message type for context building */
interface ContextMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt?: string;
  executor?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Convert ThreadMessage to ContextMessage */
function threadToContext(msg: ThreadMessage): ContextMessage {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    createdAt: msg.createdAt,
    metadata: msg.metadata,
    executor: msg.metadata?.executor as string | undefined,
  };
}

export type ContextFormat = "markdown" | "xml";

export interface ContextOptions {
  maxMessages?: number;
  maxTokens?: number;
  includeSystem?: boolean;
  format?: ContextFormat;
  beforeMessageId?: string;
  /** Extract and preserve anchor messages (constraints, corrections) */
  preserveAnchors?: boolean;
}

export interface ContextSource {
  type: "thread" | "lane";
  id: string;
}

export interface ConversationContext {
  formatted: string;
  messageCount: number;
  anchorCount: number;
  truncated: boolean;
}

/**
 * Patterns that identify "anchor" messages - constraints/corrections that must survive truncation
 */
const ANCHOR_PATTERNS = [
  // Constraints
  /\b(never|always|must|required|don't|do not|cannot|should not|forbidden)\b/i,
  // Corrections
  /\b(actually|wrong|incorrect|mistake|correction|not what i meant|no,)\b/i,
  // Important markers
  /\b(important|critical|note|remember|key point|make sure)\b/i,
  // Errors and issues
  /\b(error|failed|broken|fix|issue|bug|problem)\b/i,
  // Explicit anchors
  /\b(keep in mind|for future reference|going forward)\b/i,
];

/**
 * Check if a message is an "anchor" that should survive truncation
 */
function isAnchorMessage(msg: ContextMessage): boolean {
  // System messages are always anchors
  if (msg.role === "system") return true;

  // Check content against anchor patterns
  return ANCHOR_PATTERNS.some((pattern) => pattern.test(msg.content));
}

/**
 * Extract anchor messages that must be preserved regardless of token budget
 */
export function extractAnchors(messages: ContextMessage[]): ContextMessage[] {
  return messages.filter(isAnchorMessage);
}

export const CONTEXT_DEFAULTS = {
  thread: {
    maxMessages: 10,
    maxTokens: 2000,
    includeSystem: false,
    format: "xml" as ContextFormat,
  },
  lane: {
    maxMessages: 8,
    maxTokens: 1500,
    includeSystem: false,
    format: "xml" as ContextFormat,
  },
  fallback: {
    maxMessages: 6,
    maxTokens: 1200,
    includeSystem: false,
    format: "xml" as ContextFormat,
  },
};

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatContext(messages: ContextMessage[], format: ContextFormat): string {
  if (messages.length === 0) return "";

  if (format === "xml") {
    const lines = messages.map((m) => {
      const attrs: string[] = [`role="${m.role}"`];
      if (m.createdAt) {
        attrs.push(`timestamp="${escapeXml(m.createdAt)}"`);
      }
      if (m.executor) {
        attrs.push(`executor="${escapeXml(m.executor)}"`);
      }
      return `<message ${attrs.join(" ")}>${escapeXml(m.content)}</message>`;
    });
    return `<conversation_history>\n${lines.join("\n")}\n</conversation_history>`;
  }

  const lines = messages.map((m) => {
    const roleLabel = m.role === "user" ? "**User:**" : m.role === "assistant" ? "**Assistant:**" : "**System:**";
    return `${roleLabel}\n${m.content}`;
  });

  return `## Previous Conversation\n\n${lines.join("\n\n---\n\n")}`;
}

export async function buildConversationContext(
  stateManager: StateManager,
  source: ContextSource,
  options: ContextOptions = {}
): Promise<ConversationContext> {
  const defaults = source.type === "lane" ? CONTEXT_DEFAULTS.lane : CONTEXT_DEFAULTS.thread;
  const {
    maxMessages = defaults.maxMessages,
    maxTokens = defaults.maxTokens,
    includeSystem = defaults.includeSystem,
    format = defaults.format,
    beforeMessageId,
    preserveAnchors = true,
  } = options;

  if (!stateManager.isOpen) {
    return { formatted: "", messageCount: 0, anchorCount: 0, truncated: false };
  }

  let messages: ContextMessage[] = [];

  // Both lane and thread sources use ThreadMessage - getLaneMessages wraps getThreadMessages
  const rawMessages = source.type === "lane"
    ? stateManager.getLaneMessages(source.id, maxMessages * 2, beforeMessageId)
    : stateManager.getThreadMessages(source.id, maxMessages * 2, beforeMessageId);
  messages = rawMessages.map(threadToContext);

  if (!messages || messages.length === 0) {
    return { formatted: "", messageCount: 0, anchorCount: 0, truncated: false };
  }

  // Extract anchors first — system messages are always anchors and survive truncation
  // even when includeSystem is false (they provide essential context like idea exploration prompts)
  const anchors = preserveAnchors ? extractAnchors(messages) : [];

  if (!includeSystem) {
    messages = messages.filter((m) => m.role !== "system");
  }
  const anchorIds = new Set(anchors.map((a) => String(a.id)));

  // Calculate anchor token cost
  let anchorTokens = 0;
  for (const anchor of anchors) {
    anchorTokens += estimateTokens(anchor.content);
  }

  // Budget for non-anchor messages
  const remainingBudget = Math.max(0, maxTokens - anchorTokens);
  const remainingSlots = Math.max(0, maxMessages - anchors.length);

  // Select recent non-anchor messages within remaining budget
  const nonAnchors = messages.filter((m) => !anchorIds.has(String(m.id)));
  const selectedNonAnchors: ContextMessage[] = [];
  let tokenCount = 0;
  let truncated = false;

  for (const msg of nonAnchors) {
    if (selectedNonAnchors.length >= remainingSlots) {
      truncated = true;
      break;
    }
    const msgTokens = estimateTokens(msg.content);
    if (tokenCount + msgTokens > remainingBudget) {
      truncated = true;
      break;
    }
    selectedNonAnchors.push(msg);
    tokenCount += msgTokens;
  }

  if (!truncated && selectedNonAnchors.length < nonAnchors.length) {
    truncated = true;
  }

  // Merge anchors with selected messages, maintaining chronological order
  const allSelected = [...anchors, ...selectedNonAnchors];
  allSelected.sort((a, b) => {
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return timeA - timeB;
  });

  return {
    formatted: formatContext(allSelected, format),
    messageCount: allSelected.length,
    anchorCount: anchors.length,
    truncated,
  };
}

/**
 * Build context specifically for fallback scenarios
 * Includes error context and instructions for the fallback executor
 */
export function buildFallbackContext(
  conversationHistory: string,
  failedExecutor: string,
  errorSummary: string,
  originalQuery: string
): string {
  const lines = [
    `<fallback_context>`,
    `<notice>`,
    `The previous executor (${failedExecutor}) encountered an issue.`,
    `You are now handling this request. Review the context and continue helping.`,
    `</notice>`,
    ``,
    `<error_summary>`,
    escapeXml(errorSummary),
    `</error_summary>`,
    ``,
    conversationHistory,
    ``,
    `<original_query>`,
    escapeXml(originalQuery),
    `</original_query>`,
    `</fallback_context>`,
  ];

  return lines.join("\n");
}
