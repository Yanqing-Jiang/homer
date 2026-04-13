/**
 * Sync wedding RSVPs from Cloudflare D1 into homer.db.
 *
 * Shells out to `wrangler d1 execute` (uses user's local OAuth, auto-refreshed).
 * D1 stays source of truth; we mirror new rows into `wedding_rsvps` for the
 * admin dashboard + Telegram notifications.
 *
 * Schedule: hourly (0 * * * *)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";

const execFileP = promisify(execFile);

const D1_DB_NAME = "wedding-rsvps";
const WRANGLER = "/opt/homebrew/bin/wrangler";
const PROJECT_CWD = "/Users/yj/yj-wedding";

interface D1Row {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  group_size: number;
  events: "okc" | "china" | "both" | "none";
  dietary: string | null;
  message: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
}

interface SyncState {
  last_synced_d1_id: number;
  last_sync_count: number;
}

function getSyncState(db: Database.Database): SyncState {
  const row = db
    .prepare("SELECT last_synced_d1_id, last_sync_count FROM wedding_rsvps_sync_state WHERE id = 1")
    .get() as SyncState | undefined;
  return row ?? { last_synced_d1_id: 0, last_sync_count: 0 };
}

async function fetchNewRows(sinceId: number): Promise<D1Row[]> {
  const sql = `SELECT id, name, email, phone, group_size, events, dietary, message, ip, user_agent, created_at FROM rsvps WHERE id > ${sinceId} ORDER BY id ASC LIMIT 500`;
  const { stdout } = await execFileP(
    WRANGLER,
    ["d1", "execute", D1_DB_NAME, "--remote", "--command", sql, "--json"],
    { cwd: PROJECT_CWD, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }
  );

  const parsed = JSON.parse(stdout) as Array<{ results?: D1Row[] }>;
  return parsed[0]?.results ?? [];
}

export async function runSyncWeddingRsvps(
  stateManager: StateManager
): Promise<{ synced: number; totalRsvps: number }> {
  const db = stateManager.getDb();
  const state = getSyncState(db);

  let rows: D1Row[];
  try {
    rows = await fetchNewRows(state.last_synced_d1_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE wedding_rsvps_sync_state SET last_sync_at = strftime('%s','now'), last_sync_error = ? WHERE id = 1"
    ).run(msg);
    logger.error({ err: msg }, "wedding_rsvps sync: D1 fetch failed");
    throw err;
  }

  const insert = db.prepare(
    `INSERT OR REPLACE INTO wedding_rsvps
     (d1_id, name, email, phone, group_size, events, dietary, message, ip, user_agent, created_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))`
  );

  const tx = db.transaction((items: D1Row[]) => {
    let maxId = state.last_synced_d1_id;
    for (const r of items) {
      insert.run(r.id, r.name, r.email, r.phone, r.group_size, r.events, r.dietary, r.message, r.ip, r.user_agent, r.created_at);
      if (r.id > maxId) maxId = r.id;
    }
    return maxId;
  });

  const newMaxId = tx(rows);

  db.prepare(
    `UPDATE wedding_rsvps_sync_state
       SET last_synced_d1_id = ?, last_sync_at = strftime('%s','now'),
           last_sync_count = ?, last_sync_error = NULL
     WHERE id = 1`
  ).run(newMaxId, rows.length);

  const total = (db.prepare("SELECT COUNT(*) AS n FROM wedding_rsvps").get() as { n: number }).n;

  logger.info({ synced: rows.length, total, maxId: newMaxId }, "wedding_rsvps sync complete");
  return { synced: rows.length, totalRsvps: total };
}
