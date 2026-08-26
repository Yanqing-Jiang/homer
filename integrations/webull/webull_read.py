#!/usr/bin/env python3
"""Read-only Webull OpenAPI client for Homer.

Pulls account list, balances, and positions; prints JSON and (with --db)
upserts a row per account into homer.db `portfolio_snapshots`.

Credentials come from the macOS keychain:
  security add-generic-password -s homer-webull -a app_key    -w '<APP_KEY>'
  security add-generic-password -s homer-webull -a app_secret -w '<APP_SECRET>'

Usage:
  .venv/bin/python webull_read.py            # JSON to stdout
  .venv/bin/python webull_read.py --db       # also write snapshot to homer.db

DEBT: read-only by design. Order placement (order_v2.place_order) is deliberately
not wired; add it only behind an explicit symbol whitelist + max-notional guard
once the weekly rebalance workflow exists.
"""
import argparse
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone

from webullsdkcore.client import ApiClient
from webullsdktrade.api import API

KEYCHAIN_SERVICE = "homer-webull"
DB_PATH = os.path.expanduser("~/homer/data/homer.db")


def keychain(account: str) -> str:
    out = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"keychain item missing: -s {KEYCHAIN_SERVICE} -a {account}")
    return out.stdout.strip()


def body(resp):
    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text}")
    return resp.json()


def fetch():
    client = ApiClient(keychain("app_key"), keychain("app_secret"), region_id="us")
    api = API(client)
    accounts = body(api.account_v2.get_account_list())
    result = {"fetched_at": datetime.now(timezone.utc).isoformat(), "accounts": []}
    for acct in accounts:
        aid = acct.get("account_id") or acct.get("accountId")
        bal = body(api.account_v2.get_account_balance(aid))
        pos = body(api.account_v2.get_account_position(aid))
        result["accounts"].append({"account": acct, "balance": bal, "positions": pos})
    return result


def write_db(snapshot):
    con = sqlite3.connect(DB_PATH)
    con.execute(
        """CREATE TABLE IF NOT EXISTS portfolio_snapshots (
             id INTEGER PRIMARY KEY,
             broker TEXT NOT NULL,
             account_id TEXT NOT NULL,
             fetched_at TEXT NOT NULL,
             total_value REAL,
             cash REAL,
             positions_json TEXT,
             raw_json TEXT,
             UNIQUE(broker, account_id, fetched_at)
           )"""
    )
    for a in snapshot["accounts"]:
        aid = str(a["account"].get("account_id") or a["account"].get("accountId"))
        bal = a["balance"]
        con.execute(
            "INSERT OR IGNORE INTO portfolio_snapshots (broker, account_id, fetched_at, total_value, cash, positions_json, raw_json) VALUES (?,?,?,?,?,?,?)",
            (
                "webull", aid, snapshot["fetched_at"],
                _num(bal, "total_asset", "totalAssetValue", "net_liquidation_value"),
                _num(bal, "cash_balance", "cashBalance", "total_cash"),
                json.dumps(a["positions"]), json.dumps(a),
            ),
        )
    con.commit()
    con.close()


def _num(d, *keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) is not None:
            try:
                return float(d[k])
            except (TypeError, ValueError):
                pass
    return None


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--db", action="store_true", help="write snapshot to homer.db")
    args = p.parse_args()
    snap = fetch()
    print(json.dumps(snap, indent=2))
    if args.db:
        write_db(snap)
        print("snapshot written", file=sys.stderr)
