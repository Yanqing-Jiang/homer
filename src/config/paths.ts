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

  // Core memory files
  me: `${mem}/me.md`,
  work: `${mem}/work.md`,
  preferences: `${mem}/preferences.md`,
  tools: `${mem}/tools.md`,
  patterns: `${mem}/patterns.md`,
  sessionBootstrap: `${mem}/session-bootstrap.md`,

  // Memory subdirectories
  ideas: `${mem}/ideas`,
  daily: `${mem}/daily`,
  meetings: `${mem}/meetings`,
  plans: `${mem}/plans`,
  scrapes: `${mem}/scrapes`,
  backups: `${mem}/backups`,
  skills: `${mem}/skills`,
  youtubeMemory: `${mem}/youtube`,

  // Legacy files (may be removed)
  ideasMd: `${mem}/ideas.md`,
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
