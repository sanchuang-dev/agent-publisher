CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'pending',
  platform    TEXT NOT NULL,
  title       TEXT,
  payload     TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at);
