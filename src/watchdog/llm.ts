import { getRepairHandlerForSignature } from "./repair-plan.js";
import {
  isRepairHandler,
  isWatchdogAction,
  isWatchdogSignature,
  type ParsedLlmDecision,
  type WatchdogAction,
  type WatchdogSignature,
} from "./types.js";

export interface LlmNormalizationResult {
  decision: ParsedLlmDecision | null;
  failureSignature: WatchdogSignature | null;
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }

  return null;
}

function normalizeAction(rawAction: unknown): WatchdogAction | null {
  if (typeof rawAction !== "string") {
    return null;
  }
  const normalized = rawAction.trim().toLowerCase();
  if (normalized === "fix") {
    return "source_fix";
  }
  if (!isWatchdogAction(normalized)) {
    return null;
  }
  return normalized;
}

function extractActionFromText(raw: string): WatchdogAction | null {
  const lower = raw.toLowerCase();
  if (lower.includes("source_fix") || /\bfix\b/.test(lower)) {
    return "source_fix";
  }
  if (lower.includes("force_kill")) {
    return "force_kill";
  }
  if (lower.includes("restart")) {
    return "restart";
  }
  if (lower.includes("repair")) {
    return "repair";
  }
  if (lower.includes("escalate")) {
    return "escalate";
  }
  return null;
}

function extractSignatureFromText(raw: string, fallbackSignature: WatchdogSignature): WatchdogSignature {
  for (const token of raw.match(/[a-z_]+/gi) ?? []) {
    if (isWatchdogSignature(token)) {
      return token;
    }
  }
  return fallbackSignature;
}

function extractRepairHandlerFromText(raw: string, signature: WatchdogSignature) {
  const handlerMatch = raw.match(/repair_(native_modules|launchd_runtime|stale_lock)/i)?.[0]?.toLowerCase() ?? null;
  if (handlerMatch !== null && isRepairHandler(handlerMatch)) {
    return handlerMatch;
  }
  return getRepairHandlerForSignature(signature);
}

export function normalizeLlmDecision(
  raw: string,
  fallbackSignature: WatchdogSignature,
): LlmNormalizationResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { decision: null, failureSignature: "llm_parse_failure" };
  }
  if (/(quota|rate limit|daily limit reached|usage limit|credits? exhausted)/i.test(trimmed)) {
    return { decision: null, failureSignature: "llm_quota_exhausted" };
  }

  const jsonCandidate = extractJsonObject(trimmed);
  let parsed: Record<string, unknown> | null = null;
  if (jsonCandidate) {
    try {
      parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }

  const action = normalizeAction(parsed?.action ?? extractActionFromText(trimmed));
  const signature = (() => {
    const rawSignature = parsed?.signature;
    if (typeof rawSignature === "string" && isWatchdogSignature(rawSignature)) {
      return rawSignature;
    }
    return extractSignatureFromText(trimmed, fallbackSignature);
  })();
  const repairHandler = (() => {
    const rawRepairHandler = parsed?.repairHandler;
    if (typeof rawRepairHandler === "string" && isRepairHandler(rawRepairHandler)) {
      return rawRepairHandler;
    }
    return extractRepairHandlerFromText(trimmed, signature);
  })();
  const reason = (() => {
    const rawReason = parsed?.reason;
    if (typeof rawReason === "string" && rawReason.trim().length > 0) {
      return rawReason.trim();
    }
    return "Claude triage selected this action.";
  })();

  if (action === null) {
    return { decision: null, failureSignature: "llm_parse_failure" };
  }

  if (action === "repair" && repairHandler === null) {
    return { decision: null, failureSignature: "llm_parse_failure" };
  }

  return {
    decision: {
      action,
      signature,
      repairHandler: action === "repair" ? repairHandler : null,
      reason,
    },
    failureSignature: null,
  };
}
