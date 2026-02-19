-- Quantitative preference model: per-dimension scores from aggregated signals
CREATE TABLE IF NOT EXISTS preference_model (
  dimension TEXT PRIMARY KEY,
  score REAL DEFAULT 0.5,
  evidence_count INTEGER DEFAULT 0,
  last_updated TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_preference_model_score ON preference_model(score DESC);
