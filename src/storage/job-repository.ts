/**
 * SQLite implementation of the driver-agnostic JobRepository contract.
 */

import {
  JobNotFoundError,
  type CheckpointInput,
  type CreateJobInput,
  type Job,
  type JobCheckpoint,
  type JobRepository as JobRepositoryContract,
  type JobStep,
} from "../contracts/job.js";
import { assertJobStatusTransitionAllowed } from "../jobs/state-machine.js";

interface RunResult {
  readonly changes: number;
}

interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface DatabaseHandle {
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): () => T;
}

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

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    platform: row.platform as Job["platform"],
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

export class JobRepository implements JobRepositoryContract {
  readonly #db: DatabaseHandle;

  constructor(db: DatabaseHandle) {
    this.#db = db;
  }

  create(input: CreateJobInput): Job {
    const now = new Date().toISOString();

    this.#db
      .prepare(
        `INSERT INTO jobs (
          id, platform, publish_mode, status, current_step,
          brief_json, checkpoint_json, version,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, 'created', NULL, ?, NULL, 0, ?, ?, NULL)`,
      )
      .run(input.id, input.platform, input.publishMode, input.briefJson, now, now);

    return this.#requireJob(input.id);
  }

  getById(id: string): Job | null {
    const row = this.#db
      .prepare(
        `SELECT id, platform, publish_mode, status, current_step,
                brief_json, checkpoint_json, created_at, updated_at, completed_at
         FROM jobs
         WHERE id = ?`,
      )
      .get(id) as JobRow | undefined;

    return row ? mapJob(row) : null;
  }

  commitCheckpoint(jobId: string, input: CheckpointInput): Job {
    const now = new Date().toISOString();
    const checkpointJson = JSON.stringify(input.checkpoint);
    const step = input.step;
    const attempt = step.attempt ?? 1;

    const commit = this.#db.transaction(() => {
      const currentJob = this.#requireJob(jobId);
      assertJobStatusTransitionAllowed(currentJob.status, input.status);

      const result = this.#db
        .prepare(
          `UPDATE jobs
           SET status          = ?,
               current_step    = ?,
               checkpoint_json = ?,
               updated_at      = ?,
               completed_at    = CASE
                 WHEN ? IN ('succeeded', 'failed') THEN COALESCE(completed_at, ?)
                 ELSE completed_at
               END,
               version         = version + 1
           WHERE id = ?`,
        )
        .run(input.status, step.stepKey, checkpointJson, now, input.status, now, jobId);

      if (result.changes !== 1) {
        throw new JobNotFoundError(jobId);
      }

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
            input_json    = excluded.input_json,
            output_json   = excluded.output_json,
            error_code    = excluded.error_code,
            error_message = excluded.error_message,
            started_at    = COALESCE(job_steps.started_at, excluded.started_at),
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

    commit();
    return this.#requireJob(jobId);
  }

  loadLastCheckpoint(jobId: string): JobCheckpoint | null {
    const job = this.#requireJob(jobId);

    if (job.checkpoint === null) {
      return null;
    }

    if (job.currentStep === null) {
      throw new Error(`Invalid persisted checkpoint without current_step for job: ${jobId}`);
    }

    return {
      jobId: job.id,
      status: job.status,
      currentStep: job.currentStep,
      checkpoint: job.checkpoint,
      committedAt: job.updatedAt,
    };
  }

  getStepsForJob(jobId: string): readonly JobStep[] {
    this.#requireJob(jobId);

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
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(jobId) as JobStepRow[]
    ).map(mapJobStep);
  }

  #requireJob(jobId: string): Job {
    const job = this.getById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }
    return job;
  }
}
