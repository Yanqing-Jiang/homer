/**
 * Rate limiter for job-hunt actions — per-action limits with DB-backed tracking.
 */

import type Database from "better-sqlite3";

interface RateLimit {
  max: number;
  windowHours: number;
}

const LIMITS: Record<string, RateLimit> = {
  linkedin_search: { max: 50, windowHours: 1 },
  linkedin_easy_apply: { max: 10, windowHours: 24 },
  career_site_login: { max: 3, windowHours: 1 },
  career_site_apply: { max: 5, windowHours: 24 },
  gmail_send: { max: 20, windowHours: 24 },
  gmail_check: { max: 48, windowHours: 24 },
};

export class RateLimiter {
  constructor(private db: Database.Database) {}

  async checkLimit(action: string, site?: string): Promise<{ allowed: boolean; retryAfter?: number }> {
    // Clean up old entries (> 7 days)
    this.db.prepare("DELETE FROM rate_limit_log WHERE datetime(timestamp) < datetime('now', '-7 days')").run();

    const limit = LIMITS[action];
    if (!limit) return { allowed: true };

    const usage = this.getUsage(action, limit.windowHours, site);
    if (usage >= limit.max) {
      // Calculate retry time
      const oldest = this.db.prepare(`
        SELECT MIN(timestamp) as t FROM rate_limit_log
        WHERE action = ? AND (? IS NULL OR site = ?)
          AND datetime(timestamp) > datetime('now', '-' || ? || ' hours')
      `).get(action, site ?? null, site ?? null, limit.windowHours) as { t: string } | undefined;

      const retryAfter = oldest?.t
        ? new Date(oldest.t).getTime() + limit.windowHours * 3600000 - Date.now()
        : limit.windowHours * 3600000;

      return { allowed: false, retryAfter: Math.max(0, retryAfter) };
    }

    return { allowed: true };
  }

  async recordAction(action: string, site?: string): Promise<void> {
    this.db.prepare(`
      INSERT INTO rate_limit_log (action, site, timestamp) VALUES (?, ?, datetime('now'))
    `).run(action, site ?? null);
  }

  getUsage(action: string, windowHours: number, site?: string): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as c FROM rate_limit_log
      WHERE action = ? AND (? IS NULL OR site = ?)
        AND datetime(timestamp) > datetime('now', '-' || ? || ' hours')
    `).get(action, site ?? null, site ?? null, windowHours) as { c: number };
    return result.c;
  }
}
