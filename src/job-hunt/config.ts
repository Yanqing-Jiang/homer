/** Shared configuration for job hunt modules. */

// Job-hunt calls the Gemini API directly (generativelanguage.googleapis.com), not the CLI.
// Decoupled from GEMINI_CLI_FLASH_MODEL so the API path can track latest GA while the
// CLI path stays on whatever the CLI subscription supports.
export const GEMINI_MODEL = "gemini-3.5-flash";
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function geminiUrl(model = GEMINI_MODEL): string {
  return `${GEMINI_API_BASE}/${model}:generateContent`;
}
