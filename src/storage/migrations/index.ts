import type Database from "better-sqlite3";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database.Database) => void;
}

const initialSchemaSql = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  publish_mode TEXT NOT NULL CHECK (publish_mode IN ('image_text', 'video')),
  status TEXT NOT NULL,
  current_step TEXT,
  browser_profile_id TEXT,
  brief_json TEXT NOT NULL,
  material_summary_json TEXT,
  error_code TEXT,
  error_message TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_jobs_status_updated
  ON jobs(status, updated_at);

CREATE TABLE job_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  input_json TEXT,
  output_json TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, step_key, attempt)
);

CREATE INDEX idx_job_steps_job
  ON job_steps(job_id, created_at);

CREATE TABLE action_requests (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT,
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX idx_action_requests_open
  ON action_requests(job_id, status);

CREATE TABLE browser_profiles (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  platform TEXT NOT NULL,
  display_name TEXT NOT NULL,
  profile_ref TEXT NOT NULL,
  health_status TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  mime_type TEXT,
  checksum TEXT,
  metadata_json TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_assets_job
  ON assets(job_id, created_at);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  uri TEXT,
  value TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_evidence_job
  ON evidence(job_id, created_at);

CREATE TABLE external_actions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  action_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('prepared', 'started', 'succeeded', 'unknown', 'failed')
  ),
  external_ref TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, action_key)
);
`;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    up(db) {
      db.exec(initialSchemaSql);
    },
  },
  {
    version: 2,
    name: "add-checkpoint-json",
    up(db) {
      db.exec("ALTER TABLE jobs ADD COLUMN checkpoint_json TEXT");
    },
  },
  {
    version: 3,
    name: "enforce-single-open-action-request",
    up(db) {
      const duplicate = db
        .prepare(
          `SELECT job_id
           FROM action_requests
           WHERE status = 'open'
           GROUP BY job_id
           HAVING COUNT(*) > 1
           LIMIT 1`,
        )
        .get() as { job_id: string } | undefined;

      if (duplicate) {
        throw new Error(
          `Cannot enforce single open ActionRequest: job ${duplicate.job_id} has multiple open requests`,
        );
      }

      db.exec(
        `CREATE UNIQUE INDEX idx_action_requests_single_open
         ON action_requests(job_id)
         WHERE status = 'open'`,
      );
    },
  },
];

function readUserVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function validateMigrationList(migrationList: readonly Migration[]): number {
  let expectedVersion = 1;

  for (const migration of migrationList) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new Error(`Invalid migration version: ${migration.version}`);
    }

    if (migration.version !== expectedVersion) {
      throw new Error(
        `Migration ${migration.name} has version ${migration.version}; expected ${expectedVersion}`,
      );
    }

    expectedVersion += 1;
  }

  return expectedVersion - 1;
}

export function runMigrations(
  db: Database.Database,
  migrationList: readonly Migration[] = migrations,
): readonly string[] {
  let currentVersion = readUserVersion(db);
  const latestSupportedVersion = validateMigrationList(migrationList);

  if (currentVersion > latestSupportedVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${latestSupportedVersion}`,
    );
  }

  const applied: string[] = [];

  for (const migration of migrationList) {
    if (migration.version <= currentVersion) {
      continue;
    }

    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();

    currentVersion = migration.version;
    applied.push(migration.name);
  }

  return applied;
}
