-- 133: Webull saved watchlists, one row per (snapshot, watchlist, symbol).
--
-- Webull's OpenAPI models a user's saved symbols as up to 20 named watchlists,
-- each holding instruments (max 1000 across all lists). Both the cloud MCP
-- (get_watchlists / get_watchlist_instruments) and the OpenAPI SDK return the
-- same shape, so one table serves either source; `source` records which pulled
-- the row so a stale MCP dump is distinguishable from a live OpenAPI read.
--
-- Snapshot-per-day rather than a mutable current-state table: the interesting
-- signal is what Yanqing added or dropped and when, and added_at from Webull
-- only survives while the symbol is still on the list.
CREATE TABLE IF NOT EXISTS webull_watchlist (
  id INTEGER PRIMARY KEY,
  snapshot_date TEXT NOT NULL,          -- YYYY-MM-DD, local date of the pull
  fetched_at TEXT NOT NULL,             -- ISO-8601 UTC
  source TEXT NOT NULL,                 -- 'mcp' | 'openapi'
  watchlist_id TEXT NOT NULL,
  watchlist_name TEXT,
  symbol TEXT NOT NULL,
  name TEXT,                            -- instrument display name
  category TEXT,                        -- US_STOCK, US_CRYPTO, ...
  exchange_code TEXT,
  instrument_id TEXT,
  sort_order INTEGER,
  added_at TEXT,                        -- Webull's added_time for the instrument
  raw_json TEXT,
  UNIQUE(snapshot_date, watchlist_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_webull_watchlist_symbol
  ON webull_watchlist(symbol, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_webull_watchlist_snapshot
  ON webull_watchlist(snapshot_date);
