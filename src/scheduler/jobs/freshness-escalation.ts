import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { NotificationIntent } from "../../notifications/types.js";
import { logger } from "../../utils/logger.js";
import { getRuntimePaths } from "../../utils/runtime-paths.js";
import { runInternalJobHarness } from "../executor.js";
import type { RegisteredJob } from "../types.js";

const runtimePaths = getRuntimePaths();

export const FRESHNESS_LEDGER_PATH = "/Volumes/Warehouse/AMZ_API/data/dataset_freshness.db";
const AMZ_API_ROOT = join(runtimePaths.homeDir, "Desktop", "AMZ_API");
const DEFAULT_RUNBOOK = join(AMZ_API_ROOT, "DOWNLOAD-SCHEDULE.md");
const REMEDIATION_OUTPUT_DIR = join(runtimePaths.homerRoot, "output", "freshness");
export const REARM_MS = 24 * 60 * 60 * 1000;

const DATASET_RUNBOOKS: Readonly<Record<string, string>> = Object.freeze({
  abvp_search_rank: "/Volumes/Warehouse/ABVP raw/skills.md",
});

export type FreshnessStatus =
  | "FRESH"
  | "AUTH_DEAD"
  | "IN_PROGRESS"
  | "AMAZON_INCOMPLETE"
  | "AMAZON_LATE"
  | "PULL_FAILED"
  | "UNKNOWN";

export type EscalationAction = "dispatch" | "suppress" | "defer";

export interface FreshnessAlert {
  alertKey: string;
  datasetId: string;
  periodKey: string;
  status: FreshnessStatus;
  severity: "warn" | "critical";
  evidenceNote: string;
}

export interface FreshnessLedgerSnapshot {
  datasetsChecked: number;
  alerts: FreshnessAlert[];
}

export interface FreshnessEscalationContext {
  db: Database.Database;
  job: RegisteredJob;
  startedAt: Date;
  jobRunId?: number;
  signal?: AbortSignal;
  ledgerPath?: string;
  now?: Date;
  runHarness?: typeof runInternalJobHarness;
}

export interface FreshnessEscalationResult {
  success: boolean;
  output: string;
  error?: string;
  notificationIntent: NotificationIntent;
}

interface LedgerAlertRow {
  alert_key: string;
  dataset_id: string;
  period_key: string;
  status: FreshnessStatus;
  evidence_note: string;
}

interface LastDispatchRow {
  dispatched_at: string;
}

const DISPATCH_OUTCOMES = [
  "dispatching",
  "agent_succeeded",
  "agent_failed",
  "report_missing",
] as const;

export function escalationAction(
  status: FreshnessStatus,
  severity: "warn" | "critical",
): EscalationAction {
  if (status === "AUTH_DEAD" || status === "AMAZON_LATE") return "suppress";
  if (status === "PULL_FAILED" || status === "AMAZON_INCOMPLETE") return "dispatch";
  if (status === "UNKNOWN" && severity === "critical") return "dispatch";
  return "defer";
}

export function readFreshnessLedger(
  ledgerPath = FRESHNESS_LEDGER_PATH,
): FreshnessLedgerSnapshot {
  const ledger = new Database(ledgerPath, { readonly: true, fileMustExist: true });
  try {
    ledger.pragma("query_only = ON");
    const datasetsChecked = (
      ledger.prepare("SELECT COUNT(*) AS count FROM dataset_policy WHERE enabled = 1").get() as { count: number }
    ).count;
    const rows = ledger.prepare(`
      SELECT
        a.alert_key,
        a.dataset_id,
        a.period_key,
        a.status,
        p.evidence_note
      FROM alert_state a
      JOIN dataset_policy p ON p.dataset_id = a.dataset_id
      WHERE a.cleared_at IS NULL
      ORDER BY COALESCE(a.first_sent_at, a.updated_at), a.alert_key
    `).all() as LedgerAlertRow[];

    return {
      datasetsChecked,
      alerts: rows.map((row) => ({
        alertKey: row.alert_key,
        datasetId: row.dataset_id,
        periodKey: row.period_key,
        status: row.status,
        // UNKNOWN is not normally alerting; the watchdog can insert it only
        // through classify_dataset()'s critical stale-snapshot override.
        severity: row.status === "UNKNOWN" ? "critical" : "warn",
        evidenceNote: row.evidence_note,
      })),
    };
  } finally {
    ledger.close();
  }
}

export function recordSuppressedAlert(
  db: Database.Database,
  alert: FreshnessAlert,
  now: Date,
): void {
  db.prepare(`
    INSERT INTO freshness_escalations (
      dataset_id, period_key, status, alert_key, dispatched_at, outcome, report_path
    )
    SELECT ?, ?, ?, ?, ?, 'suppressed', NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM freshness_escalations
      WHERE alert_key = ? AND outcome = 'suppressed'
    )
  `).run(
    alert.datasetId,
    alert.periodKey,
    alert.status,
    alert.alertKey,
    now.toISOString(),
    alert.alertKey,
  );
}

export function claimDispatch(
  db: Database.Database,
  alert: FreshnessAlert,
  now: Date,
  reportPath: string,
): number | null {
  const claim = db.transaction(() => {
    const placeholders = DISPATCH_OUTCOMES.map(() => "?").join(", ");
    const last = db.prepare(`
      SELECT dispatched_at
      FROM freshness_escalations
      WHERE alert_key = ? AND outcome IN (${placeholders})
      ORDER BY dispatched_at DESC
      LIMIT 1
    `).get(alert.alertKey, ...DISPATCH_OUTCOMES) as LastDispatchRow | undefined;

    if (last) {
      const lastMs = Date.parse(last.dispatched_at);
      if (!Number.isFinite(lastMs) || now.getTime() - lastMs < REARM_MS) return null;
    }

    const result = db.prepare(`
      INSERT INTO freshness_escalations (
        dataset_id, period_key, status, alert_key, dispatched_at, outcome, report_path
      ) VALUES (?, ?, ?, ?, ?, 'dispatching', ?)
    `).run(
      alert.datasetId,
      alert.periodKey,
      alert.status,
      alert.alertKey,
      now.toISOString(),
      reportPath,
    );
    return Number(result.lastInsertRowid);
  });

  return claim.immediate();
}

function updateDispatchOutcome(
  db: Database.Database,
  id: number,
  outcome: "agent_succeeded" | "agent_failed" | "report_missing",
): void {
  db.prepare("UPDATE freshness_escalations SET outcome = ? WHERE id = ?").run(outcome, id);
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function reportPathFor(alert: FreshnessAlert, now: Date): string {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return join(
    REMEDIATION_OUTPUT_DIR,
    `${safePathPart(alert.datasetId)}-${safePathPart(alert.periodKey)}-${timestamp}.md`,
  );
}

export function buildRemediationPrompt(alert: FreshnessAlert, reportPath: string): string {
  const runbook = DATASET_RUNBOOKS[alert.datasetId] ?? DEFAULT_RUNBOOK;
  const collectorLogs = join(runtimePaths.homeDir, "Library", "Logs", "AMZ_API");

  return `You are the exception-only remediation agent for an Amazon data freshness failure.

Incident:
- dataset: ${alert.datasetId}
- period: ${alert.periodKey}
- status: ${alert.status}
- alert key: ${alert.alertKey}
- freshness ledger (READ ONLY): ${FRESHNESS_LEDGER_PATH}
- runbook: ${runbook}
- dataset policy evidence_note: ${alert.evidenceNote}

Diagnose from native evidence first: collector logs under ${collectorLogs}, the read-only freshness ledger, the runbook, collector-native ledgers, manifests, and the dataset's data directories. Establish the actual failure boundary before acting.

You may remediate only safe local data-pipeline actions, such as rerunning the dataset's existing collector script, re-ingesting an already downloaded file, or fixing a misplaced file. Do not change source code, schedules, policy, or authentication state. NEVER touch auth, cookies, browser sessions, login, MFA, credentials, or auth-recovery tooling. If authentication is the root cause or becomes necessary, report that fact and stop without attempting recovery.

Hard database safety rule: NEVER run VACUUM or a full-table COUNT(*) on "/Volumes/Warehouse/ABVP raw/abvp.db" (42 GB). Keep every ledger/control-plane database read-only unless the dataset's established runbook explicitly names a bounded ingestion command that owns its own writes.

Write a full Markdown incident report to exactly:
${reportPath}

The report must include evidence inspected, diagnosis, actions attempted, validation, remaining risk, and any human action required. End both the report and your final response with one concise paragraph that can be sent to Telegram. Do not merely propose steps: perform safe local remediation when evidence supports it, then verify the result.`;
}

function conciseAgentSummary(output: string): string {
  return output.replace(/\s+/g, " ").trim().slice(0, 500);
}

function formatSummary(
  snapshot: FreshnessLedgerSnapshot,
  dispatched: number,
  suppressed: number,
  deferred: number,
  suffix?: string,
): string {
  const base = `freshness-escalation: checked=${snapshot.datasetsChecked} open=${snapshot.alerts.length} dispatched=${dispatched} suppressed=${suppressed} deferred=${deferred}`;
  return suffix ? `${base}; ${suffix}` : base;
}

export async function runFreshnessEscalation(
  ctx: FreshnessEscalationContext,
): Promise<FreshnessEscalationResult> {
  const now = ctx.now ?? new Date();
  let snapshot: FreshnessLedgerSnapshot;
  try {
    snapshot = readFreshnessLedger(ctx.ledgerPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Freshness escalation could not read ledger");
    return {
      success: false,
      output: "freshness-escalation: ledger read failed",
      error: message,
      notificationIntent: "failure_alert",
    };
  }

  let suppressed = 0;
  const dispatchable: FreshnessAlert[] = [];
  let deferred = 0;

  for (const alert of snapshot.alerts) {
    const action = escalationAction(alert.status, alert.severity);
    if (action === "suppress") {
      recordSuppressedAlert(ctx.db, alert, now);
      suppressed++;
    } else if (action === "dispatch") {
      dispatchable.push(alert);
    } else {
      deferred++;
    }
  }

  if (dispatchable.length === 0) {
    return {
      success: true,
      output: formatSummary(snapshot, 0, suppressed, deferred),
      notificationIntent: "operational_status",
    };
  }

  mkdirSync(REMEDIATION_OUTPUT_DIR, { recursive: true });
  let selected: { alert: FreshnessAlert; reportPath: string; claimId: number } | null = null;
  for (const alert of dispatchable) {
    if (selected) {
      deferred++;
      continue;
    }
    const reportPath = reportPathFor(alert, now);
    const claimId = claimDispatch(ctx.db, alert, now, reportPath);
    if (claimId === null) {
      deferred++;
      continue;
    }
    selected = { alert, reportPath, claimId };
  }

  if (!selected) {
    return {
      success: true,
      output: formatSummary(snapshot, 0, suppressed, deferred),
      notificationIntent: "operational_status",
    };
  }

  const agentResult = await (ctx.runHarness ?? runInternalJobHarness)(
    ctx.job,
    buildRemediationPrompt(selected.alert, selected.reportPath),
    {
      stage: "remediate",
      singleExecutor: "claude",
      startedAt: ctx.startedAt,
      signal: ctx.signal,
      scheduledRunId: ctx.jobRunId,
    },
  );

  if (!agentResult.success) {
    updateDispatchOutcome(ctx.db, selected.claimId, "agent_failed");
    const error = agentResult.error || agentResult.output || "remediation agent failed";
    return {
      success: false,
      output: formatSummary(snapshot, 1, suppressed, deferred, `agent_failed alert=${selected.alert.alertKey}`),
      error,
      notificationIntent: "failure_alert",
    };
  }

  if (!existsSync(selected.reportPath)) {
    updateDispatchOutcome(ctx.db, selected.claimId, "report_missing");
    return {
      success: false,
      output: formatSummary(snapshot, 1, suppressed, deferred, `report_missing=${selected.reportPath}`),
      error: "Remediation agent returned success without writing the required report",
      notificationIntent: "failure_alert",
    };
  }

  updateDispatchOutcome(ctx.db, selected.claimId, "agent_succeeded");
  const agentSummary = conciseAgentSummary(agentResult.output);
  return {
    success: true,
    output: formatSummary(
      snapshot,
      1,
      suppressed,
      deferred,
      `report=${selected.reportPath}${agentSummary ? `; agent=${agentSummary}` : ""}`,
    ),
    notificationIntent: "operational_status",
  };
}
