import { logger } from "../utils/logger.js";
import { spawn } from "child_process";
import { createWriteStream } from "fs";
import type { Bot } from "grammy";

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const INVESTIGATE_AFTER_FAILURES = 3;
const HEALTH_ENDPOINTS = [
  { name: "Telegram", url: "https://api.telegram.org", timeout: 10000 },
  { name: "Anthropic", url: "https://api.anthropic.com", timeout: 10000 },
  { name: "OpenAI", url: "https://api.openai.com", timeout: 10000 },
];

interface HealthStatus {
  name: string;
  healthy: boolean;
  latencyMs?: number;
  error?: string;
  checkedAt: Date;
}

interface ConnectivityMonitorOptions {
  bot?: Bot;
  chatId?: number;
  alertOnFailure?: boolean;
  checkIntervalMs?: number;
}

export class ConnectivityMonitor {
  private intervalId: NodeJS.Timeout | null = null;
  private bot?: Bot;
  private chatId?: number;
  private alertOnFailure: boolean;
  private checkIntervalMs: number;
  private consecutiveFailures: Map<string, number> = new Map();
  private lastStatus: Map<string, HealthStatus> = new Map();
  private investigationTriggered: Map<string, boolean> = new Map();

  constructor(options: ConnectivityMonitorOptions = {}) {
    this.bot = options.bot;
    this.chatId = options.chatId;
    this.alertOnFailure = options.alertOnFailure ?? true;
    this.checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
  }

  /**
   * Trigger Claude Code investigation for connectivity issues
   */
  private async triggerInvestigation(endpoint: string, status: HealthStatus, failures: number): Promise<void> {
    if (this.investigationTriggered.get(endpoint)) return;
    this.investigationTriggered.set(endpoint, true);

    logger.warn({ endpoint, failures }, "Triggering Claude Code investigation for connectivity issue");

    // Notify via Telegram
    if (this.bot && this.chatId) {
      try {
        await this.bot.api.sendMessage(
          this.chatId,
          `🔍 *Connectivity Investigation*\n\n` +
          `Endpoint: ${endpoint}\n` +
          `Failures: ${failures} consecutive\n` +
          `Error: ${status.error || "Unknown"}\n\n` +
          `Triggering Claude Code + codex to investigate...`,
          { parse_mode: "Markdown" }
        );
      } catch {
        // Ignore send errors
      }
    }

    const prompt = `Homer connectivity monitor detected ${failures} consecutive failures for ${endpoint}.

Error: ${status.error || "Unknown"}
URL: ${HEALTH_ENDPOINTS.find(e => e.name === endpoint)?.url || "Unknown"}
Time: ${status.checkedAt.toISOString()}

Use codex subagent to analyze and diagnose this connectivity issue.

Steps:
1. Check if it's a network issue (DNS, routing, firewall)
2. Check if it's an API issue (endpoint down, rate limited)
3. Check Homer's network configuration
4. Run diagnostic commands (ping, curl, traceroute)

If no clear root cause is found, use gemini agent to research:
- Current status of ${endpoint} API
- Known outages or issues
- Alternative endpoints or workarounds

Report findings and any fixes applied.`;

    try {
      const claude = spawn("/Users/yj/.claude/local/claude", [
        "--dangerously-skip-permissions",
        "-p",
        prompt
      ], {
        cwd: "/Users/yj/homer",
        detached: true,
        stdio: ["ignore", "pipe", "pipe"]
      });

      const logStream = createWriteStream("/Users/yj/Library/Logs/homer/investigation.log", { flags: "a" });
      logStream.write(`\n\n=== Connectivity Investigation: ${endpoint} - ${new Date().toISOString()} ===\n`);
      claude.stdout?.pipe(logStream);
      claude.stderr?.pipe(logStream);

      claude.unref();
      logger.info({ endpoint }, "Claude Code investigation started for connectivity issue");
    } catch (err) {
      logger.error({ error: err, endpoint }, "Failed to start Claude Code investigation");
    }
  }

  /**
   * Check a single endpoint's health
   */
  private async checkEndpoint(endpoint: { name: string; url: string; timeout: number }): Promise<HealthStatus> {
    const startTime = Date.now();
    const checkedAt = new Date();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), endpoint.timeout);

      const response = await fetch(endpoint.url, {
        method: "HEAD",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const latencyMs = Date.now() - startTime;
      const healthy = response.status < 500;

      return {
        name: endpoint.name,
        healthy,
        latencyMs,
        checkedAt,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        name: endpoint.name,
        healthy: false,
        error: errorMessage,
        checkedAt,
      };
    }
  }

  /**
   * Check all endpoints
   */
  async checkAll(): Promise<HealthStatus[]> {
    const results: HealthStatus[] = [];

    for (const endpoint of HEALTH_ENDPOINTS) {
      const status = await this.checkEndpoint(endpoint);
      results.push(status);
      this.lastStatus.set(endpoint.name, status);

      // Track consecutive failures
      if (!status.healthy) {
        const failures = (this.consecutiveFailures.get(endpoint.name) || 0) + 1;
        this.consecutiveFailures.set(endpoint.name, failures);

        logger.warn(
          {
            endpoint: endpoint.name,
            error: status.error,
            consecutiveFailures: failures,
          },
          "Connectivity check failed"
        );

        // Alert after 2 consecutive failures
        if (failures === 2 && this.alertOnFailure) {
          await this.sendAlert(endpoint.name, status);
        }

        // Trigger Claude Code investigation after 3 consecutive failures
        if (failures === INVESTIGATE_AFTER_FAILURES) {
          await this.triggerInvestigation(endpoint.name, status, failures);
        }
      } else {
        const previousFailures = this.consecutiveFailures.get(endpoint.name) || 0;
        this.consecutiveFailures.set(endpoint.name, 0);
        // Reset investigation flag on recovery
        this.investigationTriggered.set(endpoint.name, false);

        // Alert recovery if was previously failing
        if (previousFailures >= 2 && this.alertOnFailure) {
          await this.sendRecoveryAlert(endpoint.name, status);
        }
      }
    }

    return results;
  }

  /**
   * Send alert to Telegram
   */
  private async sendAlert(name: string, status: HealthStatus): Promise<void> {
    if (!this.bot || !this.chatId) return;

    const message = `⚠️ *Connectivity Alert*\n\n` +
      `Endpoint: ${name}\n` +
      `Status: Unreachable\n` +
      `Error: ${status.error || "Unknown"}\n` +
      `Time: ${status.checkedAt.toISOString()}`;

    try {
      await this.bot.api.sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
      });
    } catch (error) {
      logger.error({ error }, "Failed to send connectivity alert");
    }
  }

  /**
   * Send recovery alert to Telegram
   */
  private async sendRecoveryAlert(name: string, status: HealthStatus): Promise<void> {
    if (!this.bot || !this.chatId) return;

    const message = `✅ *Connectivity Restored*\n\n` +
      `Endpoint: ${name}\n` +
      `Latency: ${status.latencyMs}ms\n` +
      `Time: ${status.checkedAt.toISOString()}`;

    try {
      await this.bot.api.sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
      });
    } catch (error) {
      logger.error({ error }, "Failed to send recovery alert");
    }
  }

  /**
   * Start periodic monitoring
   */
  start(): void {
    if (this.intervalId) {
      logger.warn("Connectivity monitor already running");
      return;
    }

    logger.info(
      { intervalMs: this.checkIntervalMs },
      "Starting connectivity monitor"
    );

    // Run initial check
    this.checkAll().catch((err) => {
      logger.error({ error: err }, "Initial connectivity check failed");
    });

    // Schedule periodic checks
    this.intervalId = setInterval(async () => {
      try {
        await this.checkAll();
      } catch (error) {
        logger.error({ error }, "Connectivity check cycle failed");
      }
    }, this.checkIntervalMs);
  }

  /**
   * Stop periodic monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info("Connectivity monitor stopped");
    }
  }

  /**
   * Get current status of all endpoints
   */
  getStatus(): Map<string, HealthStatus> {
    return new Map(this.lastStatus);
  }

  /**
   * Get formatted status string
   */
  getStatusSummary(): string {
    if (this.lastStatus.size === 0) {
      return "No connectivity data available";
    }

    let summary = "🔗 Connectivity Status:\n";
    for (const [name, status] of this.lastStatus) {
      const icon = status.healthy ? "✅" : "❌";
      const latency = status.latencyMs ? ` (${status.latencyMs}ms)` : "";
      const error = status.error ? ` - ${status.error}` : "";
      summary += `${icon} ${name}${latency}${error}\n`;
    }
    return summary;
  }
}

// Singleton instance for global access
let monitorInstance: ConnectivityMonitor | null = null;

export function getConnectivityMonitor(): ConnectivityMonitor | null {
  return monitorInstance;
}

export function initConnectivityMonitor(options: ConnectivityMonitorOptions): ConnectivityMonitor {
  if (monitorInstance) {
    monitorInstance.stop();
  }
  monitorInstance = new ConnectivityMonitor(options);
  return monitorInstance;
}
