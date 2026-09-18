CREATE TABLE IF NOT EXISTS browser_profiles (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL,
  label       TEXT,
  profile_dir TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_browser_profiles_platform ON browser_profiles (platform);
