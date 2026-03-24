/**
 * Circuit breaker pattern — prevents repeated failures from hammering external services.
 * States: closed (normal) → open (failing) → half-open (testing recovery).
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

export type CircuitState = "closed" | "open" | "half-open";

interface CircuitRecord {
  name: string;
  state: CircuitState;
  failure_count: number;
  last_failure: string | null;
  opened_at: string | null;
}

export class CircuitBreaker {
  constructor(
    private name: string,
    private threshold: number,
    private resetTimeMs: number,
    private db: Database.Database
  ) {
    // Ensure circuit breaker state table exists (uses rate_limit_log table for simplicity)
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS circuit_breaker_state (
        name TEXT PRIMARY KEY,
        state TEXT DEFAULT 'closed',
        failure_count INTEGER DEFAULT 0,
        last_failure TEXT,
        opened_at TEXT
      )
    `).run();

    this.db.prepare(`
      INSERT OR IGNORE INTO circuit_breaker_state (name) VALUES (?)
    `).run(this.name);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();

    if (state === "open") {
      const record = this.getRecord();
      if (record?.opened_at) {
        const elapsed = Date.now() - new Date(record.opened_at).getTime();
        if (elapsed >= this.resetTimeMs) {
          this.setState("half-open");
        } else {
          throw new Error(`Circuit ${this.name} is OPEN. Retry in ${Math.round((this.resetTimeMs - elapsed) / 1000)}s`);
        }
      }
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  getState(): CircuitState {
    const record = this.getRecord();
    return (record?.state as CircuitState) ?? "closed";
  }

  private getRecord(): CircuitRecord | undefined {
    return this.db.prepare(
      "SELECT * FROM circuit_breaker_state WHERE name = ?"
    ).get(this.name) as CircuitRecord | undefined;
  }

  private setState(state: CircuitState): void {
    this.db.prepare(`
      UPDATE circuit_breaker_state SET state = ?,
        opened_at = CASE WHEN ? = 'open' THEN datetime('now') ELSE opened_at END
      WHERE name = ?
    `).run(state, state, this.name);
  }

  private recordFailure(): void {
    const record = this.getRecord();
    const newCount = (record?.failure_count ?? 0) + 1;

    this.db.prepare(`
      UPDATE circuit_breaker_state SET failure_count = ?, last_failure = datetime('now')
      WHERE name = ?
    `).run(newCount, this.name);

    if (newCount >= this.threshold) {
      this.setState("open");
      logger.warn({ circuit: this.name, failures: newCount, threshold: this.threshold }, "Circuit breaker OPENED");
    }
  }

  private recordSuccess(): void {
    this.db.prepare(`
      UPDATE circuit_breaker_state SET state = 'closed', failure_count = 0 WHERE name = ?
    `).run(this.name);
  }
}

// Pre-configured circuit breakers
export function createLinkedInBreaker(db: Database.Database): CircuitBreaker {
  return new CircuitBreaker("linkedin_scraping", 3, 3600000, db); // 3 failures, 1h reset
}

export function createCareerSiteBreaker(db: Database.Database, site: string): CircuitBreaker {
  return new CircuitBreaker(`career_site_${site}`, 2, 21600000, db); // 2 failures, 6h reset
}

export function createGmailBreaker(db: Database.Database): CircuitBreaker {
  return new CircuitBreaker("gmail_api", 5, 900000, db); // 5 failures, 15m reset
}
