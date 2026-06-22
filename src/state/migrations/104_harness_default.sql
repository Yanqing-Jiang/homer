-- 104_harness_default.sql
-- Single source of truth for the GLOBAL default harness (the "main harness" switch).
-- One row (id=1). Flipping executor='claude' is the instant global kill-switch back to
-- Claude; it affects every lane that has NO explicit per-lane executor_state override.
-- Resolution order enforced in code: explicit turn/command -> per-lane executor_state ->
-- harness_default row -> hard 'claude' safety.

CREATE TABLE IF NOT EXISTS harness_default (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  executor TEXT NOT NULL DEFAULT 'opencode' CHECK (executor IN ('claude','opencode')),
  model TEXT NOT NULL DEFAULT 'opencode-go/glm-5.2',
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO harness_default (id, executor, model, updated_at)
VALUES (1, 'opencode', 'opencode-go/glm-5.2', strftime('%s','now') * 1000);
