CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  job_id      TEXT REFERENCES jobs (id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  path        TEXT NOT NULL,
  mime_type   TEXT,
  size        INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_assets_job_id ON assets (job_id);
