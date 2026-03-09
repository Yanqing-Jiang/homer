import { existsSync, mkdirSync, readFileSync } from "fs";
import { executeCodexCLI, type CodexCLIResult } from "./codex-cli.js";
import { logger } from "../utils/logger.js";

const DEFAULT_SCRAPE_CWD = "/tmp/homer-scrape";

export interface CodexBrowserScrapeOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  skillPaths?: string[];
}

function renderSkillAttachment(skillPath: string): string {
  if (!existsSync(skillPath)) {
    logger.warn({ skillPath }, "Codex browser scrape skill file missing");
    return `FILE: ${skillPath}\n(MISSING)\n`;
  }

  return `FILE: ${skillPath}\n${readFileSync(skillPath, "utf-8").trim()}\n`;
}

export async function executeCodexBrowserScrape(
  taskPrompt: string,
  options: CodexBrowserScrapeOptions = {},
): Promise<CodexCLIResult> {
  const resolvedModel = options.model?.startsWith("gpt-") ? options.model : "gpt-5.4";
  const {
    cwd = DEFAULT_SCRAPE_CWD,
    timeout,
    signal,
    sessionId,
    reasoningEffort = "medium",
    skillPaths = [],
  } = options;

  mkdirSync(cwd, { recursive: true });

  const attachedSkills = skillPaths.length > 0
    ? skillPaths.map(renderSkillAttachment).join("\n")
    : "(none)";

	const prompt = `You are a browser scraping worker running inside Codex.

Operate from the attached skill files as hard runtime guidance.
Use agent-browser via bash and Chrome CDP for authenticated sites.
Do not write or modify files.
Do not include plans, narration, status updates, or markdown fences unless the task explicitly asks for them.
If the task requests JSON, return JSON immediately as the first character of the response.
Return only the final requested output.

ATTACHED SKILLS
${attachedSkills}

TASK
${taskPrompt}`;

  return executeCodexCLI(prompt, {
    cwd,
    timeout,
    signal,
    sessionId,
    model: resolvedModel,
    reasoningEffort,
  });
}
