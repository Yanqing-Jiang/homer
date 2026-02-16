/** Shared configuration for job hunt modules. */

export const GEMINI_MODEL = "gemini-2.0-flash";
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function geminiUrl(model = GEMINI_MODEL): string {
  return `${GEMINI_API_BASE}/${model}:generateContent`;
}
