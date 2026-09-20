import {
  ExternalActionIdentityConflictError,
  ExternalActionNotFoundError,
  ExternalActionStateError,
  type CompleteExternalActionInput,
  type ExternalAction,
  type ExternalActionRepository as ExternalActionRepositoryContract,
  type ExternalActionStatus,
  type ExternalActionTerminalStatus,
  type PrepareExternalActionInput,
  type ResolveExternalActionAfterVerificationInput,
} from "../contracts/external-action.js";
import { JobNotFoundError } from "../contracts/job.js";

/**
 * SQLite implementation over the external_actions table owned by the accepted
 * initial-schema migration in src/storage/migrations/index.ts. openDatabase()
 * applies that migration before repositories are constructed.
 */
interface RunResult {
  readonly changes: number;
}

interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
}

interface DatabaseHandle {
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): () => T;
}

interface JobLookupRow {
  id: string;
}

interface ExternalActionRow {
  id: string;
  job_id: string;
  action_type: string;
  action_key: string;
  status: string;
  external_ref: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

const selectColumns = `
  id, job_id, action_type, action_key, status,
  external_ref, started_at, finished_at,
  error_code, error_message, created_at, updated_at
`;

function mapExternalAction(row: ExternalActionRow): ExternalAction {
  return {
    id: row.id,
    jobId: row.job_id,
    actionType: row.action_type,
    actionKey: row.action_key,
    status: row.status as ExternalActionStatus,
    externalRef: row.external_ref,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ExternalActionRepository implements ExternalActionRepositoryContract {
  readonly #db: DatabaseHandle;

  constructor(db: DatabaseHandle) {
    this.#db = db;
  }

  prepare(input: PrepareExternalActionInput): ExternalAction {
    const prepareAction = this.#db.transaction(() => {
      this.#requireJob(input.jobId);

      const now = new Date().toISOString();
      this.#db
        .prepare(
          `INSERT INTO external_actions (
            id, job_id, action_type, action_key, status,
            external_ref, started_at, finished_at,
            error_code, error_message,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'prepared', NULL, NULL, NULL, NULL, NULL, ?, ?)
          ON CONFLICT(job_id, action_key) DO NOTHING`,
        )
        .run(
          input.id,
          input.jobId,
          input.actionType,
          input.actionKey,
          now,
          now,
        );

      const durable = this.getByKey(input.jobId, input.actionKey);
      if (!durable) {
        throw new Error(
          `ExternalAction prepare did not produce durable identity for ${input.jobId}/${input.actionKey}`,
        );
      }

      if (durable.actionType !== input.actionType) {
        throw new ExternalActionIdentityConflictError(
          input.jobId,
          input.actionKey,
          durable.actionType,
          input.actionType,
        );
      }

      return durable;
    });

    return prepareAction();
  }

  getById(id: string): ExternalAction | null {
    const row = this.#db
      .prepare(`SELECT ${selectColumns} FROM external_actions WHERE id = ?`)
      .get(id) as ExternalActionRow | undefined;

    return row ? mapExternalAction(row) : null;
  }

  getByKey(jobId: string, actionKey: string): ExternalAction | null {
    const row = this.#db
      .prepare(
        `SELECT ${selectColumns}
         FROM external_actions
         WHERE job_id = ? AND action_key = ?`,
      )
      .get(jobId, actionKey) as ExternalActionRow | undefined;

    return row ? mapExternalAction(row) : null;
  }

  start(id: string): ExternalAction {
    const transition = this.#db.transaction(() => {
      const current = this.#requireAction(id);
      this.#assertStatus(current, "prepared", "started");

      const now = new Date().toISOString();
      const result = this.#db
        .prepare(
          `UPDATE external_actions
           SET status = 'started',
               started_at = ?,
               updated_at = ?
           WHERE id = ? AND status = 'prepared'`,
        )
        .run(now, now, id);

      if (result.changes !== 1) {
        const latest = this.#requireAction(id);
        throw new ExternalActionStateError(id, latest.status, "started");
      }

      return this.#requireAction(id);
    });

    return transition();
  }

  markSucceeded(
    id: string,
    input: CompleteExternalActionInput = {},
  ): ExternalAction {
    return this.#finish(id, "succeeded", input);
  }

  markUnknown(
    id: string,
    input: CompleteExternalActionInput = {},
  ): ExternalAction {
    return this.#finish(id, "unknown", input);
  }

  markFailed(
    id: string,
    input: CompleteExternalActionInput = {},
  ): ExternalAction {
    return this.#finish(id, "failed", input);
  }

  resolveAfterVerification(
    id: string,
    input: ResolveExternalActionAfterVerificationInput,
  ): ExternalAction {
    const transition = this.#db.transaction(() => {
      const current = this.#requireAction(id);
      if (current.status !== "started" && current.status !== "unknown") {
        throw new ExternalActionStateError(id, current.status, input.status);
      }

      const now = new Date().toISOString();
      const result = this.#db
        .prepare(
          `UPDATE external_actions
           SET status = ?,
               external_ref = ?,
               error_code = ?,
               error_message = ?,
               finished_at = COALESCE(finished_at, ?),
               updated_at = ?
           WHERE id = ? AND status IN ('started', 'unknown')`,
        )
        .run(
          input.status,
          input.externalRef ?? null,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          now,
          now,
          id,
        );

      if (result.changes !== 1) {
        const latest = this.#requireAction(id);
        throw new ExternalActionStateError(id, latest.status, input.status);
      }

      return this.#requireAction(id);
    });

    return transition();
  }

  #finish(
    id: string,
    nextStatus: ExternalActionTerminalStatus,
    input: CompleteExternalActionInput,
  ): ExternalAction {
    const transition = this.#db.transaction(() => {
      const current = this.#requireAction(id);
      this.#assertStatus(current, "started", nextStatus);

      const now = new Date().toISOString();
      const result = this.#db
        .prepare(
          `UPDATE external_actions
           SET status = ?,
               external_ref = ?,
               error_code = ?,
               error_message = ?,
               finished_at = ?,
               updated_at = ?
           WHERE id = ? AND status = 'started'`,
        )
        .run(
          nextStatus,
          input.externalRef ?? null,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          now,
          now,
          id,
        );

      if (result.changes !== 1) {
        const latest = this.#requireAction(id);
        throw new ExternalActionStateError(id, latest.status, nextStatus);
      }

      return this.#requireAction(id);
    });

    return transition();
  }

  #assertStatus(
    action: ExternalAction,
    expectedStatus: ExternalActionStatus,
    requestedStatus: Exclude<ExternalActionStatus, "prepared">,
  ): void {
    if (action.status !== expectedStatus) {
      throw new ExternalActionStateError(
        action.id,
        action.status,
        requestedStatus,
      );
    }
  }

  #requireAction(id: string): ExternalAction {
    const action = this.getById(id);
    if (!action) {
      throw new ExternalActionNotFoundError(id);
    }
    return action;
  }

  #requireJob(jobId: string): string {
    const row = this.#db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId) as
      | JobLookupRow
      | undefined;

    if (!row) {
      throw new JobNotFoundError(jobId);
    }

    return row.id;
  }
}
