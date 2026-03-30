/**
 * Browser scrape executor.
 *
 * Primary:  Claude Code Sonnet (via `claude` CLI)
 * Fallback: Gemini Flash 3.0 (gemini-3-flash-preview via Gemini CLI)
 *
 * Both paths are constrained to browser-only behavior via prompt injection.
 * Timeout is tracked as a total wall-clock budget across both attempts.
 */

import { mkdirSync } from "fs";
import { executeClaudeCommand } from "./claude.js";
import { executeOpenCodeCLI, type OpenCodeCLIOptions, type OpenCodeCLIResult } from "./opencode-cli.js";
import { GEMINI_CLI_FLASH_MODEL } from "./gemini-cli.js";
import { logger } from "../utils/logger.js";

const FLASH_FALLBACK_MODEL = `google-aistudio/${GEMINI_CLI_FLASH_MODEL}`;

// Give Claude 90% of the total budget so there's time left for the fallback.
const CLAUDE_TIMEOUT_RATIO = 0.9;

const SCRAPE_CWD = "/tmp/homer-scrape";

const BROWSER_ONLY_CONSTRAINT = `CRITICAL CONSTRAINT: You are a browser scraping worker.
- Use agent-browser commands via bash for all browser interaction.
- Do NOT create, write, or modify any files on disk.
- Do NOT use bash commands that create files (no >, >>, tee, touch, mkdir, cp, mv, curl -o, wget).
- ALL output must be in your response text, not written to files.
- Return only the final requested output — no narration, plans, or status updates.
`;

export async function executeBrowserScrape(
  prompt: string,
  _context: string = "",
  options: OpenCodeCLIOptions = {}
): Promise<OpenCodeCLIResult> {
  const { timeout = 600_000, signal } = options;
  const startTime = Date.now();
  const claudeTimeout = Math.floor(timeout * CLAUDE_TIMEOUT_RATIO);
  const constrainedPrompt = `${BROWSER_ONLY_CONSTRAINT}\n${prompt}`;

  // ── Primary: Claude Sonnet ────────────────────────────────────────────────
  try {
    mkdirSync(SCRAPE_CWD, { recursive: true });

    const result = await executeClaudeCommand(constrainedPrompt, {
      cwd: SCRAPE_CWD,
      model: "sonnet",
      timeout: claudeTimeout,
      signal,
    });

    const useful =
      result.exitCode === 0 &&
      result.output &&
      result.output.length > 10 &&
      result.output !== "(No output)";

    if (useful) {
      logger.debug({ outputLen: result.output.length, duration: result.duration }, "Browser scrape: Claude primary succeeded");
      return {
        output: result.output,
        exitCode: 0,
        duration: Date.now() - startTime,
        executor: "claude",
        sessionId: result.claudeSessionId ?? "",
        model: "claude-sonnet-4-6",
        accountId: 0,
      };
    }

    logger.warn(
      { exitCode: result.exitCode, outputLen: result.output?.length },
      "Browser scrape: Claude produced no useful output, falling back to Gemini Flash"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "Browser scrape: Claude failed, falling back to Gemini Flash");
  }

  // ── Fallback: Gemini Flash 3.0 (with remaining budget) ──────────────────
  const elapsed = Date.now() - startTime;
  const remainingTimeout = Math.max(60_000, timeout - elapsed); // at least 60s for fallback
  logger.info({ remainingMs: remainingTimeout }, "Browser scrape: using Gemini Flash 3.0 fallback");

  const geminiResult = await executeOpenCodeCLI(constrainedPrompt, _context, {
    ...options,
    timeout: remainingTimeout,
    model: FLASH_FALLBACK_MODEL,
    browserOnly: true,
  });

  return {
    ...geminiResult,
    duration: Date.now() - startTime, // total wall-clock time
  };
}
