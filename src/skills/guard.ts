/**
 * Skills Guard — Lightweight security scanner for memory and skill content.
 *
 * 15 critical regex patterns for injection, exfiltration, and destructive commands.
 * Applied only to HITL bypass paths (promoteToFile internal calls, writeCleanedFile,
 * auto-approve threshold). HITL-gated paths don't need scanning — the human IS the scanner.
 *
 * Inspired by Hermes agent's tools/skills_guard.py (60+ patterns) but scoped
 * for single-user personal assistant where the user is not a malicious actor.
 * The threat model is indirect injection from summarized web content.
 */

// ── Threat Patterns ─────────────────────────────────────────

interface ThreatPattern {
  id: string;
  regex: RegExp;
  severity: "critical" | "high";
  category: "injection" | "exfiltration" | "destructive";
  description: string;
}

const THREAT_PATTERNS: ThreatPattern[] = [
  // Injection — prompt override / role hijacking
  { id: "prompt_injection_ignore", regex: /ignore\s+(?:\w+\s+)*(previous|all|above|prior)\s+instructions/i,
    severity: "critical", category: "injection", description: "Prompt injection: ignore previous instructions" },
  { id: "role_hijack", regex: /you\s+are\s+(?:\w+\s+)*now\s+/i,
    severity: "critical", category: "injection", description: "Role hijacking attempt" },
  { id: "deception_hide", regex: /do\s+not\s+(?:\w+\s+)*tell\s+(?:\w+\s+)*the\s+user/i,
    severity: "critical", category: "injection", description: "Instructs agent to hide information" },
  { id: "sys_prompt_override", regex: /system\s+prompt\s+override/i,
    severity: "critical", category: "injection", description: "System prompt override attempt" },
  { id: "disregard_rules", regex: /disregard\s+(?:\w+\s+)*(your|all|any)\s+(?:\w+\s+)*(instructions|rules|guidelines)/i,
    severity: "critical", category: "injection", description: "Disregard instructions" },

  // Exfiltration — leaking secrets
  { id: "exfil_curl", regex: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    severity: "critical", category: "exfiltration", description: "curl with secret env variable" },
  { id: "exfil_wget", regex: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    severity: "critical", category: "exfiltration", description: "wget with secret env variable" },
  { id: "read_secrets", regex: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i,
    severity: "critical", category: "exfiltration", description: "Reading known secrets file" },
  { id: "ssh_dir_access", regex: /~\/\.ssh\b|authorized_keys/i,
    severity: "critical", category: "exfiltration", description: "SSH directory / authorized_keys access" },
  { id: "dns_exfil", regex: /\b(dig|nslookup|host)\s+[^\n]*\$/,
    severity: "critical", category: "exfiltration", description: "DNS exfiltration with variable interpolation" },

  // Destructive — system damage
  { id: "destructive_root_rm", regex: /rm\s+-rf\s+\//,
    severity: "critical", category: "destructive", description: "Recursive delete from root" },
  { id: "destructive_home_rm", regex: /rm\s+-rf\s+~\//,
    severity: "critical", category: "destructive", description: "Recursive delete from home" },
  { id: "format_filesystem", regex: /\bmkfs\b/,
    severity: "critical", category: "destructive", description: "Filesystem format command" },
  { id: "disk_overwrite", regex: /\bdd\s+if=.*of=\/dev\//,
    severity: "critical", category: "destructive", description: "Direct disk overwrite" },
  { id: "sudoers_mod", regex: /\/etc\/sudoers|visudo/,
    severity: "critical", category: "destructive", description: "Sudoers modification" },
];

// Invisible unicode characters that can be used for injection
const INVISIBLE_CHARS = new Set([
  "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", // zero-width
  "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", // bidi overrides
]);

// ── Public API ──────────────────────────────────────────────

export interface ScanFinding {
  patternId: string;
  severity: "critical" | "high";
  category: string;
  description: string;
  matchedText: string;
}

export interface ScanResult {
  clean: boolean;
  findings: ScanFinding[];
  summary: string;
}

/**
 * Scan content for security threats. Returns findings (empty if clean).
 * Used as defense-in-depth on HITL bypass paths.
 */
export function scanContent(content: string): ScanResult {
  const findings: ScanFinding[] = [];

  // Check for invisible unicode characters
  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      findings.push({
        patternId: "invisible_unicode",
        severity: "high",
        category: "injection",
        description: `Invisible unicode character detected: U+${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
        matchedText: `U+${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      });
      break; // one finding is enough
    }
  }

  // Check regex patterns
  for (const pattern of THREAT_PATTERNS) {
    const match = pattern.regex.exec(content);
    if (match) {
      findings.push({
        patternId: pattern.id,
        severity: pattern.severity,
        category: pattern.category,
        description: pattern.description,
        matchedText: match[0].slice(0, 80),
      });
    }
  }

  const clean = findings.length === 0;
  const summary = clean
    ? "Clean"
    : `${findings.length} finding(s): ${findings.map(f => f.patternId).join(", ")}`;

  return { clean, findings, summary };
}

/**
 * Quick check for memory content — returns error message if blocked, null if clean.
 * Lighter weight than full scan — for use in promoteToFile().
 */
export function scanMemoryContent(content: string): string | null {
  const result = scanContent(content);
  if (result.clean) return null;

  const critical = result.findings.filter(f => f.severity === "critical");
  if (critical.length === 0) return null; // only block on critical findings

  return `Blocked: ${critical.map(f => f.description).join("; ")}`;
}
