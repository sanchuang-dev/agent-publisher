CREATE TABLE IF NOT EXISTS job_steps (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  output      TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_job_steps_job_id ON job_steps (job_id);
