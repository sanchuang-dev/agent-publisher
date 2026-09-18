import {
  ActionRequestNotFoundError,
  ActionRequestStateError,
  JobNotFoundError,
  OpenActionRequestConflictError,
  type ActionRequest,
  type ActionRequestRepository as ActionRequestRepositoryContract,
  type ActionRequestType,
  type JsonValue,
  type OpenActionRequestInput,
} from "../contracts/job.js";

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

interface ActionRequestRow {
  id: string;
  job_id: string;
  type: string;
  status: string;
  payload_json: string | null;
  resolution_json: string | null;
  created_at: string;
  resolved_at: string | null;
}

function mapActionRequest(row: ActionRequestRow): ActionRequest {
  return {
    id: row.id,
    jobId: row.job_id,
    type: row.type as ActionRequest["type"],
    status: row.status as ActionRequest["status"],
    payload: row.payload_json ? (JSON.parse(row.payload_json) as JsonValue) : null,
    resolution: row.resolution_json ? (JSON.parse(row.resolution_json) as JsonValue) : null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

const selectColumns =
  "id, job_id, type, status, payload_json, resolution_json, created_at, resolved_at";

export class ActionRequestRepository implements ActionRequestRepositoryContract {
  readonly #db: DatabaseHandle;

  constructor(db: DatabaseHandle) {
    this.#db = db;
  }

  open(input: OpenActionRequestInput): ActionRequest {
    const openAction = this.#db.transaction(() => {
      this.#requireJob(input.jobId);

      const existing = this.#findCurrentOpenForJob(input.jobId);
      if (existing) {
        if (existing.type === input.type) {
          return existing;
        }

        throw new OpenActionRequestConflictError(input.jobId, existing.type, input.type);
      }

      const now = new Date().toISOString();
      this.#db
        .prepare(
          `INSERT INTO action_requests (
            id, job_id, type, status,
            payload_json, resolution_json,
            created_at, resolved_at
          ) VALUES (?, ?, ?, 'open', ?, NULL, ?, NULL)`,
        )
        .run(input.id, input.jobId, input.type, JSON.stringify(input.payload ?? null), now);

      return this.#requireActionRequest(input.id);
    });

    return openAction();
  }

  getById(id: string): ActionRequest | null {
    const row = this.#db
      .prepare(`SELECT ${selectColumns} FROM action_requests WHERE id = ?`)
      .get(id) as ActionRequestRow | undefined;

    return row ? mapActionRequest(row) : null;
  }

  getCurrentOpenForJob(jobId: string): ActionRequest | null {
    this.#requireJob(jobId);
    return this.#findCurrentOpenForJob(jobId);
  }

  getLatestForJob(jobId: string, type: ActionRequestType): ActionRequest | null {
    this.#requireJob(jobId);

    const row = this.#db
      .prepare(
        `SELECT ${selectColumns}
         FROM action_requests
         WHERE job_id = ? AND type = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(jobId, type) as ActionRequestRow | undefined;

    return row ? mapActionRequest(row) : null;
  }

  resolve(id: string, resolution?: JsonValue | null): ActionRequest {
    return this.#close(id, "resolved", resolution ?? null);
  }

  cancel(id: string, resolution?: JsonValue | null): ActionRequest {
    return this.#close(id, "cancelled", resolution ?? null);
  }

  #close(
    id: string,
    nextStatus: "resolved" | "cancelled",
    resolution: JsonValue | null,
  ): ActionRequest {
    const closeAction = this.#db.transaction(() => {
      const existing = this.#requireActionRequest(id);

      if (existing.status === nextStatus) {
        return existing;
      }

      if (existing.status !== "open") {
        throw new ActionRequestStateError(id, existing.status, nextStatus);
      }

      const now = new Date().toISOString();
      this.#db
        .prepare(
          `UPDATE action_requests
           SET status = ?,
               resolution_json = ?,
               resolved_at = COALESCE(resolved_at, ?)
           WHERE id = ?`,
        )
        .run(nextStatus, JSON.stringify(resolution), now, id);

      return this.#requireActionRequest(id);
    });

    return closeAction();
  }

  #findCurrentOpenForJob(jobId: string): ActionRequest | null {
    const row = this.#db
      .prepare(
        `SELECT ${selectColumns}
         FROM action_requests
         WHERE job_id = ? AND status = 'open'
         LIMIT 1`,
      )
      .get(jobId) as ActionRequestRow | undefined;

    return row ? mapActionRequest(row) : null;
  }

  #requireActionRequest(id: string): ActionRequest {
    const actionRequest = this.getById(id);
    if (!actionRequest) {
      throw new ActionRequestNotFoundError(id);
    }
    return actionRequest;
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
