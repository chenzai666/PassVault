-- 原子固定窗口限流；独立于登录失败计数。
CREATE TABLE IF NOT EXISTS rate_limit_budgets (
  identifier TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (identifier, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_budgets_expires ON rate_limit_budgets(expires_at);
