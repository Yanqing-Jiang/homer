/**
 * Legacy import path for parseSwarmJSON.
 *
 * The old model-swarm execution machinery has been retired; callers still use
 * this robust JSON extraction helper for LLM output.
 */

import { z } from "zod";
import { logger } from "../utils/logger.js";

/**
 * Robust JSON extraction from LLM output with Zod validation.
 * For arrays: validates per-element, skips invalid ones.
 */
export function parseSwarmJSON<T>(raw: string, schema: z.ZodType<T, any, any>): T {
  const { candidates, labels } = extractJSONCandidates(raw);
  const errors: Array<{ strategy: string; error: string }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const strategy = labels[i] ?? `strategy-${i}`;
    try {
      const parsed = JSON.parse(candidate);

      if (Array.isArray(parsed) && schema instanceof z.ZodArray) {
        return validateArrayElements(parsed, schema) as T;
      }

      const validated = schema.parse(parsed);
      return validated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ strategy, error: msg.slice(0, 200) });
    }
  }

  const diagnostics = errors.map((e) => `  ${e.strategy}: ${e.error}`).join("\n");
  const preview = raw.slice(0, 500);
  throw new Error(
    `Failed to parse JSON from LLM output (${candidates.length} strategies tried).\n${diagnostics}\nPreview: ${preview}`,
  );
}

function extractJSONCandidates(raw: string): { candidates: string[]; labels: string[] } {
  const candidates: string[] = [];
  const labels: string[] = [];

  candidates.push(raw.trim());
  labels.push("direct");

  const fencePattern = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let fenceMatch;
  let fenceIdx = 0;
  while ((fenceMatch = fencePattern.exec(raw)) !== null) {
    if (fenceMatch[1]) {
      candidates.push(fenceMatch[1].trim());
      labels.push(`markdown-fence-${fenceIdx++}`);
    }
  }

  const arrayMatch = raw.match(/(\[[\s\S]*\])/);
  if (arrayMatch?.[1]) {
    candidates.push(arrayMatch[1]);
    labels.push("outermost-array");
  }

  const objectMatch = raw.match(/(\{[\s\S]*\})/);
  if (objectMatch?.[1]) {
    candidates.push(objectMatch[1]);
    labels.push("outermost-object");
  }

  const stripped = raw
    .replace(/^[\s\S]*?(?=[\[{])/, "")
    .replace(/(?<=[\]}])[\s\S]*$/, "");
  if (stripped !== raw.trim()) {
    candidates.push(stripped);
    labels.push("stripped-preamble");
  }

  return { candidates, labels };
}

function validateArrayElements<T>(parsed: unknown[], schema: z.ZodType<T, any, any>): T {
  const arraySchema = schema as unknown as z.ZodArray<z.ZodTypeAny>;
  const elementSchema = arraySchema.element;

  const valid: unknown[] = [];
  let skipped = 0;
  let firstError: string | undefined;

  for (const element of parsed) {
    const result = elementSchema.safeParse(element);
    if (result.success) {
      valid.push(result.data);
    } else {
      skipped++;
      const errMsg = result.error.issues[0]?.message ?? "unknown";
      if (!firstError) firstError = errMsg;
      logger.warn(
        { error: errMsg, element: JSON.stringify(element).slice(0, 200) },
        "Skipping invalid array element in swarm JSON",
      );
    }
  }

  if (skipped > 0) {
    logger.info({ valid: valid.length, skipped }, "Swarm JSON array: some elements skipped");
  }

  if (parsed.length > 0 && valid.length === 0) {
    throw new Error(
      `All ${parsed.length} array elements failed Zod validation. ` +
        `First error: ${firstError}. This usually means the LLM output format doesn't match the expected schema.`,
    );
  }

  return schema.parse(valid);
}
