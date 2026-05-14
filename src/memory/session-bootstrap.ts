/**
 * Session bootstrap generator.
 *
 * Replaces broad bootstrap injection of me.md + work.md + preferences.md (~22 KB)
 * with a tiny generated projection (~1.5 KB) that names current top priorities
 * and paused/non-priority items explicitly. The loader injects only the generated
 * file, so the model never sees stale "current goal" prose at boot.
 *
 * Source-of-truth rules:
 *   - me.md "### Short-Term" numbered list  → active top priorities
 *   - me.md "### Paused"   bulleted list    → paused (overrides Short-Term)
 *   - work.md "## Active Projects" "###" blocks → partition by **Status:** paused
 *   - **Paused always wins** over an active-looking heading or short-term mention.
 *
 * Drift policy:
 *   This module is the ONLY parser of me.md/work.md focus state. Any consumer that
 *   wants "what is Yanqing focused on right now" must call getCurrentFocus(). Do
 *   not re-implement raw markdown parsing for current focus elsewhere.
 *
 * Escalation triggers (when to replace this with a memory_focus_items table):
 *   - Focus changes more than once a month for two consecutive months
 *   - A second consumer needs structured "active vs paused" filters AND the
 *     parser becomes a hot spot
 *   - A real prose-drift incident gets caught (not a hypothetical one)
 */

import { readFile, writeFile, rename, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";
import { PATHS } from "../config/paths.js";
import { logger } from "../utils/logger.js";

const SESSION_BOOTSTRAP_PATH = `${PATHS.memory}/session-bootstrap.md`;
const MAX_BYTES = 2_500;

export interface FocusProjection {
  /** Active top priorities, parsed from me.md `### Short-Term` numbered list. */
  active: string[];
  /** Items explicitly paused, parsed from me.md `### Paused` bulleted list. */
  paused: string[];
  /** Active work projects from work.md `## Active Projects`, status != paused. */
  activeProjects: string[];
  /** Work projects with `**Status:** paused`. */
  pausedProjects: string[];
}

export interface IdentitySnapshot {
  name: string;
  location: string;
  timezone: string;
  role: string;
  target: string;
}

// ── Parsing ──────────────────────────────────────────────────────────────

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s*\([^)]*\)\s*/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function readField(md: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = md.match(new RegExp(`\\*\\*${escaped}:\\*\\*\\s*([^\\n]+)`));
  return m?.[1]?.trim() ?? null;
}

function extractSection(md: string, headingPattern: RegExp): string | null {
  const m = md.match(headingPattern);
  return m?.[1]?.trim() ?? null;
}

/**
 * Parse focus from raw me.md + work.md content. Pure function — easy to test.
 *
 * @throws if zero active + zero paused items are parsed (sanity floor).
 */
export function parseFocus(meMd: string, workMd: string): FocusProjection {
  // me.md: ### Short-Term ... → numbered "**Label**" items
  const shortTermBlock = extractSection(meMd, /### Short-Term[^\n]*\n([\s\S]*?)(?=\n###\s|\n## )/);
  const active = shortTermBlock
    ? Array.from(shortTermBlock.matchAll(/^\d+\.\s+\*\*([^*]+?)\*\*\s*\.?\s*([^\n]*)/gm)).map((m) => {
        const label = m[1]!.trim().replace(/\.$/, "");
        // Strip leading separators (—, -, :, .) so "**Foo** — active" doesn't render as "Foo — — active".
        const tail = (m[2]?.trim() ?? "").replace(/^[—\-:.\s]+/, "");
        return tail ? `${label} — ${tail}` : label;
      })
    : [];

  // me.md: ### Paused ... → "- **Label**" bullets
  const pausedBlock = extractSection(meMd, /### Paused[^\n]*\n([\s\S]*?)(?=\n###\s|\n## )/);
  const pausedFromMe = pausedBlock
    ? Array.from(pausedBlock.matchAll(/^- \*\*([^*]+?)\*\*([^\n]*)/gm)).map((m) => {
        const label = m[1]!.trim();
        const tail = m[2]?.trim().replace(/^[—\-:]\s*/, "") ?? "";
        return tail ? `${label} — ${tail}` : label;
      })
    : [];

  // work.md: ## Active Projects → split by ### headings, partition by Status: paused
  const apBlock = extractSection(workMd, /## Active Projects\n([\s\S]*?)(?=\n## |\n---|$)/);
  const activeProjects: string[] = [];
  const pausedProjects: string[] = [];
  if (apBlock) {
    // Prefix a newline so the leading "### Heading" (which has no preceding \n in
    // the captured section) also splits cleanly on /\n### /.
    const blocks = `\n${apBlock}`.split(/\n### /).slice(1);
    for (const b of blocks) {
      const title = b.split("\n")[0]?.trim() ?? "";
      if (!title) continue;
      const cleanTitle = title.replace(/\s*\(([^)]*)\)\s*$/, "").trim();
      // Match "paused" anywhere on the Status line. Captures variants like
      // "**Status:** paused", "**Status:** automation build-out paused", etc.
      const isPaused = /\*\*Status:\*\*[^\n]*?\bpaused\b/i.test(b);
      (isPaused ? pausedProjects : activeProjects).push(cleanTitle);
    }
  }

  // Paused-wins rule: drop any active item whose normalized key matches a paused entry.
  const pausedKeys = new Set([
    ...pausedFromMe.map((s) => normalizeKey(s.split("—")[0]!)),
    ...pausedProjects.map(normalizeKey),
  ]);
  const filteredActive = active.filter((s) => {
    const key = normalizeKey(s.split("—")[0]!);
    // partial-key match (e.g. "mahoraga" appears inside "mahoraga-quant-trading")
    for (const pk of pausedKeys) {
      if (pk && (key.includes(pk) || pk.includes(key))) return false;
    }
    return true;
  });

  if (
    filteredActive.length === 0 &&
    pausedFromMe.length === 0 &&
    activeProjects.length === 0 &&
    pausedProjects.length === 0
  ) {
    throw new Error(
      "session-bootstrap: parsed zero focus items — check me.md '### Short-Term' / '### Paused' " +
        "and work.md '## Active Projects' headings",
    );
  }

  return {
    active: filteredActive,
    paused: pausedFromMe,
    activeProjects,
    pausedProjects,
  };
}

export function parseIdentity(meMd: string): IdentitySnapshot {
  return {
    name: readField(meMd, "Name") ?? "Yanqing Jiang",
    location: readField(meMd, "Location") ?? "Newcastle, WA",
    timezone: readField(meMd, "Timezone") ?? "PST",
    role: readField(meMd, "Role") ?? "Sr Manager, Advanced Analytics @ P&G (Amazon Team)",
    target: readField(meMd, "Target") ?? "B3/Director promo or $250K-$350K tech switch",
  };
}

// ── Rendering ────────────────────────────────────────────────────────────

export function renderBootstrap(identity: IdentitySnapshot, focus: FocusProjection, generatedAt: string): string {
  const pausedAll = [
    ...focus.paused,
    ...focus.pausedProjects.filter((p) => !focus.paused.some((mp) => normalizeKey(mp).includes(normalizeKey(p)))).map((p) => `${p} (work)`),
  ];

  const activeProjectsLine =
    focus.activeProjects.length > 0
      ? focus.activeProjects.slice(0, 8).join(", ")
      : "(none parsed)";

  const lines = [
    "# Homer Session Bootstrap",
    "",
    `Generated: ${generatedAt}`,
    "Source: ~/memory/me.md (`### Short-Term`, `### Paused`) + ~/memory/work.md (`## Active Projects` `**Status:**`).",
    "Do not edit by hand. Edit the source sections and regenerate (`npm run -s memory:generate-bootstrap`).",
    "",
    "## Identity",
    `- Assistant: HOMER, ${identity.name}'s personal AI OS.`,
    `- User: ${identity.name}; ${identity.location}; ${identity.timezone}.`,
    `- Role: ${identity.role}.`,
    `- Career target: ${identity.target}.`,
    "",
    "## Current Top Priorities",
    ...(focus.active.length > 0
      ? focus.active.slice(0, 5).map((item, i) => `${i + 1}. ${item}`)
      : ["(none parsed — check me.md `### Short-Term`)"]),
    "",
    "## Active Work Projects",
    `- ${activeProjectsLine}`,
    "",
    "## Paused / Not Current Focus",
    ...(pausedAll.length > 0 ? pausedAll.map((p) => `- ${p}`) : ["- (none recorded)"]),
    "",
    "## Retrieval Rule",
    "- For current status, plans, recent activity, or pending decisions: call `memory_context` first.",
    "- For project history, narrative, or full preferences: call `memory_read` (file=me|work|preferences|tools) or `memory_search`.",
    "- If MCP is unavailable: read ~/memory/me.md / ~/memory/work.md directly.",
    "",
  ];

  return lines.join("\n");
}

// ── Public API ───────────────────────────────────────────────────────────

async function readIfExists(path: string): Promise<string> {
  if (!existsSync(path)) return "";
  return readFile(path, "utf-8");
}

/**
 * Read source files, parse, and return the structured focus projection.
 * Consumers (schedulers, briefs, idea filters) should call this instead of
 * re-parsing me.md / work.md directly.
 */
export async function getCurrentFocus(): Promise<FocusProjection> {
  const [meMd, workMd] = await Promise.all([readIfExists(PATHS.me), readIfExists(PATHS.work)]);
  return parseFocus(meMd, workMd);
}

/**
 * Generate ~/memory/session-bootstrap.md from current me.md + work.md.
 * Atomic write; refuses to write if size > MAX_BYTES (catches runaway growth).
 */
export async function generateBootstrap(): Promise<{ path: string; bytes: number }> {
  const [meMd, workMd] = await Promise.all([readIfExists(PATHS.me), readIfExists(PATHS.work)]);
  const identity = parseIdentity(meMd);
  const focus = parseFocus(meMd, workMd);
  const out = renderBootstrap(identity, focus, new Date().toISOString());
  const bytes = Buffer.byteLength(out, "utf-8");
  if (bytes > MAX_BYTES) {
    throw new Error(`session-bootstrap: generated file ${bytes} bytes exceeds MAX_BYTES ${MAX_BYTES}`);
  }
  await mkdir(dirname(SESSION_BOOTSTRAP_PATH), { recursive: true });

  // Atomic write: temp file in the same directory then rename(). Prevents
  // concurrent readers (loader, MCP, scripts) from observing a half-written
  // file when two ensureSessionBootstrap() calls race. The temp suffix is
  // randomized so concurrent generators don't clobber each other's temp file.
  const tmpPath = `${SESSION_BOOTSTRAP_PATH}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmpPath, out, "utf-8");
    await rename(tmpPath, SESSION_BOOTSTRAP_PATH);
  } catch (err) {
    // Best-effort cleanup of temp file if rename failed.
    try { await unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  return { path: SESSION_BOOTSTRAP_PATH, bytes };
}

/**
 * Best-effort regen called from the loader. Never throws — if generation fails
 * we log and continue (the loader will fall back to the previous file via
 * the existing loadMemoryFile behavior).
 */
export async function ensureSessionBootstrap(): Promise<void> {
  try {
    const { bytes } = await generateBootstrap();
    logger.debug({ bytes }, "session-bootstrap regenerated");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "session-bootstrap regen failed; using existing file");
  }
}

// ── CLI entrypoint (for `npm run memory:generate-bootstrap`) ─────────────

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  generateBootstrap()
    .then(({ path, bytes }) => {
      console.log(`Generated ${path} (${bytes} bytes)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
