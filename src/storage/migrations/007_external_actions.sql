CREATE TABLE IF NOT EXISTS external_actions (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  platform    TEXT NOT NULL,
  action_type TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  request     TEXT,
  response    TEXT,
  idempotency_key TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_external_actions_job_id ON external_actions (job_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_actions_idempotency ON external_actions (idempotency_key) WHERE idempotency_key IS NOT NULL;
