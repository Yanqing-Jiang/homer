import blessed from "blessed";
import type { Widgets } from "blessed";
import type { Session } from "../state/manager.js";
import type { Job } from "../state/manager.js";

export interface TuiComponents {
  screen: Widgets.Screen;
  sessionsBox: Widgets.BoxElement;
  jobsBox: Widgets.BoxElement;
  logsBox: Widgets.Log;
  statsBar: Widgets.BoxElement;
}

const LANE_COLORS: Record<string, string> = {
  work: "blue",
  invest: "green",
  personal: "magenta",
  learning: "yellow",
};

export function createTuiComponents(): TuiComponents {
  // Create screen
  const screen = blessed.screen({
    smartCSR: true,
    title: "H.O.M.E.R Dashboard",
    fullUnicode: true,
  });

  // Stats bar at top
  const statsBar = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    content: " H.O.M.E.R - Loading...",
    border: { type: "line" },
    style: {
      border: { fg: "cyan" },
      fg: "white",
    },
  });

  // Sessions panel (top left)
  const sessionsBox = blessed.box({
    parent: screen,
    label: " Sessions ",
    top: 3,
    left: 0,
    width: "50%",
    height: "40%",
    border: { type: "line" },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: " ",
      track: { bg: "gray" },
      style: { bg: "white" },
    },
    style: {
      border: { fg: "green" },
      label: { fg: "green", bold: true },
    },
  });

  // Jobs panel (top right)
  const jobsBox = blessed.box({
    parent: screen,
    label: " Jobs ",
    top: 3,
    left: "50%",
    width: "50%",
    height: "40%",
    border: { type: "line" },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: " ",
      track: { bg: "gray" },
      style: { bg: "white" },
    },
    style: {
      border: { fg: "yellow" },
      label: { fg: "yellow", bold: true },
    },
  });

  // Logs panel (bottom)
  const logsBox = blessed.log({
    parent: screen,
    label: " Logs ",
    top: "43%",
    left: 0,
    width: "100%",
    height: "57%",
    border: { type: "line" },
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: " ",
      track: { bg: "gray" },
      style: { bg: "white" },
    },
    style: {
      border: { fg: "blue" },
      label: { fg: "blue", bold: true },
    },
  });

  // Quit handlers
  screen.key(["escape", "q", "C-c"], () => {
    process.exit(0);
  });

  return { screen, sessionsBox, jobsBox, logsBox, statsBar };
}

export function updateSessions(
  box: Widgets.BoxElement,
  sessions: Session[],
  getClaudeSessionId: (lane: string) => string | null
): void {
  if (sessions.length === 0) {
    box.setContent(" No active sessions");
    return;
  }

  const lines = sessions.map((s) => {
    const age = Math.round((Date.now() - s.lastActivityAt) / 1000 / 60);
    const claudeId = getClaudeSessionId(s.lane);
    const color = LANE_COLORS[s.lane] || "white";
    const claudeStr = claudeId ? `{gray-fg}[${claudeId.slice(0, 8)}]{/gray-fg}` : "";
    return ` {${color}-fg}${s.lane.padEnd(10)}{/${color}-fg} ${String(age).padStart(3)}m  ${String(s.messageCount).padStart(3)} msgs  ${claudeStr}`;
  });

  box.setContent(lines.join("\n"));
}

export function updateJobs(box: Widgets.BoxElement, jobs: Job[]): void {
  if (jobs.length === 0) {
    box.setContent(" No jobs");
    return;
  }

  const statusColors: Record<string, string> = {
    pending: "yellow",
    running: "blue",
    completed: "green",
    failed: "red",
  };

  const lines = jobs.slice(0, 20).map((j) => {
    const age = j.createdAt ? Math.round((Date.now() - j.createdAt) / 1000 / 60) : 0;
    const queryPreview = j.query.slice(0, 20) + (j.query.length > 20 ? ".." : "");
    const color = statusColors[j.status] || "white";
    const laneColor = LANE_COLORS[j.lane] || "white";
    return ` {${color}-fg}${j.status.padEnd(10)}{/${color}-fg} {${laneColor}-fg}${j.lane.padEnd(10)}{/${laneColor}-fg} ${String(age).padStart(3)}m  ${queryPreview}`;
  });

  box.setContent(lines.join("\n"));
}

export function updateStats(
  bar: Widgets.BoxElement,
  activeSessions: number,
  jobStats: { pending: number; running: number; completed: number; failed: number }
): void {
  const uptimeMinutes = Math.round(process.uptime() / 60);
  const mem = process.memoryUsage();
  const memMb = Math.round(mem.heapUsed / 1024 / 1024);

  bar.setContent(
    ` H.O.M.E.R | ` +
      `Sessions: {green-fg}${activeSessions}{/green-fg} | ` +
      `Pending: {yellow-fg}${jobStats.pending}{/yellow-fg} | ` +
      `Running: {blue-fg}${jobStats.running}{/blue-fg} | ` +
      `Done: {green-fg}${jobStats.completed}{/green-fg} | ` +
      `Failed: {red-fg}${jobStats.failed}{/red-fg} | ` +
      `Uptime: ${uptimeMinutes}m | ` +
      `Mem: ${memMb}MB | ` +
      `{gray-fg}Press q to quit{/gray-fg}`
  );
}

export function addLog(box: Widgets.Log, entry: string): void {
  // Parse JSON log if possible
  try {
    const parsed = JSON.parse(entry);
    const level = parsed.level || 30;
    const msg = parsed.msg || "";
    const levelColors: Record<number, string> = {
      10: "gray",    // trace
      20: "cyan",    // debug
      30: "white",   // info
      40: "yellow",  // warn
      50: "red",     // error
      60: "red",     // fatal
    };
    const color = levelColors[level] || "white";
    box.log(`{${color}-fg}${msg}{/${color}-fg}`);
  } catch {
    box.log(entry);
  }
}
