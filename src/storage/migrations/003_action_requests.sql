CREATE TABLE IF NOT EXISTS action_requests (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  payload       TEXT,
  response      TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_action_requests_job_id ON action_requests (job_id);
CREATE INDEX IF NOT EXISTS idx_action_requests_status ON action_requests (status);
