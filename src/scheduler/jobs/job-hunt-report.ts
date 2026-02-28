/**
 * Job Hunt Weekly Report — all from DB queries, no LLM needed.
 * Generates pipeline funnel, skill trends, salary analysis.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import type Database from "better-sqlite3";
import { logger } from "../../utils/logger.js";

const TRENDS_DIR = "/Users/yj/job-hunt/trends";

interface WeekStats {
  discovered: number;
  qualified: number;
  approved: number;
  applied: number;
  responded: number;
  interviews: number;
  offers: number;
  rejected: number;
}

export async function runJobHuntWeeklyReport(db: Database.Database): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    const now = new Date();

    // Generate space-separated timestamps to match discovered_at format in job_postings
    const toSpaceSep = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
    const weekAgo = toSpaceSep(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));

    // Pipeline funnel — all time
    const allTime = getPipelineStats(db);

    // This week
    const thisWeek = getWeekStats(db, weekAgo);

    // Top jobs by score this week
    const topJobs = db.prepare(`
      SELECT title, company, match_score, status
      FROM job_postings
      WHERE discovered_at >= ? AND match_score IS NOT NULL
      ORDER BY match_score DESC LIMIT 5
    `).all(weekAgo) as Array<{ title: string; company: string; match_score: number; status: string }>;

    // Skill demand (count mentions across all JDs from last 4 weeks)
    const fourWeeksAgo = toSpaceSep(new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000));
    const skillDemand = getSkillDemand(db, fourWeeksAgo);

    // Stale jobs (> 14 days, no action taken)
    const staleCount = (db.prepare(`
      SELECT COUNT(*) as c FROM job_postings
      WHERE status IN ('discovered', 'matched')
        AND datetime(discovered_at, '+14 days') < datetime('now')
    `).get() as { c: number }).c;

    // Format report
    const report = formatReport(allTime, thisWeek, topJobs, skillDemand, staleCount);

    // Write to file
    if (!existsSync(TRENDS_DIR)) mkdirSync(TRENDS_DIR, { recursive: true });
    const date = now.toISOString().slice(0, 10);
    const filePath = `${TRENDS_DIR}/weekly-${date}.md`;
    writeFileSync(filePath, report, "utf8");

    // Update job_trends table
    for (const [skill, cnt] of Object.entries(skillDemand)) {
      db.prepare(`
        INSERT OR REPLACE INTO job_trends (id, snapshot_date, skill, demand_count, trend_direction)
        VALUES (?, ?, ?, ?, 'stable')
      `).run(`trend_${skill}_${date}`, date, skill, cnt);
    }

    // Telegram summary (compact)
    const summary = formatTelegramSummary(allTime, thisWeek, topJobs, staleCount);

    logger.info({ filePath }, "Weekly report generated");
    return { success: true, output: summary };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error }, "Weekly report failed");
    return { success: false, output: "", error: msg };
  }
}

function getPipelineStats(db: Database.Database): WeekStats {
  const count = (status: string | string[]): number => {
    if (Array.isArray(status)) {
      const placeholders = status.map(() => "?").join(",");
      return (db.prepare(`SELECT COUNT(*) as c FROM job_postings WHERE status IN (${placeholders})`).get(...status) as { c: number }).c;
    }
    return (db.prepare("SELECT COUNT(*) as c FROM job_postings WHERE status = ?").get(status) as { c: number }).c;
  };

  const appCount = (status: string | string[]): number => {
    if (Array.isArray(status)) {
      const placeholders = status.map(() => "?").join(",");
      return (db.prepare(`SELECT COUNT(*) as c FROM applications WHERE status IN (${placeholders})`).get(...status) as { c: number }).c;
    }
    return (db.prepare("SELECT COUNT(*) as c FROM applications WHERE status = ?").get(status) as { c: number }).c;
  };

  return {
    discovered: (db.prepare("SELECT COUNT(*) as c FROM job_postings").get() as { c: number }).c,
    qualified: count("queued_for_approval") + count("approved") + count("applied"),
    approved: count("approved"),
    applied: appCount("application_submitted") + appCount("confirmation_received"),
    responded: appCount("phone_screen") + appCount("onsite") + appCount("rejected"),
    interviews: appCount("phone_screen") + appCount("onsite"),
    offers: appCount("offer") + appCount("negotiating") + appCount("accepted"),
    rejected: count("rejected"),
  };
}

function getWeekStats(db: Database.Database, since: string): WeekStats {
  const jCount = (status: string): number =>
    (db.prepare("SELECT COUNT(*) as c FROM job_postings WHERE status = ? AND discovered_at >= ?").get(status, since) as { c: number }).c;

  return {
    discovered: (db.prepare("SELECT COUNT(*) as c FROM job_postings WHERE discovered_at >= ?").get(since) as { c: number }).c,
    qualified: jCount("queued_for_approval"),
    approved: jCount("approved"),
    applied: 0, // Would need applications.created_at
    responded: 0,
    interviews: 0,
    offers: 0,
    rejected: jCount("rejected"),
  };
}

function getSkillDemand(db: Database.Database, since: string): Record<string, number> {
  const descriptions = db.prepare(
    "SELECT description FROM job_postings WHERE discovered_at >= ? AND description IS NOT NULL"
  ).all(since) as Array<{ description: string }>;

  const skills: Record<string, number> = {};
  const keywords: Record<string, string[]> = {
    Python: ["python"],
    SQL: ["sql", "postgresql", "mysql"],
    Spark: ["spark", "pyspark", "databricks"],
    "Machine Learning": ["machine learning", "ml "],
    Docker: ["docker", "kubernetes", "k8s"],
    AWS: ["aws", "amazon web services"],
    Azure: ["azure"],
    GCP: ["gcp", "google cloud"],
    TensorFlow: ["tensorflow", "pytorch"],
    NLP: ["nlp", "natural language"],
    LLM: ["llm", "large language model", "generative ai"],
    dbt: ["dbt"],
    Airflow: ["airflow"],
    Kafka: ["kafka"],
  };

  for (const row of descriptions) {
    const text = row.description.toLowerCase();
    for (const [skill, kws] of Object.entries(keywords)) {
      if (kws.some((kw) => text.includes(kw))) {
        skills[skill] = (skills[skill] ?? 0) + 1;
      }
    }
  }

  return Object.fromEntries(
    Object.entries(skills).sort(([, a], [, b]) => b - a)
  );
}

function formatReport(
  allTime: WeekStats,
  thisWeek: WeekStats,
  topJobs: Array<{ title: string; company: string; match_score: number; status: string }>,
  skillDemand: Record<string, number>,
  staleCount: number
): string {
  const lines: string[] = [
    `# Weekly Job Hunt Report — ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## Pipeline Funnel (All Time)",
    "```",
    `Discovered:    ${allTime.discovered}`,
    `Qualified:     ${allTime.qualified} (${pct(allTime.qualified, allTime.discovered)})`,
    `Approved:      ${allTime.approved} (${pct(allTime.approved, allTime.qualified)})`,
    `Applied:       ${allTime.applied} (${pct(allTime.applied, allTime.approved)})`,
    `Responded:     ${allTime.responded} (${pct(allTime.responded, allTime.applied)})`,
    `Interviews:    ${allTime.interviews} (${pct(allTime.interviews, allTime.responded)})`,
    `Offers:        ${allTime.offers}`,
    `Rejected:      ${allTime.rejected}`,
    "```",
    "",
    "## This Week",
    `- Discovered: ${thisWeek.discovered}`,
    `- Qualified: ${thisWeek.qualified}`,
    `- Approved: ${thisWeek.approved}`,
    `- Rejected: ${thisWeek.rejected}`,
    "",
  ];

  if (topJobs.length > 0) {
    lines.push("## Top Matches This Week");
    for (const j of topJobs) {
      lines.push(`- **${j.company}** — ${j.title} (${(j.match_score * 100).toFixed(0)}%) [${j.status}]`);
    }
    lines.push("");
  }

  if (Object.keys(skillDemand).length > 0) {
    lines.push("## Skill Demand (Last 4 Weeks)");
    for (const [skill, count] of Object.entries(skillDemand)) {
      lines.push(`- ${skill}: ${count} JDs`);
    }
    lines.push("");
  }

  if (staleCount > 0) {
    lines.push(`## Stale Jobs: ${staleCount} (>14 days, no action)`);
    lines.push("");
  }

  return lines.join("\n");
}

function formatTelegramSummary(
  allTime: WeekStats,
  thisWeek: WeekStats,
  topJobs: Array<{ title: string; company: string; match_score: number; status: string }>,
  staleCount: number
): string {
  const lines: string[] = [
    `Weekly Job Hunt Report`,
    ``,
    `This week: ${thisWeek.discovered} discovered, ${thisWeek.qualified} qualified, ${thisWeek.approved} approved`,
    `All time: ${allTime.discovered} discovered → ${allTime.applied} applied → ${allTime.interviews} interviews → ${allTime.offers} offers`,
  ];

  if (topJobs.length > 0) {
    lines.push(`\nTop matches:`);
    for (const j of topJobs.slice(0, 3)) {
      lines.push(`  ${j.company} - ${j.title} (${(j.match_score * 100).toFixed(0)}%)`);
    }
  }

  if (staleCount > 0) lines.push(`\nStale: ${staleCount} jobs need attention`);

  return lines.join("\n");
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "0%";
  return `${Math.round((num / denom) * 100)}%`;
}
