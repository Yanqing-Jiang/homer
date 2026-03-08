import os from "os";
import path from "path";

export interface RuntimePaths {
  homeDir: string;
  homerRoot: string;
  homerDataDir: string;
  homerLogsDir: string;
  memoryDir: string;
  claudeDir: string;
  browserProfilesDir: string;
  lanesDir: string;
  uploadLandingDir: string;
  archiveDir: string;
  databasePath: string;
  libraryLogsDir: string;
  libraryApplicationSupportDir: string;
  claudeTokenFile: string;
  claudeBinaryPath: string;
  chromeProfileRoot: string;
}

function normalizePath(rawValue: string | undefined, homeDir: string): string | undefined {
  const value = rawValue?.trim();
  if (!value) {
    return undefined;
  }
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/")) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

export function getRuntimePaths(): RuntimePaths {
  const detectedHome = os.homedir();
  const homeDir =
    normalizePath(process.env.HOMER_HOME, detectedHome) ??
    normalizePath(process.env.HOME, detectedHome) ??
    detectedHome;
  const homerRoot =
    normalizePath(process.env.HOMER_ROOT, homeDir) ??
    path.join(homeDir, "homer");
  const homerDataDir =
    normalizePath(process.env.HOMER_DATA_PATH, homeDir) ??
    path.join(homerRoot, "data");
  const homerLogsDir =
    normalizePath(process.env.LOGS_PATH, homeDir) ??
    path.join(homerRoot, "logs");
  const memoryDir =
    normalizePath(process.env.MEMORY_PATH, homeDir) ??
    path.join(homeDir, "memory");
  const claudeDir =
    normalizePath(process.env.CLAUDE_DIR, homeDir) ??
    path.join(homeDir, ".claude");
  const browserProfilesDir =
    normalizePath(process.env.BROWSER_PROFILES_PATH, homeDir) ??
    path.join(homerRoot, "profiles");
  const lanesDir =
    normalizePath(process.env.LANES_PATH, homeDir) ??
    path.join(homeDir, "lanes");
  const uploadLandingDir =
    normalizePath(process.env.UPLOAD_LANDING_PATH, homeDir) ??
    path.join(homeDir, "homer-upload-landing");
  const archiveDir =
    normalizePath(process.env.ARCHIVE_PATH, homeDir) ??
    path.join(homeDir, "archive");
  const databasePath =
    normalizePath(process.env.DATABASE_PATH, homeDir) ??
    path.join(homerDataDir, "homer.db");
  const libraryLogsDir =
    normalizePath(process.env.HOMER_LOG_DIR, homeDir) ??
    path.join(homeDir, "Library", "Logs", "homer");
  const libraryApplicationSupportDir = path.join(
    homeDir,
    "Library",
    "Application Support",
  );
  const claudeTokenFile = path.join(homeDir, ".homer-claude-token");
  const claudeBinaryPath =
    normalizePath(process.env.CLAUDE_PATH, homeDir) ??
    path.join(homeDir, ".local", "bin", "claude");
  const chromeProfileRoot = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
  );

  return {
    homeDir,
    homerRoot,
    homerDataDir,
    homerLogsDir,
    memoryDir,
    claudeDir,
    browserProfilesDir,
    lanesDir,
    uploadLandingDir,
    archiveDir,
    databasePath,
    libraryLogsDir,
    libraryApplicationSupportDir,
    claudeTokenFile,
    claudeBinaryPath,
    chromeProfileRoot,
  };
}
