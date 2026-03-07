/** Shared configuration for job hunt modules. */

import { GEMINI_CLI_FLASH_MODEL } from "../executors/gemini-cli.js";

export const GEMINI_MODEL = GEMINI_CLI_FLASH_MODEL;
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function geminiUrl(model = GEMINI_MODEL): string {
  return `${GEMINI_API_BASE}/${model}:generateContent`;
}
