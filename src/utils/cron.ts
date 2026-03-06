import { Cron } from "croner";

/**
 * Unified cron utility for HOMER
 * Uses croner as the underlying engine (replaces cron-parser)
 */
export const CronUtils = {
  /**
   * Validates a cron expression.
   * Supports 5-part (minute-based) and 6-part (second-based) expressions.
   */
  isValid(cron: string): boolean {
    if (!cron) return false;
    try {
      new Cron(cron, { paused: true });
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Gets the next run time for a cron expression.
   * @param cron The cron expression
   * @param fromDate The starting date for calculation (defaults to now)
   * @returns Date object or null if expression is invalid
   */
  getNextRun(cron: string, fromDate: Date = new Date()): Date | null {
    try {
      const job = new Cron(cron, { paused: true });
      return job.nextRun(fromDate);
    } catch {
      return null;
    }
  },

  /**
   * Gets multiple upcoming run times for a cron expression.
   * @param cron The cron expression
   * @param count Number of runs to return
   * @param fromDate The starting date for calculation (defaults to now)
   * @returns Array of Date objects
   */
  getNextRuns(cron: string, count: number, fromDate: Date = new Date()): Date[] {
    try {
      const job = new Cron(cron, { paused: true });
      return job.nextRuns(count, fromDate);
    } catch {
      return [];
    }
  },

  /**
   * Gets all runs between two dates for a cron expression.
   * @param cron The cron expression
   * @param start Start date
   * @param end End date
   * @param maxResults Maximum number of runs to return (safety limit)
   */
  getRunsBetween(cron: string, start: Date, end: Date, maxResults: number = 1000): Date[] {
    const runs: Date[] = [];
    try {
      const job = new Cron(cron, { paused: true });
      let next = job.nextRun(start);
      while (next && next <= end && runs.length < maxResults) {
        runs.push(next);
        // Advance 1ms past the current match to get the next one
        next = job.nextRun(new Date(next.getTime() + 1));
      }
    } catch {
      // Return whatever we managed to calculate
    }
    return runs;
  },

  /**
   * Converts a cron expression to a human-readable string.
   * Provides a more descriptive version than the basic implementation.
   */
  toHuman(cron: string): string {
    const parts = cron.trim().split(/\s+/);

    // Handle macros
    if (cron.startsWith("@")) {
      switch (cron.toLowerCase()) {
        case "@yearly":
        case "@annually":
          return "Once a year";
        case "@monthly":
          return "Once a month";
        case "@weekly":
          return "Once a week";
        case "@daily":
        case "@midnight":
          return "Daily at midnight";
        case "@hourly":
          return "Every hour";
        default:
          return cron;
      }
    }

    if (parts.length < 5 || parts.length > 6) return cron;

    const hasSeconds = parts.length === 6;
    const second = hasSeconds ? parts[0] : "0";
    const [minute, hour, dayOfMonth, month, dayOfWeek] = hasSeconds ? parts.slice(1) : parts;

    // Simple patterns
    if (second === "0" && minute === "0" && hour === "*") return "Every hour";
    if (second === "0" && minute === "*" && hour === "*") return "Every minute";

    // Interval patterns
    if (minute?.startsWith("*/")) {
      const mins = minute.slice(2);
      if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        return `Every ${mins} minutes`;
      }
    }

    if (hour?.startsWith("*/")) {
      const hrs = hour.slice(2);
      if (minute === "0" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
        return `Every ${hrs} hours`;
      }
    }

    // Daily at specific time
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      try {
        const h = parseInt(hour ?? "0", 10);
        const m = parseInt(minute ?? "0", 10);
        if (!isNaN(h) && !isNaN(m)) {
          const time = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
          return `Daily at ${time}`;
        }
      } catch {
        // Fall back to raw cron
      }
    }

    // Weekly patterns
    if (dayOfWeek && dayOfWeek !== "*" && dayOfMonth === "*" && month === "*") {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      try {
        // Handle comma-separated days
        const dayParts = dayOfWeek.split(",");
        const dayNames = dayParts.map(d => {
          const dayNum = parseInt(d, 10);
          return !isNaN(dayNum) ? days[dayNum % 7] : d;
        });

        const h = parseInt(hour ?? "0", 10);
        const m = parseInt(minute ?? "0", 10);
        const time = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;

        if (dayNames.length === 1) {
          return `Every ${dayNames[0]} at ${time}`;
        } else if (dayNames.length === 2) {
          return `Every ${dayNames[0]} and ${dayNames[1]} at ${time}`;
        } else if (dayOfWeek === "1-5") {
          return `Every weekday at ${time}`;
        } else if (dayOfWeek === "0,6" || dayOfWeek === "6,0") {
          return `Every weekend at ${time}`;
        } else {
          return `Weekly (${dayNames.join(", ")}) at ${time}`;
        }
      } catch {
        // Fall back
      }
    }

    // Monthly pattern
    if (dayOfMonth !== "*" && month === "*" && dayOfWeek === "*") {
      try {
        const h = parseInt(hour ?? "0", 10);
        const m = parseInt(minute ?? "0", 10);
        const time = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
        return `Monthly on the ${dayOfMonth}${CronUtils.getOrdinal(parseInt(dayOfMonth ?? "1", 10))} at ${time}`;
      } catch {
        // Fall back
      }
    }

    return cron;
  },

  /**
   * Internal helper for ordinal suffixes
   */
  getOrdinal(n: number): string {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0] || "";
  }
};
