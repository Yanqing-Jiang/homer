/**
 * Centralized path constants derived from config.
 *
 * Import PATHS anywhere instead of hardcoding "/Users/yj/memory/..." etc.
 * All paths resolve from config.paths.memory / claudeDir / homerData,
 * which themselves fall back to env vars or sensible defaults.
 */

import { config } from "./index.js";

const mem = config.paths.memory;
const claude = config.paths.claudeDir;
const data = config.paths.homerData;

export const PATHS = {
  // ── Memory root ─────────────────────────────────────────────
  memory: mem,

  // Core memory files
  me: `${mem}/me.md`,
  work: `${mem}/work.md`,
  life: `${mem}/life.md`,
  preferences: `${mem}/preferences.md`,
  tools: `${mem}/tools.md`,
  patterns: `${mem}/patterns.md`,
  denyHistory: `${mem}/deny-history.md`,
  feedback: `${mem}/feedback.md`,

  // Memory subdirectories
  ideas: `${mem}/ideas`,
  daily: `${mem}/daily`,
  meetings: `${mem}/meetings`,
  plans: `${mem}/plans`,
  scrapes: `${mem}/scrapes`,
  backups: `${mem}/backups`,

  // Legacy files (may be removed)
  ideasMd: `${mem}/ideas.md`,
  schedule: `${mem}/schedule.json`,

  // ── Claude dir ──────────────────────────────────────────────
  claudeDir: claude,
  claudeMd: `${claude}/CLAUDE.md`,

  // ── Homer data ──────────────────────────────────────────────
  homerData: data,
  db: `${data}/homer.db`,
} as const;
