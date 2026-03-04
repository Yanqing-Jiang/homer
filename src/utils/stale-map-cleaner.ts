/**
 * StaleMapCleaner — Shared singleton that periodically cleans stale entries
 * from registered Maps. Replaces per-module setInterval antipatterns with
 * a single timer that has proper lifecycle control (start/stop).
 *
 * Default: 30-minute interval, 1-hour TTL per entry.
 */

import { logger } from "./logger.js";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

interface RegisteredMap {
  map: Map<unknown, { createdAt?: number; displayedAt?: number }>;
  label: string;
  maxAgeMs: number;
  timestampKey: "createdAt" | "displayedAt";
}

class StaleMapCleanerImpl {
  private maps: RegisteredMap[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;

  constructor(intervalMs: number = DEFAULT_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  /**
   * Register a Map for periodic cleanup.
   * The Map's values must have a `createdAt` or `displayedAt` number field (epoch ms).
   * Auto-starts on first registration.
   */
  register(
    map: Map<unknown, unknown>,
    label: string,
    options?: {
      maxAgeMs?: number;
      timestampKey?: "createdAt" | "displayedAt";
    }
  ): void {
    this.maps.push({
      map: map as RegisteredMap["map"],
      label,
      maxAgeMs: options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
      timestampKey: options?.timestampKey ?? "createdAt",
    });

    // Auto-start on first registration
    if (!this.timer) {
      this.start();
    }
  }

  /**
   * Start the cleanup timer.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.clean(), this.intervalMs);
    logger.debug(
      { intervalMs: this.intervalMs, mapCount: this.maps.length },
      "StaleMapCleaner started"
    );
  }

  /**
   * Stop the cleanup timer and run a final cleanup pass.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.debug("StaleMapCleaner stopped");
  }

  /**
   * Run a single cleanup pass across all registered Maps.
   */
  private clean(): void {
    const now = Date.now();
    let totalCleaned = 0;

    for (const reg of this.maps) {
      const cutoff = now - reg.maxAgeMs;
      let cleaned = 0;

      for (const [key, value] of reg.map.entries()) {
        const ts = value?.[reg.timestampKey];
        if (typeof ts === "number" && ts < cutoff) {
          reg.map.delete(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.debug({ label: reg.label, cleaned, remaining: reg.map.size }, "Stale entries cleaned");
        totalCleaned += cleaned;
      }
    }

    if (totalCleaned > 0) {
      logger.debug({ totalCleaned, maps: this.maps.length }, "StaleMapCleaner pass complete");
    }
  }
}

// Singleton
export const staleMapCleaner = new StaleMapCleanerImpl();
