-- Rolling log of every billable API call.
--
-- A row is inserted the moment work starts (status 'in_progress') and updated
-- when the call settles, so a long generation is visible while it runs rather
-- than appearing only after it finishes.

CREATE TABLE IF NOT EXISTS call_log (
  request_id    TEXT PRIMARY KEY,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL,
  method        TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  provider      TEXT,
  model         TEXT,
  source_type   TEXT,
  tokens_in     INTEGER,
  tokens_cached INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  http_status   INTEGER,
  error_code    TEXT
);

-- The page reads newest-first and prunes by age; both want this index.
CREATE INDEX IF NOT EXISTS call_log_started_at ON call_log (started_at DESC);
