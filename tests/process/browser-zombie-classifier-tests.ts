import assert from "node:assert/strict";
import test from "node:test";
import {
  decideBrowserAutomationCleanup,
  extractUserDataDir,
  isAgentBrowserArtifactFilename,
  isAgentBrowserDaemonCmdline,
  isBrokerChromeProfileDir,
  isTempBrowserProfileDir,
  isTempProfileHeadlessChromeCmdline,
  type BrowserAutomationCleanupInput,
} from "../../src/process/browser-zombie-classifier.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const AUDIT = `${CHROME} --headless=new --remote-debugging-port=9333 --user-data-dir=/var/folders/0p/kd6mmbxd255gtw2zgf01yhbr0000gn/T/cdpaudit0rzdigr5`;
const HOVER = `${CHROME} --headless=new --remote-debugging-port=9351 --user-data-dir=/var/folders/0p/kd6mmbxd255gtw2zgf01yhbr0000gn/T/cdphoverabc123`;
const FALLBACK = `${CHROME} --remote-debugging-port=0 --headless=new --enable-unsafe-swiftshader --user-data-dir=/var/folders/0p/kd6mmbxd255gtw2zgf01yhbr0000gn/T/agent-browser-chrome-1a350420-4a3c-49f3-8e73-62b636cb79cb --window-size=1280,720`;
const LEGACY = `${CHROME} --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-cdp-profile-12345`;
const BROKER = `${CHROME} --headless=new --remote-debugging-port=9222 --user-data-dir=/Users/yj/Library/Application Support/Homer/Chrome-CDP --profile-directory=Default about:blank`;
const PERSONAL = `${CHROME} --profile-directory=Default`;
const DAEMON = "/opt/homebrew/lib/node_modules/agent-browser/bin/agent-browser-darwin-arm64";
const GRACE = 30 * 60 * 1000;

test("classifies real throwaway headless Chrome command lines", () => {
  for (const command of [AUDIT, HOVER, FALLBACK, LEGACY]) {
    assert.equal(isTempProfileHeadlessChromeCmdline(command), true, command);
    const profile = extractUserDataDir(command);
    assert.ok(profile);
    assert.equal(isTempBrowserProfileDir(profile), true);
  }
});

test("never classifies personal or broker-supervised Chrome", () => {
  assert.equal(extractUserDataDir(PERSONAL), null);
  assert.equal(isTempProfileHeadlessChromeCmdline(PERSONAL), false);
  assert.equal(isTempProfileHeadlessChromeCmdline(BROKER), false);
  assert.equal(isBrokerChromeProfileDir(extractUserDataDir(BROKER)!), true);
  assert.equal(isTempProfileHeadlessChromeCmdline(`node worker.js prompt=${AUDIT}`), false, "prompt text is not an executable match");

  const helper = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/151/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=gpu-process --headless=new --user-data-dir=/var/folders/0p/id/T/agent-browser-chrome-uuid";
  assert.equal(isTempProfileHeadlessChromeCmdline(helper), false, "helper subprocesses are not independently signalled");
});

test("normalizes /private/var temp aliases and rejects broad temp paths", () => {
  assert.equal(isTempBrowserProfileDir("/private/var/folders/0p/id/T/cdphoverxyz"), true);
  assert.equal(isTempBrowserProfileDir("/var/folders/0p/id/T/random-profile"), false);
  assert.equal(isTempBrowserProfileDir("/tmp/agent-browser-chrome-uuid"), false);
  assert.equal(isTempBrowserProfileDir("/Users/yj/Library/Application Support/Homer/Chrome-CDP"), false);
});

test("structurally classifies agent-browser daemon without prompt false positives", () => {
  assert.equal(isAgentBrowserDaemonCmdline(DAEMON), true);
  assert.equal(isAgentBrowserDaemonCmdline(`${DAEMON} --some-future-flag`), true);
  assert.equal(isAgentBrowserDaemonCmdline(`node worker.js prompt=${DAEMON}`), false);
  assert.equal(isAgentBrowserDaemonCmdline("/opt/homebrew/bin/agent-browser"), false);
});

test("artifact filename filter allows only agent-browser session control files", () => {
  for (const name of [
    "homer-agent-portal-81191736.sock",
    "homer-agent-portal-81191736.pid",
    "agent-browser-session-123.sock",
    "agent-browser-session-123.pid",
  ]) assert.equal(isAgentBrowserArtifactFilename(name), true, name);

  for (const name of [
    "after-send.png",
    "settings-snap.txt",
    "homer-agent-portal-81191736.png",
    "homer-agent.sock.bak",
    "unrelated.sock",
    "../homer-agent-x.sock",
  ]) assert.equal(isAgentBrowserArtifactFilename(name), false, name);
});

function chromeInput(overrides: Partial<BrowserAutomationCleanupInput> = {}): BrowserAutomationCleanupInput {
  return {
    kind: "temp-profile-chrome",
    pid: 44001,
    ppid: 1,
    command: AUDIT,
    ageMs: GRACE,
    graceMs: GRACE,
    protectedPids: new Set(),
    listenerPids: new Set(),
    listenerStateTrusted: true,
    brokerProfileDirs: new Set(["/Users/yj/Library/Application Support/Homer/Chrome-CDP"]),
    owningToolGone: true,
    sessionSocketAlive: false,
    liveAncestor: false,
    socketStateTrusted: true,
    ...overrides,
  };
}

test("Chrome kill decision requires grace, dead owner, trusted listener state, and all broker rails clear", () => {
  assert.equal(decideBrowserAutomationCleanup(chromeInput()).action, "kill", "age exactly at grace is eligible");
  assert.match(decideBrowserAutomationCleanup(chromeInput({ ageMs: GRACE - 1 })).reason, /younger than grace/);
  assert.match(decideBrowserAutomationCleanup(chromeInput({ owningToolGone: false })).reason, /owning tool still alive/);
  assert.match(decideBrowserAutomationCleanup(chromeInput({ listenerStateTrusted: false })).reason, /listener state untrusted/);
  assert.match(decideBrowserAutomationCleanup(chromeInput({ protectedPids: new Set([44001]) })).reason, /protected pid/);
  assert.match(decideBrowserAutomationCleanup(chromeInput({ listenerPids: new Set([44001]) })).reason, /:9222 listener/);
  assert.match(decideBrowserAutomationCleanup(chromeInput({ command: PERSONAL })).reason, /no explicit user-data-dir/);
  assert.match(decideBrowserAutomationCleanup(chromeInput({ command: BROKER })).reason, /broker profile/);
});

function daemonInput(overrides: Partial<BrowserAutomationCleanupInput> = {}): BrowserAutomationCleanupInput {
  return {
    ...chromeInput(),
    kind: "agent-browser-daemon",
    command: DAEMON,
    pid: 55001,
    ppid: 1,
    ...overrides,
  };
}

test("agent-browser daemon decision spares live socket, live workflow ancestor, untrusted state, and young process", () => {
  assert.equal(decideBrowserAutomationCleanup(daemonInput()).action, "kill");
  assert.match(decideBrowserAutomationCleanup(daemonInput({ sessionSocketAlive: true })).reason, /live session socket/);
  assert.match(decideBrowserAutomationCleanup(daemonInput({ ppid: 123, liveAncestor: true })).reason, /live workflow ancestor/);
  assert.match(decideBrowserAutomationCleanup(daemonInput({ socketStateTrusted: false })).reason, /socket state untrusted/);
  assert.match(decideBrowserAutomationCleanup(daemonInput({ ageMs: GRACE - 1 })).reason, /younger than grace/);
});
