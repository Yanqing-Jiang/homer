-- Trust-boundary repair: the two-tier model says the proactive (injectable) tier
-- is exactly "Yanqing stated it himself or explicitly promoted it". Status was
-- never that gate: 213 rows reached status='approved' with user_explicit=0 via
-- backfill, nightly extraction, tool-side promotion, todo/lesson hooks and weekly
-- consolidation. They were labelled approved, ranked at approved weight, self-
-- reinforced on retrieval, and rendered into the /mem-pull canonical Markdown.
--
-- This demotes them to the passive tier (status='candidate') without touching
-- content, confidence, provenance or timestamps. They stay fully searchable,
-- labelled inferred/unverified, and ranked by their own confidence. The four
-- approved + user_explicit=1 rows are untouched. Nothing is deleted and no
-- historic row is silently marked explicit — re-promotion is a deliberate
-- memory_promote / memory_replace away.
--
-- History is recorded in decided_by (prior value preserved) since there is no
-- separate claim-event table; decided_at is left as-is as the original decision
-- timestamp, updated_at marks the demotion.
UPDATE knowledge_claims
SET status = 'candidate',
    decided_by = COALESCE(NULLIF(decided_by, ''), 'unknown') || ' | demoted-119: approved->candidate (no user-explicit provenance)',
    updated_at = datetime('now')
WHERE status = 'approved'
  AND COALESCE(user_explicit, 0) = 0;

-- Utility scores accumulated while these rows were (incorrectly) reinforceable
-- stay as-is: they are a real retrieval signal, and zeroing them would destroy
-- ranking history to no benefit now that reinforcement is gated on provenance.
