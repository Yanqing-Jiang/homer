import { logger } from "../utils/logger.js";
import { investigate } from "../process/fallback-chain.js";
import type { Bot } from "grammy";

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const INVESTIGATE_AFTER_FAILURES = 3;
const HEALTH_ENDPOINTS = [
  // Telegram checked via bot.api.getMe() — see checkTelegram()
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

    investigate({
      trigger: "connectivity",
      description: `${failures} consecutive failures for ${endpoint}`,
      errorDetails: status.error,
    }).catch((err) => {
      logger.error({ error: err, endpoint }, "Investigation failed");
    });
    logger.info({ endpoint }, "Investigation started for connectivity issue");
  }

  /**
   * Check Telegram via bot.api.getMe() — reliable authenticated check
   */
  private async checkTelegram(): Promise<HealthStatus> {
    const startTime = Date.now();
    const checkedAt = new Date();

    if (!this.bot) {
      return { name: "Telegram", healthy: false, error: "Bot not configured", checkedAt };
    }

    // grammy bot.api.getMe() inherits its fetch retry config from the bot's
    // global apiConfig; without an explicit AbortSignal a transient hiccup at
    // api.telegram.org can hang past the connectivity check's hourly cadence
    // and trip a false alarm. Bound it to 8s — well under the alert threshold.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      // Cast: grammy types use the abort-controller polyfill's AbortSignal,
      // which is structurally compatible with the native one at runtime.
      await this.bot.api.getMe(controller.signal as unknown as Parameters<typeof this.bot.api.getMe>[0]);
      return { name: "Telegram", healthy: true, latencyMs: Date.now() - startTime, checkedAt };
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      return {
        name: "Telegram",
        healthy: false,
        error: isAbort
          ? "getMe timed out after 8s"
          : (error instanceof Error ? error.message : "Unknown error"),
        checkedAt,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Check a single endpoint's health via HTTP
   */
  private async checkEndpoint(endpoint: { name: string; url: string; timeout: number }): Promise<HealthStatus> {
    const startTime = Date.now();
    const checkedAt = new Date();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), endpoint.timeout);

      try {
        const response = await fetch(endpoint.url, {
          method: "HEAD",
          signal: controller.signal,
        });

        const latencyMs = Date.now() - startTime;
        const healthy = response.status < 500;

        return { name: endpoint.name, healthy, latencyMs, checkedAt };
      } finally {
        clearTimeout(timeoutId);
      }
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
   * Track consecutive failures, send alerts, trigger investigation
   */
  private async trackFailures(name: string, status: HealthStatus): Promise<void> {
    if (!status.healthy) {
      const failures = (this.consecutiveFailures.get(name) || 0) + 1;
      this.consecutiveFailures.set(name, failures);

      logger.warn({ endpoint: name, error: status.error, consecutiveFailures: failures }, "Connectivity check failed");

      if (failures === 2 && this.alertOnFailure) {
        await this.sendAlert(name, status);
        try {
          const { sendEmergencySms } = await import("../telephony/emergency-sms.js");
          await sendEmergencySms(`Connectivity: ${name} unreachable (2 failures). Error: ${status.error || "Unknown"}`);
        } catch { /* best-effort */ }
      }

      if (failures === INVESTIGATE_AFTER_FAILURES) {
        await this.triggerInvestigation(name, status, failures);
      }
    } else {
      const previousFailures = this.consecutiveFailures.get(name) || 0;
      this.consecutiveFailures.set(name, 0);
      this.investigationTriggered.set(name, false);

      if (previousFailures >= 2 && this.alertOnFailure) {
        await this.sendRecoveryAlert(name, status);
      }
    }
  }

  /**
   * Check all endpoints
   */
  async checkAll(): Promise<HealthStatus[]> {
    const results: HealthStatus[] = [];

    // Telegram: use authenticated bot API instead of raw HTTP
    const telegramStatus = await this.checkTelegram();
    results.push(telegramStatus);
    this.lastStatus.set("Telegram", telegramStatus);
    await this.trackFailures("Telegram", telegramStatus);

    for (const endpoint of HEALTH_ENDPOINTS) {
      const status = await this.checkEndpoint(endpoint);
      results.push(status);
      this.lastStatus.set(endpoint.name, status);
      await this.trackFailures(endpoint.name, status);
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
