/**
 * Secret filter — deterministic redaction of credentials before sending content to LLMs.
 *
 * Phase 0.6 of the refactor plan. Every LLM-bound pipeline (nightly-memory, session-summaries,
 * idea-synthesizer, learning-engine, homer-improvements, daily-log summarizer) should pipe
 * content through `redactSecrets()` at the boundary.
 *
 * Scope: pattern-matches common credential formats. Not a substitute for proper secret
 * management, but closes the accidental exfiltration gap where a session transcript
 * containing `export ANTHROPIC_API_KEY=sk-...` gets shipped to Gemini for fact extraction.
 *
 * Philosophy: prefer false positives (redact legit text that looks key-shaped) over false
 * negatives (leak an actual key). The caller sees `[REDACTED:<kind>]` and the logger
 * records counts per kind for monitoring.
 */

import { logger } from "../utils/logger.js";

export interface SecretPattern {
  kind: string;
  regex: RegExp;
  replacement?: string;
}

// Order matters: more-specific patterns first. Generic patterns (high-entropy strings)
// come last so they don't shadow the specific ones.
export const SECRET_PATTERNS: SecretPattern[] = [
  // Anthropic / OpenAI / Stripe / GitHub — well-known prefixed keys
  { kind: "anthropic-key", regex: /\bsk-ant-[a-zA-Z0-9_-]{20,}/g },
  { kind: "openai-key", regex: /\bsk-proj-[a-zA-Z0-9_-]{20,}/g },
  { kind: "openai-key", regex: /\bsk-[a-zA-Z0-9]{20,}/g },
  { kind: "github-token", regex: /\bghp_[a-zA-Z0-9]{30,}/g },
  { kind: "github-token", regex: /\bgho_[a-zA-Z0-9]{30,}/g },
  { kind: "github-token", regex: /\bghs_[a-zA-Z0-9]{30,}/g },
  { kind: "stripe-key", regex: /\b(sk|rk|pk)_(live|test)_[a-zA-Z0-9]{20,}/g },
  { kind: "slack-token", regex: /\bxox[baprs]-[a-zA-Z0-9-]{10,}/g },

  // AWS
  { kind: "aws-access-key", regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "aws-secret", regex: /aws_secret_access_key\s*=\s*["']?[a-zA-Z0-9/+=]{40}["']?/gi },

  // Google / Gemini API keys
  { kind: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}/g },

  // Generic export-style env var leaks
  { kind: "env-export", regex: /\bexport\s+[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_CREDENTIAL)[A-Z0-9_]*\s*=\s*["']?[^\s"'\n]{8,}["']?/g },

  // Bare .env-style assignments (no `export` prefix). Common in dotenv files
  // and pasted into session transcripts. Covers names like:
  //   OPENAI_API_KEY=sk-...
  //   ANTHROPIC_API_KEY="..."
  //   DATABASE_PASSWORD=hunter2
  //   GITHUB_TOKEN=ghp_...
  // Redacts only the value portion; keeps the variable name visible for context.
  { kind: "env-assignment", regex: /\b([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_CREDENTIAL|_APIKEY|_ACCESS_KEY|_PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*["']?([^\s"'\n]{8,})["']?/g, replacement: "$1=[REDACTED:env-assignment]" },

  // Private key PEM blocks
  { kind: "private-key", regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },

  // SSH private key fingerprint markers (partial leaks)
  { kind: "ssh-private-key", regex: /\bssh-(?:rsa|ed25519|dss|ecdsa)\s+AAAA[0-9A-Za-z+/=]{100,}/g },

  // JWT (three base64 segments joined by dots, typical lengths)
  { kind: "jwt", regex: /\beyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g },

  // Basic auth URL embedded credentials
  { kind: "url-credential", regex: /\b(https?|ftp|ssh|git):\/\/[^\s:@/]+:[^\s:@/]+@[^\s]+/g },
];

export interface RedactionResult {
  content: string;
  redactionCount: number;
  redactionsByKind: Record<string, number>;
}

/**
 * Redact known secret patterns from content. Returns redacted string + metadata.
 *
 * The redaction is idempotent (already-redacted strings are untouched).
 */
export function redactSecrets(content: string): RedactionResult {
  let working = content;
  const redactionsByKind: Record<string, number> = {};
  let total = 0;

  for (const { kind, regex, replacement } of SECRET_PATTERNS) {
    working = working.replace(regex, (...args) => {
      redactionsByKind[kind] = (redactionsByKind[kind] ?? 0) + 1;
      total++;
      if (typeof replacement === "string") {
        // Support standard $1..$9 capture refs so patterns can preserve context
        // like the variable name in an env assignment.
        return replacement.replace(/\$(\d)/g, (_m, d) => {
          const idx = Number(d);
          // args: match, p1, p2, ..., offset, fullString, groups?
          return typeof args[idx] === "string" ? (args[idx] as string) : "";
        });
      }
      return `[REDACTED:${kind}]`;
    });
  }

  return { content: working, redactionCount: total, redactionsByKind };
}

/**
 * Redact-and-log helper for LLM-bound content. Logs at warn level when any redaction
 * occurred so the operator can investigate false positives or real leaks.
 */
export function redactForLLM(content: string, source: string): string {
  const result = redactSecrets(content);
  if (result.redactionCount > 0) {
    logger.warn(
      { source, redactionCount: result.redactionCount, redactionsByKind: result.redactionsByKind },
      "Secrets redacted from LLM-bound content"
    );
  }
  return result.content;
}
