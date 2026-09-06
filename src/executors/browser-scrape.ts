/**
 * Browser scrape executor.
 *
 * Primary:  Codex Terra high, under a browserctl lease
 * Fallback: Gemini Flash 3.0 (gemini-3-flash-preview via Gemini CLI)
 *
 * Both paths are constrained to browser-only behavior via prompt injection.
 * Timeout is tracked as a total wall-clock budget across both attempts.
 */

import { mkdirSync } from "fs";
import { executeCodexCLI } from "./codex-cli.js";
import { executeOpenCodeCLI, type OpenCodeCLIOptions, type OpenCodeCLIResult } from "./opencode-cli.js";
import { logger } from "../utils/logger.js";

// Browser-scrape Gemini fallback runs on opencode Flash 3.5 (High), driving agent-browser.
const FLASH_FALLBACK_MODEL = "google/gemini-3.5-flash";

// Reserve part of the total budget for the existing fallback.
const PRIMARY_TIMEOUT_RATIO = 0.9;

const SCRAPE_CWD = "/tmp/homer-scrape";

const BROWSER_ONLY_CONSTRAINT = `CRITICAL CONSTRAINT: You are a browser scraping worker.
- This worker is launched by browserctl agent and already holds one lease for the whole workflow.
- Use agent-browser commands via bash; never run connect or override the injected named session.
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
  const primaryTimeout = Math.floor(timeout * PRIMARY_TIMEOUT_RATIO);
  const constrainedPrompt = `${BROWSER_ONLY_CONSTRAINT}\n${prompt}`;

  // Primary: Codex Terra high.
  try {
    mkdirSync(SCRAPE_CWD, { recursive: true });

    const result = await executeCodexCLI(constrainedPrompt, {
      cwd: SCRAPE_CWD,
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      timeout: primaryTimeout,
      signal,
      browserAgent: true,
      browserInstance: options.browserInstance ?? "interactive",
    });

    const useful =
      result.exitCode === 0 &&
      result.output &&
      result.output.length > 10 &&
      result.output !== "(No output)";

    if (useful) {
      logger.debug({ outputLen: result.output.length, duration: result.duration }, "Browser scrape: Codex primary succeeded");
      return {
        output: result.output,
        exitCode: 0,
        duration: Date.now() - startTime,
        executor: "codex",
        sessionId: result.sessionId ?? "",
        model: "gpt-5.6-terra",
        accountId: 0,
      };
    }

    logger.warn(
      { exitCode: result.exitCode, outputLen: result.output?.length },
      "Browser scrape: Codex produced no useful output, trying fallback"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "Browser scrape: Codex failed, trying fallback");
  }

  // ── Fallback: opencode (caller may override the model; Flash by default) ──
  const elapsed = Date.now() - startTime;
  const remainingTimeout = Math.max(60_000, timeout - elapsed); // at least 60s for fallback
  const fallbackModel = options.model ?? FLASH_FALLBACK_MODEL;
  logger.info({ remainingMs: remainingTimeout, model: fallbackModel }, "Browser scrape: using opencode fallback");

  const geminiResult = await executeOpenCodeCLI(constrainedPrompt, _context, {
    ...options,
    timeout: remainingTimeout,
    model: fallbackModel,
    forceOpenCode: true,
    browserOnly: true,
    browserInstance: options.browserInstance ?? "interactive",
  });

  return {
    ...geminiResult,
    duration: Date.now() - startTime, // total wall-clock time
  };
}
