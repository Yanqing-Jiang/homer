-- 086: code_push_proposals — Phase 1.4 preview-before-act for nightly-code-push
--
-- nightly-code-push still commits locally (safe, reversible), but `git push` now
-- waits on Telegram approval. Each pending proposal pins the exact HEAD sha and
-- working-tree status at preview time. Execution revalidates against those
-- fingerprints before pushing, so an approved-but-stale preview cannot push a
-- worktree that has drifted.

CREATE TABLE IF NOT EXISTS code_push_proposals (
  id TEXT PRIMARY KEY,
  head_sha TEXT NOT NULL,               -- HEAD commit at preview time
  unpushed_count INTEGER NOT NULL,      -- commits ahead of origin/main at preview time
  diff_stat TEXT NOT NULL,              -- output of `git diff --stat origin/main..HEAD`
  commit_subjects TEXT NOT NULL,        -- newline-joined subject lines of unpushed commits
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','expired','executed','failed','stale')),
  telegram_message_id INTEGER,
  telegram_chat_id INTEGER,
  decision_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  executed_at TEXT,
  expires_at TEXT NOT NULL              -- 12h after creation; stale previews auto-expire
);

-- Only one pending/approved proposal at a time. A new nightly run either reuses
-- the current row (if still accurate) or supersedes it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_code_push_open
  ON code_push_proposals(status)
  WHERE status IN ('pending','approved');

CREATE INDEX IF NOT EXISTS idx_code_push_created
  ON code_push_proposals(created_at DESC);
