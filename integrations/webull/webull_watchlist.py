#!/usr/bin/env python3
"""Read-only Webull watchlist reader for Homer.

Pulls Yanqing's saved Webull watchlists (up to 20 named lists, each holding
instruments) and writes one row per (snapshot_date, watchlist, symbol) into
homer.db `webull_watchlist`.

Two sources, same output table:

  openapi (default) -- live read via the official OpenAPI using an App Key /
      App Secret from the macOS keychain. Requires `webull-openapi-python-sdk`
      (>= 2.0.19, the `webull.*` namespace) -- the older `webull-python-sdk-*`
      0.1.18 packages used by webull_read.py have no watchlist endpoints.
      Endpoints hit: GET /watchlists, GET /watchlists/{id}/instruments.

  mcp -- parses a JSON dump produced by the Webull cloud MCP tools
      `get_watchlists` and `get_watchlist_instruments`. Use this while the
      OpenAPI application is still pending; the cloud MCP needs only browser
      OAuth, no App Key. Expected shape (key aliases tolerated):
        {"watchlists": [{"watchlist_id": "..", "name": "..",
                         "instruments": [{"symbol": "..", "name": "..", ...}]}]}

Credentials (openapi source only):
  security add-generic-password -s homer-webull -a app_key    -w '<APP_KEY>'
  security add-generic-password -s homer-webull -a app_secret -w '<APP_SECRET>'

Usage:
  .venv/bin/python webull_watchlist.py                        # OpenAPI -> stdout
  .venv/bin/python webull_watchlist.py --db                   # ... and homer.db
  .venv/bin/python webull_watchlist.py --from-mcp-json f.json --db
  .venv/bin/python webull_watchlist.py --from-mcp-json f.json --out-dir ~/Desktop/Investing/webull

Read-only by construction: only the two GET endpoints are called. The SDK also
exposes create/update/delete/add/remove watchlist mutations -- none are wired,
and none should be; Homer observes this list, it does not curate it.
"""
import argparse
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone

KEYCHAIN_SERVICE = "homer-webull"
DB_PATH = os.path.expanduser(os.environ.get("HOMER_DB_PATH", "~/homer/data/homer.db"))
REGION_ID = "us"


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def keychain(account: str) -> str:
    out = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        sys.exit(
            f"keychain item missing: -s {KEYCHAIN_SERVICE} -a {account}\n"
            "The Webull OpenAPI application has not been approved yet, or the App Key\n"
            "was never stored. Use --from-mcp-json with a cloud-MCP dump instead."
        )
    return out.stdout.strip()


def pick(d: dict, *keys, default=None):
    """First present, non-None value among `keys`. Webull is inconsistent about
    snake_case vs camelCase across the MCP and the SDK, so accept both."""
    for k in keys:
        if isinstance(d, dict) and d.get(k) is not None:
            return d[k]
    return default


def as_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def unwrap(payload):
    """MCP tool results are sometimes bare lists, sometimes {"data": [...]}."""
    if isinstance(payload, dict):
        for k in ("data", "watchlists", "items", "result", "instruments"):
            if isinstance(payload.get(k), list):
                return payload[k]
    return payload if isinstance(payload, list) else []


# --------------------------------------------------------------------------- #
# sources
# --------------------------------------------------------------------------- #
def fetch_openapi():
    try:
        from webull.core.client import ApiClient
        from webull.data.data_client import DataClient
    except ImportError:
        sys.exit(
            "webull-openapi-python-sdk not installed in this interpreter.\n"
            "  .venv/bin/pip install 'webull-openapi-python-sdk>=2.0.19'"
        )

    client = ApiClient(keychain("app_key"), keychain("app_secret"), REGION_ID)
    data = DataClient(client)

    def body(resp, what):
        if resp.status_code != 200:
            raise RuntimeError(f"{what}: HTTP {resp.status_code}: {resp.text}")
        return resp.json()

    lists = unwrap(body(data.watchlist.get_watchlist(), "get_watchlist"))
    out = []
    for wl in lists:
        wid = str(pick(wl, "watchlist_id", "watchlistId", "id", default=""))
        if not wid:
            continue
        instruments = unwrap(
            body(data.watchlist.get_instruments(wid), f"get_instruments({wid})")
        )
        out.append(
            {
                "watchlist_id": wid,
                "name": pick(wl, "name", "watchlist_name", "watchlistName"),
                "instruments": instruments,
                "raw": wl,
            }
        )
    return out


def fetch_mcp_json(path: str):
    with open(os.path.expanduser(path)) as fh:
        doc = json.load(fh)
    lists = unwrap(doc) or (doc.get("watchlists") if isinstance(doc, dict) else [])
    out = []
    for wl in lists or []:
        wid = str(pick(wl, "watchlist_id", "watchlistId", "id", default=""))
        out.append(
            {
                "watchlist_id": wid,
                "name": pick(wl, "name", "watchlist_name", "watchlistName"),
                "instruments": unwrap(
                    pick(wl, "instruments", "items", "tickers", default=[])
                )
                or pick(wl, "instruments", default=[]),
                "raw": wl,
            }
        )
    return out


# --------------------------------------------------------------------------- #
# normalise + persist
# --------------------------------------------------------------------------- #
def normalise(lists, source):
    now = datetime.now(timezone.utc)
    fetched_at = now.isoformat()
    snapshot_date = now.astimezone().strftime("%Y-%m-%d")
    rows = []
    for wl in lists:
        for ins in wl.get("instruments") or []:
            if not isinstance(ins, dict):
                continue
            symbol = pick(ins, "symbol", "ticker", "disSymbol")
            if not symbol:
                continue
            rows.append(
                {
                    "snapshot_date": snapshot_date,
                    "fetched_at": fetched_at,
                    "source": source,
                    "watchlist_id": wl["watchlist_id"],
                    "watchlist_name": wl.get("name"),
                    "symbol": str(symbol).upper(),
                    "name": pick(ins, "name", "instrument_name", "shortName", "tickerName"),
                    "category": pick(ins, "category", "instrument_type", "type"),
                    "exchange_code": pick(ins, "exchange_code", "exchangeCode", "exchange"),
                    "instrument_id": _str_or_none(
                        pick(ins, "instrument_id", "instrumentId", "tickerId")
                    ),
                    "sort_order": as_int(pick(ins, "sort", "sort_order", "sortOrder")),
                    "added_at": _str_or_none(
                        pick(ins, "added_time", "addedTime", "added_at", "create_time")
                    ),
                    "raw_json": json.dumps(ins, default=str),
                }
            )
    return {"fetched_at": fetched_at, "snapshot_date": snapshot_date,
            "source": source, "watchlists": lists, "rows": rows}


def _str_or_none(v):
    return None if v is None else str(v)


COLUMNS = (
    "snapshot_date", "fetched_at", "source", "watchlist_id", "watchlist_name",
    "symbol", "name", "category", "exchange_code", "instrument_id",
    "sort_order", "added_at", "raw_json",
)


def write_db(snap):
    if not os.path.exists(DB_PATH):
        sys.exit(f"homer.db not found at {DB_PATH}")
    con = sqlite3.connect(DB_PATH)
    try:
        cur = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='webull_watchlist'")
        if cur.fetchone() is None:
            sys.exit(
                "table `webull_watchlist` missing -- run Homer's migrations "
                "(src/state/migrations/133_webull_watchlist.sql) first."
            )
        placeholders = ",".join("?" * len(COLUMNS))
        # A re-run on the same day replaces that day's snapshot rather than
        # silently keeping the first pull, so a mid-day edit in the app shows up.
        con.execute(
            "DELETE FROM webull_watchlist WHERE snapshot_date = ?", (snap["snapshot_date"],)
        )
        con.executemany(
            f"INSERT INTO webull_watchlist ({','.join(COLUMNS)}) VALUES ({placeholders})",
            [tuple(r[c] for c in COLUMNS) for r in snap["rows"]],
        )
        con.commit()
    finally:
        con.close()
    return len(snap["rows"])


def write_files(snap, out_dir):
    out_dir = os.path.expanduser(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    stem = f"watchlist-{snap['snapshot_date']}"
    jpath = os.path.join(out_dir, f"{stem}.json")
    mpath = os.path.join(out_dir, f"{stem}.md")
    with open(jpath, "w") as fh:
        json.dump(snap, fh, indent=2, default=str)

    by_list = {}
    for r in snap["rows"]:
        by_list.setdefault((r["watchlist_id"], r["watchlist_name"]), []).append(r)
    lines = [
        f"# Webull watchlist — {snap['snapshot_date']}",
        "",
        f"Source: `{snap['source']}` · fetched {snap['fetched_at']} · "
        f"{len(snap['rows'])} symbols across {len(by_list)} list(s)",
        "",
    ]
    for (wid, wname), rows in by_list.items():
        lines += [f"## {wname or wid}", "", "| Symbol | Name | Category | Exchange | Added |",
                  "| --- | --- | --- | --- | --- |"]
        for r in sorted(rows, key=lambda x: (x["sort_order"] is None, -(x["sort_order"] or 0))):
            lines.append(
                f"| {r['symbol']} | {r['name'] or ''} | {r['category'] or ''} | "
                f"{r['exchange_code'] or ''} | {r['added_at'] or ''} |"
            )
        lines.append("")
    with open(mpath, "w") as fh:
        fh.write("\n".join(lines))
    return jpath, mpath


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--from-mcp-json", metavar="FILE",
                   help="parse a cloud-MCP dump instead of calling the OpenAPI")
    p.add_argument("--db", action="store_true", help="write rows to homer.db webull_watchlist")
    p.add_argument("--out-dir", metavar="DIR",
                   help="also write watchlist-YYYY-MM-DD.{json,md} into DIR")
    p.add_argument("--quiet", action="store_true", help="suppress the stdout JSON dump")
    args = p.parse_args()

    if args.from_mcp_json:
        lists, source = fetch_mcp_json(args.from_mcp_json), "mcp"
    else:
        lists, source = fetch_openapi(), "openapi"

    snap = normalise(lists, source)
    if not args.quiet:
        print(json.dumps(snap, indent=2, default=str))
    if not snap["rows"]:
        print("no watchlist symbols found", file=sys.stderr)
    if args.db:
        print(f"{write_db(snap)} rows written to webull_watchlist", file=sys.stderr)
    if args.out_dir:
        j, m = write_files(snap, args.out_dir)
        print(f"wrote {j}\nwrote {m}", file=sys.stderr)


if __name__ == "__main__":
    main()
