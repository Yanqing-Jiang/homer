/**
 * Hallucination validator — compares optimized resume against original
 * using Gemini Flash API for cheap, fast validation.
 */

import { geminiUrl } from "./config.js";
import { logger } from "../utils/logger.js";

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  confidence: number;
}

/**
 * Validate an optimized resume against the original.
 * Uses Gemini Flash API to compare both texts.
 */
export async function validateOptimizedResume(
  originalText: string,
  optimizedText: string,
  jobDescription: string
): Promise<ValidationResult> {
  const apiKey = process.env.GEMINI_API_KEY_Primary || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn("No GEMINI_API_KEY_Primary, skipping validation");
    return { valid: false, issues: ["Validation unavailable — manual review required (no API key)"], confidence: 0 };
  }

  const prompt = `Compare these two resumes. The ORIGINAL is the ground truth. The OPTIMIZED was generated for the JOB DESCRIPTION below.

Check for hallucinations:
1. Are all company names in OPTIMIZED present in ORIGINAL?
2. Are job titles accurate (not inflated)?
3. Do numbers ($$, %, team sizes) match within rounding?
4. Are there any fabricated certifications or degrees?
5. Are listed skills reasonable aliases of what's in ORIGINAL?

Respond with JSON only:
{"valid": true/false, "issues": ["issue1", ...], "confidence": 0.0-1.0}

ORIGINAL RESUME:
${originalText.slice(0, 4000)}

OPTIMIZED RESUME:
${optimizedText.slice(0, 4000)}

JOB DESCRIPTION:
${jobDescription.slice(0, 2000)}`;

  try {
    const resp = await fetch(
      geminiUrl(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 65536 },
        }),
      }
    );

    if (!resp.ok) {
      logger.warn({ status: resp.status }, "Gemini API error in validation");
      return { valid: false, issues: ["Validation unavailable — manual review required"], confidence: 0 };
    }

    const data = (await resp.json()) as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        valid: Boolean(parsed.valid),
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      };
    }

    return { valid: false, issues: ["Validation unavailable — could not parse response"], confidence: 0 };
  } catch (error) {
    logger.warn({ error }, "Resume validation failed");
    return { valid: false, issues: ["Validation unavailable — manual review required"], confidence: 0 };
  }
}
