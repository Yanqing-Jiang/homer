/**
 * Centralized path constants derived from the runtime environment.
 *
 * Import PATHS anywhere instead of hardcoding "/Users/yj/memory/..." etc.
 * These paths intentionally do not import the daemon config because library
 * entry points such as the MCP server do not require Telegram credentials.
 */

import { getRuntimePaths } from "../utils/runtime-paths.js";

const runtimePaths = getRuntimePaths();
const mem = runtimePaths.memoryDir;
const claude = runtimePaths.claudeDir;
const data = runtimePaths.homerDataDir;
const homer = runtimePaths.homerRoot;
const archive = runtimePaths.archiveDir;

export const PATHS = {
  // ── Memory root ─────────────────────────────────────────────
  memory: mem,

  // Legacy canonical-memory file locations. Phase 5 moved the content into
  // memory_documents; these paths survive only as the `source_ref` recorded on
  // each document and as the seed path for a fresh install.
  me: `${mem}/me.md`,
  work: `${mem}/work.md`,
  preferences: `${mem}/preferences.md`,
  tools: `${mem}/tools.md`,
  patterns: `${mem}/patterns.md`,

  // Memory subdirectories with a live writer. Phase 6 retired the rest:
  // daily/, plans/, backups/ and youtube/ are archived under
  // ~/homer/backups/phase6-md-final/ and their content is DB-authoritative
  // (session_summaries, memory_documents, youtube_videos). The folders the
  // indexer still scans are declared in MEMORY_SCAN_DIRS (src/memory/indexer.ts).
  meetings: `${mem}/meetings`,
  scrapes: `${mem}/scrapes`,
  skills: `${mem}/skills`,

  // Legacy files (may be removed)
  schedule: `${mem}/schedule.json`,

  // ── Claude dir ──────────────────────────────────────────────
  claudeDir: claude,
  claudeMd: `${claude}/CLAUDE.md`,

  // ── Homer root ─────────────────────────────────────────────
  homerRoot: homer,
  architectureMd: `${homer}/docs/architecture.md`,

  // ── Homer data ──────────────────────────────────────────────
  homerData: data,
  db: `${data}/homer.db`,

  // ── Archive ───────────────────────────────────────────────
  archive: archive,
} as const;
