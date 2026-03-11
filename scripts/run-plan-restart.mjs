import { execFileSync } from "child_process";
import Database from "better-sqlite3";

const HOMER_DIR = process.env.HOMER_DIR || "/Users/yj/homer";
const DB_PATH = process.env.HOMER_DB_PATH || "/Users/yj/homer/data/homer.db";
const execId = Number(process.argv[2] || "0");

if (!Number.isFinite(execId) || execId <= 0) {
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("busy_timeout = 5000");

function update(fields) {
  const entries = Object.entries(fields);
  const setClause = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => value);
  db.prepare(`UPDATE plan_executions SET ${setClause} WHERE id = ?`).run(...values, execId);
}

function captureError(error) {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }
  const stdout = error.stdout ? String(error.stdout) : "";
  const stderr = error.stderr ? String(error.stderr) : "";
  const message = error.message ? String(error.message) : String(error);
  return [stdout, stderr, message].filter(Boolean).join("\n").slice(-4000);
}

try {
  execFileSync("bash", ["scripts/pre-restart-check.sh"], {
    cwd: HOMER_DIR,
    encoding: "utf-8",
    timeout: 5 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      HOMER_DEPLOY_POLICY: process.env.HOMER_DEPLOY_POLICY || "force",
    },
  });

  execFileSync("npm", ["run", "restart"], {
    cwd: HOMER_DIR,
    encoding: "utf-8",
    timeout: 2 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });

  update({
    integration_status: "deployed",
    deploy_status: "deployed",
    deployed_at: new Date().toISOString(),
    last_error: null,
    final_notified_at: null,
  });
} catch (error) {
  update({
    integration_status: "failed",
    deploy_status: "failed",
    last_error: captureError(error),
    final_notified_at: null,
  });
  process.exitCode = 1;
} finally {
  db.close();
}
