/**
 * Pure classifiers and safety decisions for browser-automation cleanup.
 *
 * Keep these functions free of process/filesystem access so real command lines
 * can be regression-tested without launching or signalling anything.
 */

const CHROME_MAIN_EXECUTABLE = "/Google Chrome.app/Contents/MacOS/Google Chrome";
const BROKER_PROFILE_SUFFIX = "/Library/Application Support/Homer/Chrome-CDP";

export type BrowserAutomationKind = "temp-profile-chrome" | "agent-browser-daemon";

export interface BrowserAutomationCleanupInput {
  kind: BrowserAutomationKind;
  pid: number;
  ppid: number;
  command: string;
  ageMs: number;
  graceMs: number;
  protectedPids: ReadonlySet<number>;
  listenerPids: ReadonlySet<number>;
  listenerStateTrusted: boolean;
  brokerProfileDirs: ReadonlySet<string>;
  owningToolGone: boolean;
  sessionSocketAlive: boolean;
  liveAncestor: boolean;
  socketStateTrusted: boolean;
}

export type BrowserAutomationCleanupDecision =
  | { action: "kill"; reason: string }
  | { action: "spare"; reason: string };

/** Extract an explicit --user-data-dir value, including values containing spaces. */
export function extractUserDataDir(cmdline: string): string | null {
  const match = cmdline.match(
    /(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|(.+?))(?=\s+--|\s+(?:about:|https?:\/\/|file:)|$)/,
  );
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? normalizeBrowserProfileDir(value) : null;
}

export function normalizeBrowserProfileDir(profileDir: string): string {
  const trimmed = profileDir.trim().replace(/\/+$/, "");
  return trimmed.startsWith("/private/var/folders/") ? trimmed.slice("/private".length) : trimmed;
}

/** The main Chrome executable, excluding Chrome Helper subprocesses. */
export function isChromeMainCmdline(cmdline: string): boolean {
  const command = cmdline.trim();
  return command.startsWith("/") && command.indexOf(`${CHROME_MAIN_EXECUTABLE} `) > 0
    && !command.slice(0, command.indexOf(`${CHROME_MAIN_EXECUTABLE} `)).includes("Google Chrome Framework.framework");
}

/** Any Chrome-family process that carries a user-data-dir (used for disk references). */
export function isChromeFamilyCmdline(cmdline: string): boolean {
  return cmdline.includes("Google Chrome") && extractUserDataDir(cmdline) !== null;
}

export function isBrokerChromeProfileDir(profileDir: string): boolean {
  return normalizeBrowserProfileDir(profileDir).endsWith(BROKER_PROFILE_SUFFIX);
}

/**
 * Throwaway profiles owned by Homer/browser tooling. The /var/folders form is
 * deliberately anchored to macOS's per-user T directory and a narrow basename.
 */
export function isTempBrowserProfileDir(profileDir: string): boolean {
  const normalized = normalizeBrowserProfileDir(profileDir);
  if (/^\/tmp\/chrome-cdp-profile-[^/]+$/.test(normalized)) return true;
  return /^\/var\/folders\/[^/]+\/[^/]+\/T\/(?:agent-browser-chrome-[^/]+|cdpaudit[^/]*|cdphover[^/]*)$/.test(normalized);
}

export function isTempProfileHeadlessChromeCmdline(cmdline: string): boolean {
  if (!isChromeMainCmdline(cmdline) || !/(?:^|\s)--headless(?:=\S+)?(?:\s|$)/.test(cmdline)) return false;
  const profileDir = extractUserDataDir(cmdline);
  return profileDir !== null && isTempBrowserProfileDir(profileDir) && !isBrokerChromeProfileDir(profileDir);
}

/** Structurally match the native agent-browser daemon executable, not prompt text. */
export function isAgentBrowserDaemonCmdline(cmdline: string): boolean {
  return /^(?:\/[^\s]+)*\/agent-browser-darwin-arm64(?:\s|$)/.test(cmdline.trim());
}

/** Only session control artifacts are eligible; screenshots/text never match. */
export function isAgentBrowserArtifactFilename(filename: string): boolean {
  return /^(?:homer-agent|agent-browser)-[A-Za-z0-9][A-Za-z0-9._-]*\.(?:sock|pid)$/.test(filename);
}

function normalizedSetHas(values: ReadonlySet<string>, candidate: string): boolean {
  const normalized = normalizeBrowserProfileDir(candidate);
  for (const value of values) {
    if (normalizeBrowserProfileDir(value) === normalized) return true;
  }
  return false;
}

/**
 * Final category-specific guard. Every destructive browser-process path calls
 * this before signalling; classification alone never authorizes a kill.
 */
export function decideBrowserAutomationCleanup(
  input: BrowserAutomationCleanupInput,
): BrowserAutomationCleanupDecision {
  if (input.pid <= 1 || input.protectedPids.has(input.pid)) {
    return { action: "spare", reason: `${input.kind}: protected pid` };
  }
  if (input.listenerPids.has(input.pid)) {
    return { action: "spare", reason: `${input.kind}: :9222 listener` };
  }
  if (input.ageMs < input.graceMs) {
    return { action: "spare", reason: `${input.kind}: younger than grace` };
  }

  if (input.kind === "temp-profile-chrome") {
    const profileDir = extractUserDataDir(input.command);
    if (!profileDir) {
      return { action: "spare", reason: "temp-profile-chrome: no explicit user-data-dir" };
    }
    if (isBrokerChromeProfileDir(profileDir) || normalizedSetHas(input.brokerProfileDirs, profileDir)) {
      return { action: "spare", reason: "temp-profile-chrome: broker profile" };
    }
    if (!isTempProfileHeadlessChromeCmdline(input.command)) {
      return { action: "spare", reason: "temp-profile-chrome: not a Homer throwaway headless Chrome" };
    }
    if (!input.listenerStateTrusted) {
      return { action: "spare", reason: "temp-profile-chrome: :9222 listener state untrusted" };
    }
    if (!input.owningToolGone) {
      return { action: "spare", reason: "temp-profile-chrome: owning tool still alive" };
    }
    return { action: "kill", reason: "temp-profile-chrome: owner gone past grace" };
  }

  if (!isAgentBrowserDaemonCmdline(input.command)) {
    return { action: "spare", reason: "agent-browser-daemon: executable mismatch" };
  }
  if (!input.socketStateTrusted) {
    return { action: "spare", reason: "agent-browser-daemon: socket state untrusted" };
  }
  if (input.sessionSocketAlive) {
    return { action: "spare", reason: "agent-browser-daemon: live session socket" };
  }
  if (input.liveAncestor) {
    return { action: "spare", reason: "agent-browser-daemon: live workflow ancestor" };
  }
  return { action: "kill", reason: "agent-browser-daemon: orphaned with dead session socket past grace" };
}
