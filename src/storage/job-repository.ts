/**
 * JobRepository – transactional job & checkpoint persistence on top of SQLite.
 *
 * The repository accepts a `Database.Database` via constructor injection so
 * that callers control the database lifecycle (open/close) without coupling
 * to the driver type at the product-domain boundary.
 *
 * The exported `JobRepository` class depends only on the abstract
 * `DatabaseHandle` interface, which does not import better-sqlite3.
 */

import type {
  CheckpointInput,
  CreateJobInput,
  Job,
  JobStep,
} from "../contracts/job.js";

// ---------------------------------------------------------------------------
// Driver-agnostic database interface
// ---------------------------------------------------------------------------

/** Minimal prepared-statement abstraction – driver-agnostic. */
export interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** Minimal database handle – does not expose better-sqlite3 types. */
export interface DatabaseHandle {
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): () => T;
}

// ---------------------------------------------------------------------------
// Row shapes returned by SQLite
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  platform: string;
  publish_mode: string;
  status: string;
  current_step: string | null;
  brief_json: string;
  checkpoint_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface JobStepRow {
  id: string;
  job_id: string;
  step_key: string;
  status: string;
  attempt: number;
  input_json: string | null;
  output_json: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Row → domain object mapping
// ---------------------------------------------------------------------------

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    platform: row.platform,
    publishMode: row.publish_mode as Job["publishMode"],
    status: row.status as Job["status"],
    currentStep: row.current_step,
    briefJson: row.brief_json,
    checkpoint: row.checkpoint_json ? (JSON.parse(row.checkpoint_json) as Job["checkpoint"]) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapJobStep(row: JobStepRow): JobStep {
  return {
    id: row.id,
    jobId: row.job_id,
    stepKey: row.step_key,
    status: row.status as JobStep["status"],
    attempt: row.attempt,
    inputJson: row.input_json,
    outputJson: row.output_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// JobRepository
// ---------------------------------------------------------------------------

export class JobRepository {
  readonly #db: DatabaseHandle;

  constructor(db: DatabaseHandle) {
    this.#db = db;
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  create(input: CreateJobInput): Job {
    const now = new Date().toISOString();

    this.#db
      .prepare(
        `INSERT INTO jobs (
          id, platform, publish_mode, status, current_step,
          brief_json, checkpoint_json, version,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, 'pending', NULL, ?, NULL, 0, ?, ?, NULL)`,
      )
      .run(input.id, input.platform, input.publishMode, input.briefJson, now, now);

    return this.getById(input.id) as Job;
  }

  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  getById(id: string): Job | null {
    const row = this.#db
      .prepare(
        `SELECT id, platform, publish_mode, status, current_step,
                brief_json, checkpoint_json,
                created_at, updated_at, completed_at
         FROM jobs WHERE id = ?`,
      )
      .get(id) as JobRow | undefined;

    return row ? mapJob(row) : null;
  }

  // -------------------------------------------------------------------------
  // checkpoint – transactional update of job + job_steps
  // -------------------------------------------------------------------------

  checkpoint(jobId: string, input: CheckpointInput): Job {
    const now = new Date().toISOString();
    const completedAt =
      input.status === "succeeded" || input.status === "failed" || input.status === "cancelled"
        ? now
        : null;

    const run = this.#db.transaction(() => {
      // Update the job row
      this.#db
        .prepare(
          `UPDATE jobs
           SET status          = ?,
               current_step    = ?,
               checkpoint_json = ?,
               updated_at      = ?,
               completed_at    = COALESCE(completed_at, ?),
               version         = version + 1
           WHERE id = ?`,
        )
        .run(
          input.status,
          input.currentStep,
          JSON.stringify(input.checkpoint),
          now,
          completedAt,
          jobId,
        );

      // Insert the corresponding step record
      const step = input.step;
      const attempt = step.attempt ?? 1;
      this.#db
        .prepare(
          `INSERT INTO job_steps (
            id, job_id, step_key, status, attempt,
            input_json, output_json,
            error_code, error_message,
            started_at, finished_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(job_id, step_key, attempt) DO UPDATE SET
            status        = excluded.status,
            output_json   = excluded.output_json,
            error_code    = excluded.error_code,
            error_message = excluded.error_message,
            finished_at   = excluded.finished_at,
            updated_at    = excluded.updated_at`,
        )
        .run(
          step.id,
          jobId,
          step.stepKey,
          step.status,
          attempt,
          step.inputJson ?? null,
          step.outputJson ?? null,
          step.errorCode ?? null,
          step.errorMessage ?? null,
          step.startedAt ?? null,
          step.finishedAt ?? null,
          now,
          now,
        );
    });

    run();

    const updated = this.getById(jobId);
    if (!updated) {
      throw new Error(`Job not found after checkpoint: ${jobId}`);
    }
    return updated;
  }

  // -------------------------------------------------------------------------
  // getStepsForJob
  // -------------------------------------------------------------------------

  getStepsForJob(jobId: string): JobStep[] {
    return (
      this.#db
        .prepare(
          `SELECT id, job_id, step_key, status, attempt,
                  input_json, output_json,
                  error_code, error_message,
                  started_at, finished_at,
                  created_at, updated_at
           FROM job_steps
           WHERE job_id = ?
           ORDER BY created_at ASC`,
        )
        .all(jobId) as JobStepRow[]
    ).map(mapJobStep);
  }
}
