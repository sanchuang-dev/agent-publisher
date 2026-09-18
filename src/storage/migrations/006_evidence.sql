CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  path        TEXT,
  data        TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_evidence_job_id ON evidence (job_id);
