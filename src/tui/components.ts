import blessed from "blessed";
// @ts-ignore
import type { Widgets } from "blessed";
import { spawn } from "child_process";
import type { Session } from "../state/manager.js";
import type { Job } from "../state/manager.js";

export interface TuiComponents {
  screen: any;
  sessionsBox: any;
  jobsBox: any;
  logsBox: any;
  statsBar: any;
}

// OpenCode Dark Theme Palette
const OPENCODE = {
  primary: "#fab283",   // Warm Coral / Peach
  accent: "#9d7cd8",    // Lavender / Purple
  secondary: "#5c9cf5", // Soft Blue
  green: "#7fd88f",     // Mint / Green
  yellow: "#e5c07b",    // Amber / Yellow
  red: "#e06c75",       // Coral Red
  cyan: "#56b6c2",      // Cyan / Teal
  gray: "#808080",      // Muted Gray
  fg: "#eeeeee",        // Foreground
  bgBase: "#0a0a0a",    // Dark Base Background
  bgSurface: "#141414", // Surface Background
  trackBg: "#1e1e1e",   // Scrollbar Track
};

const LANE_COLORS: Record<string, string> = {
  work: OPENCODE.secondary,
  invest: OPENCODE.green,
  personal: OPENCODE.accent,
  learning: OPENCODE.yellow,
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
      border: { fg: OPENCODE.primary },
      fg: OPENCODE.fg,
      bg: OPENCODE.bgSurface,
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
      track: { bg: OPENCODE.trackBg },
      style: { bg: OPENCODE.primary },
    },
    style: {
      border: { fg: OPENCODE.green },
      label: { fg: OPENCODE.green, bold: true },
      bg: OPENCODE.bgBase,
      fg: OPENCODE.fg,
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
      track: { bg: OPENCODE.trackBg },
      style: { bg: OPENCODE.primary },
    },
    style: {
      border: { fg: OPENCODE.yellow },
      label: { fg: OPENCODE.yellow, bold: true },
      bg: OPENCODE.bgBase,
      fg: OPENCODE.fg,
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
      track: { bg: OPENCODE.trackBg },
      style: { bg: OPENCODE.primary },
    },
    style: {
      border: { fg: OPENCODE.accent },
      label: { fg: OPENCODE.accent, bold: true },
      bg: OPENCODE.bgBase,
      fg: OPENCODE.fg,
    },
  });

  // Quit handlers
  screen.key(["escape", "q", "C-c"], () => {
    process.exit(0);
  });

  return { screen, sessionsBox, jobsBox, logsBox, statsBar };
}

export function updateSessions(
  box: any,
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
    const color = LANE_COLORS[s.lane] || OPENCODE.fg;
    const claudeStr = claudeId ? `{${OPENCODE.gray}-fg}[${claudeId.slice(0, 8)}]{/${OPENCODE.gray}-fg}` : "";
    return ` {${color}-fg}${s.lane.padEnd(10)}{/${color}-fg} ${String(age).padStart(3)}m  ${String(s.messageCount).padStart(3)} msgs  ${claudeStr}`;
  });

  box.setContent(lines.join("\n"));
}

export function updateJobs(box: any, jobs: Job[]): void {
  if (jobs.length === 0) {
    box.setContent(" No jobs");
    return;
  }

  const statusColors: Record<string, string> = {
    pending: OPENCODE.yellow,
    running: OPENCODE.secondary,
    completed: OPENCODE.green,
    failed: OPENCODE.red,
  };

  const lines = jobs.slice(0, 20).map((j) => {
    const age = j.createdAt ? Math.round((Date.now() - j.createdAt) / 1000 / 60) : 0;
    const queryPreview = j.query.slice(0, 20) + (j.query.length > 20 ? ".." : "");
    const color = statusColors[j.status] || OPENCODE.fg;
    const laneColor = LANE_COLORS[j.lane] || OPENCODE.fg;
    return ` {${color}-fg}${j.status.padEnd(10)}{/${color}-fg} {${laneColor}-fg}${j.lane.padEnd(10)}{/${laneColor}-fg} ${String(age).padStart(3)}m  ${queryPreview}`;
  });

  box.setContent(lines.join("\n"));
}

export function updateStats(
  bar: any,
  activeSessions: number,
  jobStats: { pending: number; running: number; completed: number; failed: number }
): void {
  const uptimeMinutes = Math.round(process.uptime() / 60);
  const mem = process.memoryUsage();
  const memMb = Math.round(mem.heapUsed / 1024 / 1024);

  bar.setContent(
    ` H.O.M.E.R | ` +
      `Sessions: {${OPENCODE.green}-fg}${activeSessions}{/${OPENCODE.green}-fg} | ` +
      `Pending: {${OPENCODE.yellow}-fg}${jobStats.pending}{/${OPENCODE.yellow}-fg} | ` +
      `Running: {${OPENCODE.secondary}-fg}${jobStats.running}{/${OPENCODE.secondary}-fg} | ` +
      `Done: {${OPENCODE.green}-fg}${jobStats.completed}{/${OPENCODE.green}-fg} | ` +
      `Failed: {${OPENCODE.red}-fg}${jobStats.failed}{/${OPENCODE.red}-fg} | ` +
      `Uptime: ${uptimeMinutes}m | ` +
      `Mem: ${memMb}MB | ` +
      `{${OPENCODE.gray}-fg}drag to copy | q to quit{/${OPENCODE.gray}-fg}`
  );
}

function copyToClipboard(text: string): void {
  const proc = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
  proc.on("error", () => {});
  proc.stdin.write(text);
  proc.stdin.end();
}

// Strip SGR escape sequences left behind by blessed's tag parsing.
function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[\d;]*m/g, "");
}

export interface SelectionHandle {
  isSelecting: () => boolean;
}

// Drag over a panel to select whole lines; on release the text lands in the
// macOS clipboard. Terminal-native selection is unreliable here because the
// TUI repaints every 500ms-1s, which clears the selection before Cmd+C.
// (Option+drag still gives raw terminal selection if ever needed.)
export function enableSelectionCopy(components: TuiComponents): SelectionHandle {
  const { screen, sessionsBox, jobsBox, logsBox, statsBar } = components;
  const panels = [sessionsBox, jobsBox, logsBox];

  let activeBox: any = null;
  let anchorY = 0;
  let lastY = 0;
  let moved = false;
  let overlay: any = null;
  let flashTimer: NodeJS.Timeout | null = null;

  const contentTop = (box: any) => box.atop + box.itop;
  const contentBottom = (box: any) => box.atop + box.height - box.ibottom - 1;
  const inContent = (box: any, x: number, y: number) =>
    x >= box.aleft + box.ileft &&
    x <= box.aleft + box.width - box.iright - 1 &&
    y >= contentTop(box) &&
    y <= contentBottom(box);

  const clamp = (y: number) =>
    Math.max(contentTop(activeBox), Math.min(contentBottom(activeBox), y));

  const redrawOverlay = () => {
    const y1 = Math.min(anchorY, lastY);
    const y2 = Math.max(anchorY, lastY);
    overlay.top = y1;
    overlay.height = y2 - y1 + 1;
    screen.render();
  };

  const clearOverlay = () => {
    if (overlay) {
      overlay.destroy();
      overlay = null;
    }
  };

  const flash = (msg: string) => {
    if (flashTimer) clearTimeout(flashTimer);
    const prev = statsBar.getContent();
    statsBar.setContent(`${prev}  {${OPENCODE.green}-fg}✓ ${msg}{/${OPENCODE.green}-fg}`);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      statsBar.setContent(prev);
      screen.render();
    }, 2000);
  };

  const selectedText = (): string => {
    const lines: string[] = activeBox._clines || [];
    const base = activeBox.childBase | 0;
    const start = base + Math.min(anchorY, lastY) - contentTop(activeBox);
    const end = base + Math.max(anchorY, lastY) - contentTop(activeBox);
    return lines
      .slice(start, end + 1)
      .map((l) => stripAnsi(l).trimEnd())
      .join("\n");
  };

  screen.on("mouse", (data: any) => {
    if (data.action === "wheelup" || data.action === "wheeldown") {
      // Mouse capture swallows terminal wheel behavior, so scroll panels ourselves.
      const box = panels.find((b) => inContent(b, data.x, data.y));
      if (box) {
        box.scroll(data.action === "wheelup" ? -2 : 2);
        screen.render();
      }
      return;
    }

    if (data.action === "mousedown" && !activeBox) {
      const box = panels.find((b) => inContent(b, data.x, data.y));
      if (!box) return;
      activeBox = box;
      anchorY = data.y;
      lastY = data.y;
      moved = false;
      overlay = blessed.box({
        parent: screen,
        left: box.aleft + box.ileft,
        width: box.width - box.ileft - box.iright,
        top: anchorY,
        height: 1,
        transparent: true,
        style: { bg: OPENCODE.secondary },
      });
      overlay.setFront();
      screen.render();
      return;
    }

    if (!activeBox) return;

    if (data.action === "mousemove") {
      moved = true;
      const y = clamp(data.y);
      if (y !== lastY) {
        lastY = y;
        redrawOverlay();
      }
      return;
    }

    if (data.action === "mouseup") {
      lastY = clamp(data.y);
      const text = selectedText();
      clearOverlay();
      if (moved && text.trim()) {
        copyToClipboard(text);
        flash(`Copied ${text.split("\n").length} lines`);
      }
      activeBox = null;
      screen.render();
    }
  });

  return { isSelecting: () => activeBox !== null };
}

export function addLog(box: any, entry: string): void {
  // Parse JSON log if possible
  try {
    const parsed = JSON.parse(entry);
    const level = parsed.level || 30;
    const msg = parsed.msg || "";
    const levelColors: Record<number, string> = {
      10: "#606060",        // trace
      20: OPENCODE.cyan,    // debug
      30: OPENCODE.fg,      // info
      40: OPENCODE.yellow,  // warn
      50: OPENCODE.red,     // error
      60: OPENCODE.red,     // fatal
    };
    const color = levelColors[level] || OPENCODE.fg;
    box.log(`{${color}-fg}${msg}{/${color}-fg}`);
  } catch {
    box.log(entry);
  }
}
