-- Remove cost telemetry schema (tables, trigger, view)
-- Cost tracking is intentionally disabled.

DROP VIEW IF EXISTS v_daily_costs;
DROP TRIGGER IF EXISTS update_daily_cost_summary;

DROP INDEX IF EXISTS idx_executor_costs_account;
DROP INDEX IF EXISTS idx_executor_costs_executor;
DROP INDEX IF EXISTS idx_executor_costs_date;

DROP TABLE IF EXISTS daily_cost_summary;
DROP TABLE IF EXISTS executor_costs;
