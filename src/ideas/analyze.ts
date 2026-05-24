import { config } from "../config/index.js";
import { executeClaudeCommand } from "../executors/claude.js";
import { formatScheduledTelegramHtml } from "../notifications/telegram-router.js";
import { buildCondensedContext } from "../scheduler/shared-context.js";
import { logger } from "../utils/logger.js";

export const IDEA_REVIEW_MODEL = "sonnet";

export interface AnalysisIdea {
  id: string;
  title: string;
  content: string;
  context?: string;
  link?: string;
  source: string;
  tags?: string[];
  notes?: string;
  filePath?: string;
  linkedExplorationThreadId?: string;
  linkedPlanId?: string;
  apiUrl?: string;
}

function normalizeOptional(value?: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "N/A";
}

function normalizeList(values?: string[]): string {
  return values && values.length > 0 ? values.join(", ") : "N/A";
}

export function buildIdeaReviewContext(idea: AnalysisIdea): string {
  // apiUrl is optional in headless mode (no web UI); only emit the line when set.
  const apiUrl = idea.apiUrl?.trim();

  return [
    "## Direct Idea References",
    ...(apiUrl ? [`- Idea API: ${apiUrl}`] : []),
    `- Local file: ${normalizeOptional(idea.filePath)}`,
    `- Source URL: ${normalizeOptional(idea.link)}`,
    `- Linked exploration thread: ${normalizeOptional(idea.linkedExplorationThreadId)}`,
    `- Linked plan: ${normalizeOptional(idea.linkedPlanId)}`,
    "",
    "## Idea Payload",
    `- ID: ${idea.id}`,
    `- Title: ${idea.title}`,
    `- Source: ${idea.source}`,
    `- Tags: ${normalizeList(idea.tags)}`,
    "",
    "### Full Content",
    idea.content.trim(),
    "",
    "### Context",
    normalizeOptional(idea.context),
    "",
    "### Notes",
    normalizeOptional(idea.notes),
  ].join("\n");
}

export function buildIdeaReviewPrompt(idea: AnalysisIdea, condensedContext: string): string {
  return `You are HOMER reviewing one idea for Yanqing.

Return ONLY Telegram HTML. No Markdown. No code fences. Use Simplified Chinese.

Be direct and opinionated. Read the embedded idea payload first. The direct references are included so you can anchor yourself quickly, but do not ask for more context unless absolutely necessary.

## Yanqing Context
${condensedContext}

${buildIdeaReviewContext(idea)}

## Output Requirements
- Output valid Telegram HTML only.
- Keep it direct and complete enough to make a decision from Telegram.
- Use these sections in order:
  1. <b>一句话判断</b>
  2. <b>为什么</b>
  3. <b>关键风险</b>
  4. <b>最快验证方式</b>
  5. <b>建议动作</b>
- If useful, include the source URL as an HTML link.
- Do not mention internal implementation details like "I was given a prompt".
- End with a clear recommendation: 推进 / 暂缓 / 放弃.`;
}

function cleanHtmlReview(output: string): string {
  const stripped = output
    .trim()
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/\s*```$/, "");

  return formatScheduledTelegramHtml(stripped);
}

export async function analyzeIdea(
  idea: AnalysisIdea,
  notify: (text: string, parseMode?: string) => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  logger.info({ ideaId: idea.id, title: idea.title }, "Starting Sonnet idea review");

  const condensedContext = await buildCondensedContext();
  const prompt = buildIdeaReviewPrompt(idea, condensedContext);
  const result = await executeClaudeCommand(prompt, {
    cwd: config.paths.homerRoot,
    model: IDEA_REVIEW_MODEL,
    timeout: 120_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.output.slice(0, 500) || "Sonnet idea review failed");
  }

  const review = cleanHtmlReview(result.output);
  if (!review) {
    throw new Error("Sonnet returned an empty review");
  }

  logger.info(
    { ideaId: idea.id, duration: Date.now() - startedAt, model: IDEA_REVIEW_MODEL },
    "Sonnet idea review complete",
  );

  await notify(review, "HTML");
}
