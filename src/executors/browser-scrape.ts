/**
 * Browser scrape executor.
 *
 * Primary:  Claude Code Sonnet (via `claude` CLI with --dangerously-skip-permissions)
 * Fallback: OpenCode Flash 3.0 (google-aistudio/gemini-3-flash-preview)
 *
 * Callers pass the same prompt and OpenCodeCLIOptions as before — the model
 * field in options is only used if we reach the opencode fallback.
 */

import { mkdirSync } from "fs";
import { executeClaudeCommand } from "./claude.js";
import { executeOpenCodeCLI, type OpenCodeCLIOptions, type OpenCodeCLIResult } from "./opencode-cli.js";
import { logger } from "../utils/logger.js";

const FLASH_FALLBACK_MODEL = "google-aistudio/gemini-3-flash-preview";

// Give Claude 80% of the total budget so there's time left for the fallback.
const CLAUDE_TIMEOUT_RATIO = 0.8;

const SCRAPE_CWD = "/tmp/homer-scrape";

export async function executeBrowserScrape(
  prompt: string,
  _context: string = "",
  options: OpenCodeCLIOptions = {}
): Promise<OpenCodeCLIResult> {
  const { timeout = 600_000, signal } = options;
  const claudeTimeout = Math.floor(timeout * CLAUDE_TIMEOUT_RATIO);

  // ── Primary: Claude Sonnet ────────────────────────────────────────────────
  try {
    mkdirSync(SCRAPE_CWD, { recursive: true });

    const result = await executeClaudeCommand(prompt, {
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
        duration: result.duration,
        executor: "claude",
        sessionId: result.claudeSessionId ?? "",
        model: "claude-sonnet-4-6",
        accountId: 0,
      };
    }

    logger.warn(
      { exitCode: result.exitCode, outputLen: result.output?.length },
      "Browser scrape: Claude produced no useful output, falling back to OpenCode Flash"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "Browser scrape: Claude failed, falling back to OpenCode Flash");
  }

  // ── Fallback: OpenCode Flash 3.0 ─────────────────────────────────────────
  logger.info("Browser scrape: using OpenCode Flash 3.0 fallback");
  return executeOpenCodeCLI(prompt, _context, {
    ...options,
    model: FLASH_FALLBACK_MODEL,
    browserOnly: true,
  });
}
