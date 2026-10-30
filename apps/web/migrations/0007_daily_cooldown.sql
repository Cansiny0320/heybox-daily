ALTER TABLE daily_scheduler ADD COLUMN cooldown_until INTEGER NOT NULL DEFAULT 0;
CREATE TABLE daily_rate_limits (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  observed_at INTEGER NOT NULL,
  retry_until INTEGER NOT NULL
);
CREATE INDEX daily_rate_limits_observed ON daily_rate_limits(observed_at);
