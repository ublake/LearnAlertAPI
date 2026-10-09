CREATE TABLE IF NOT EXISTS ai_request_limits (
  subject TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  last_request TEXT NOT NULL,
  PRIMARY KEY(subject, window_start, window_seconds)
);
