import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  claimDispatch,
  escalationAction,
  readFreshnessLedger,
  recordSuppressedAlert,
  runFreshnessEscalation,
  type FreshnessAlert,
} from "../../src/scheduler/jobs/freshness-escalation.js";

function createBookkeepingDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE freshness_escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      status TEXT NOT NULL,
      alert_key TEXT NOT NULL,
      dispatched_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      report_path TEXT
    )
  `);
  return db;
}

const ACTIONABLE_ALERT: FreshnessAlert = {
  alertKey: "amc_weekly|2026-08-09|PULL_FAILED",
  datasetId: "amc_weekly",
  periodKey: "2026-08-09",
  status: "PULL_FAILED",
  severity: "warn",
  evidenceNote: "fixture evidence",
};

test("escalation policy dispatches only actionable collector failures", () => {
  assert.equal(escalationAction("PULL_FAILED", "warn"), "dispatch");
  assert.equal(escalationAction("AMAZON_INCOMPLETE", "warn"), "dispatch");
  assert.equal(escalationAction("UNKNOWN", "critical"), "dispatch");

  assert.equal(escalationAction("AUTH_DEAD", "critical"), "suppress");
  assert.equal(escalationAction("AMAZON_LATE", "critical"), "suppress");

  assert.equal(escalationAction("UNKNOWN", "warn"), "defer");
  assert.equal(escalationAction("IN_PROGRESS", "warn"), "defer");
  assert.equal(escalationAction("FRESH", "warn"), "defer");
});

test("reads only open watchdog transitions from a fake ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "freshness-ledger-"));
  const ledgerPath = join(dir, "dataset_freshness.db");
  const ledger = new Database(ledgerPath);
  try {
    ledger.exec(`
      CREATE TABLE dataset_policy (
        dataset_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        evidence_note TEXT NOT NULL
      );
      CREATE TABLE alert_state (
        alert_key TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        period_key TEXT NOT NULL,
        status TEXT NOT NULL,
        first_sent_at TEXT,
        cleared_at TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    ledger.prepare(
      "INSERT INTO dataset_policy (dataset_id, enabled, evidence_note) VALUES (?, 1, ?)",
    ).run("amc_weekly", "AMC fixture note");
    ledger.prepare(
      "INSERT INTO dataset_policy (dataset_id, enabled, evidence_note) VALUES (?, 1, ?)",
    ).run("promo_promotion", "Promo fixture note");
    const insert = ledger.prepare(`
      INSERT INTO alert_state (
        alert_key, dataset_id, period_key, status, first_sent_at, cleared_at, updated_at
      ) VALUES (?, ?, ?, ?, '2026-08-18T08:00:00Z', ?, '2026-08-18T08:00:00Z')
    `);
    insert.run(
      "amc_weekly|2026-08-09|PULL_FAILED",
      "amc_weekly",
      "2026-08-09",
      "PULL_FAILED",
      null,
    );
    insert.run(
      "promo_promotion|2026-08-16|UNKNOWN",
      "promo_promotion",
      "2026-08-16",
      "UNKNOWN",
      null,
    );
    insert.run(
      "amc_weekly|2026-08-02|AMAZON_LATE",
      "amc_weekly",
      "2026-08-02",
      "AMAZON_LATE",
      "2026-08-18T09:00:00Z",
    );
  } finally {
    ledger.close();
  }

  try {
    const snapshot = readFreshnessLedger(ledgerPath);
    assert.equal(snapshot.datasetsChecked, 2);
    assert.equal(snapshot.alerts.length, 2);
    assert.deepEqual(
      snapshot.alerts.map((alert) => [alert.alertKey, alert.severity, alert.evidenceNote]),
      [
        ["amc_weekly|2026-08-09|PULL_FAILED", "warn", "AMC fixture note"],
        ["promo_promotion|2026-08-16|UNKNOWN", "critical", "Promo fixture note"],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("happy path returns without invoking the remediation harness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freshness-happy-"));
  const ledgerPath = join(dir, "dataset_freshness.db");
  const ledger = new Database(ledgerPath);
  ledger.exec(`
    CREATE TABLE dataset_policy (
      dataset_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      evidence_note TEXT NOT NULL
    );
    CREATE TABLE alert_state (
      alert_key TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      status TEXT NOT NULL,
      first_sent_at TEXT,
      cleared_at TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO dataset_policy (dataset_id, enabled, evidence_note)
      VALUES ('amc_weekly', 1, 'fixture');
  `);
  ledger.close();

  const db = createBookkeepingDb();
  let harnessCalls = 0;
  try {
    const result = await runFreshnessEscalation({
      db,
      ledgerPath,
      startedAt: new Date("2026-08-18T08:00:00Z"),
      jobRunId: 1,
      job: {
        config: {
          id: "freshness-escalation",
          name: "Amazon Freshness Escalation",
          cron: "15 * * * *",
          query: "fixture",
          lane: "default",
          enabled: true,
          executor: "internal",
          handler: "freshness_escalation",
        },
        sourceFile: "fixture",
        nextRun: null,
        lastRun: null,
        lastSuccess: null,
        consecutiveFailures: 0,
      },
      runHarness: async () => {
        harnessCalls++;
        throw new Error("happy path must not invoke harness");
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.output, "freshness-escalation: checked=1 open=0 dispatched=0 suppressed=0 deferred=0");
    assert.equal(harnessCalls, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch claims deduplicate for 24 hours and then re-arm", () => {
  const db = createBookkeepingDb();
  try {
    const firstAt = new Date("2026-08-18T08:00:00Z");
    const first = claimDispatch(db, ACTIONABLE_ALERT, firstAt, "/tmp/first.md");
    assert.ok(first);

    const early = claimDispatch(
      db,
      ACTIONABLE_ALERT,
      new Date(firstAt.getTime() + 24 * 60 * 60 * 1000 - 1),
      "/tmp/early.md",
    );
    assert.equal(early, null);

    const rearmed = claimDispatch(
      db,
      ACTIONABLE_ALERT,
      new Date(firstAt.getTime() + 24 * 60 * 60 * 1000),
      "/tmp/rearmed.md",
    );
    assert.ok(rearmed);

    const rows = db.prepare(
      "SELECT outcome, report_path FROM freshness_escalations ORDER BY id",
    ).all();
    assert.deepEqual(rows, [
      { outcome: "dispatching", report_path: "/tmp/first.md" },
      { outcome: "dispatching", report_path: "/tmp/rearmed.md" },
    ]);
  } finally {
    db.close();
  }
});

test("suppressed alerts are recorded once and do not count as dispatch claims", () => {
  const db = createBookkeepingDb();
  const suppressed: FreshnessAlert = {
    ...ACTIONABLE_ALERT,
    alertKey: "amc_weekly|2026-08-09|AMAZON_LATE",
    status: "AMAZON_LATE",
  };
  const now = new Date("2026-08-18T08:00:00Z");
  try {
    recordSuppressedAlert(db, suppressed, now);
    recordSuppressedAlert(db, suppressed, new Date(now.getTime() + 60_000));
    assert.deepEqual(
      db.prepare("SELECT alert_key, outcome FROM freshness_escalations").all(),
      [{ alert_key: suppressed.alertKey, outcome: "suppressed" }],
    );

    assert.ok(claimDispatch(db, suppressed, now, "/tmp/not-used-by-job.md"));
  } finally {
    db.close();
  }
});
