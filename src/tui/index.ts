import { config } from "../config/index.js";
import { StateManager } from "../state/manager.js";
import { QueueManager } from "../queue/manager.js";
import {
  createTuiComponents,
  updateSessions,
  updateJobs,
  updateStats,
  addLog,
} from "./components.js";
import { readFileSync, statSync } from "fs";

async function main(): Promise<void> {
  // Initialize state manager
  const stateManager = new StateManager(config.paths.database);
  const queueManager = new QueueManager(stateManager);

  // Create TUI
  const { screen, sessionsBox, jobsBox, logsBox, statsBar } = createTuiComponents();

  // Enable tags for colors (blessed types are incomplete, so cast through unknown)
  (sessionsBox as unknown as { tags: boolean }).tags = true;
  (jobsBox as unknown as { tags: boolean }).tags = true;
  (statsBar as unknown as { tags: boolean }).tags = true;
  (logsBox as unknown as { tags: boolean }).tags = true;

  // Update function
  const update = () => {
    const sessions = stateManager.getActiveSessions();
    const jobs = queueManager.getRecentJobs(20);
    const jobStats = queueManager.getStats();

    updateSessions(sessionsBox, sessions, (lane) => stateManager.getClaudeSessionId(lane));
    updateJobs(jobsBox, jobs);
    updateStats(statsBar, sessions.length, jobStats);

    screen.render();
  };

  // Log watching
  const logPath = `${config.paths.logs}/stdout.log`;
  let lastLogSize = 0;

  const checkLogs = () => {
    try {
      const stat = statSync(logPath);
      if (stat.size > lastLogSize) {
        const content = readFileSync(logPath, "utf-8");
        const newContent = content.slice(lastLogSize);
        const lines = newContent.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          addLog(logsBox, line);
        }
        lastLogSize = stat.size;
        screen.render();
      }
    } catch {
      // Log file might not exist yet
    }
  };

  // Initial update
  update();

  // Load existing logs
  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim()).slice(-50);
    for (const line of lines) {
      addLog(logsBox, line);
    }
    lastLogSize = statSync(logPath).size;
  } catch {
    // Log file might not exist yet
  }

  screen.render();

  // Periodic updates
  setInterval(update, config.tui.refreshMs);
  setInterval(checkLogs, 500);

  // Handle resize
  screen.on("resize", () => {
    screen.render();
  });
}

main().catch((error) => {
  console.error("TUI Error:", error);
  process.exit(1);
});
