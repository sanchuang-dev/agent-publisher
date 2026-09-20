import { JobNotFoundError } from "../contracts/job.js";
import {
  AgentSessionBindingConflictError,
  AgentSessionBindingNotFoundError,
  type AgentSessionBinding,
  type AgentSessionBindingRepository as AgentSessionBindingRepositoryContract,
  type BindAgentSessionInput,
  type ReplaceAgentSessionBindingInput,
} from "../agent/job-session-binding.js";
import { asAgentSessionRef, type AgentSessionRef } from "../agent/session-ref.js";

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

interface BindingRow {
  job_id: string;
  role: string;
  definition_id: string;
  session_ref: string;
  created_at: string;
  updated_at: string;
}

function mapBinding(row: BindingRow): AgentSessionBinding {
  return {
    jobId: row.job_id,
    role: row.role,
    definitionId: row.definition_id,
    sessionRef: asAgentSessionRef(row.session_ref),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AgentSessionBindingRepository
  implements AgentSessionBindingRepositoryContract
{
  readonly #db: DatabaseHandle;

  constructor(db: DatabaseHandle) {
    this.#db = db;
  }

  bind(input: BindAgentSessionInput): AgentSessionBinding {
    const scope = input.scope;
    this.#assertBindingInput(input);

    const commit = this.#db.transaction(() => {
      this.#requireJob(scope.jobId);

      const existingScope = this.getForScope(scope);
      if (existingScope) {
        if (
          existingScope.definitionId === input.definitionId &&
          existingScope.sessionRef === input.sessionRef
        ) {
          return existingScope;
        }

        throw new AgentSessionBindingConflictError(
          `Job ${scope.jobId} role ${scope.role} is already bound to ${existingScope.sessionRef}`,
        );
      }

      this.#assertRefAvailable(input.sessionRef, scope.jobId, scope.role);

      const now = new Date().toISOString();
      this.#db
        .prepare(
          `INSERT INTO agent_session_bindings (
            job_id, role, definition_id, session_ref, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.jobId,
          scope.role,
          input.definitionId,
          input.sessionRef,
          now,
          now,
        );

      return this.#requireForScope(scope.jobId, scope.role);
    });

    return commit();
  }

  replace(input: ReplaceAgentSessionBindingInput): AgentSessionBinding {
    const scope = input.scope;
    this.#assertBindingInput(input);

    const commit = this.#db.transaction(() => {
      this.#requireJob(scope.jobId);
      const existing = this.getForScope(scope);
      if (!existing) {
        throw new AgentSessionBindingNotFoundError(scope);
      }
      if (existing.sessionRef !== input.expectedSessionRef) {
        throw new AgentSessionBindingConflictError(
          `AgentSession binding for ${scope.jobId}/${scope.role} changed from expected ${input.expectedSessionRef} to ${existing.sessionRef}`,
        );
      }

      if (
        existing.sessionRef === input.sessionRef &&
        existing.definitionId === input.definitionId
      ) {
        return existing;
      }

      this.#assertRefAvailable(input.sessionRef, scope.jobId, scope.role);

      const now = new Date().toISOString();
      const result = this.#db
        .prepare(
          `UPDATE agent_session_bindings
           SET definition_id = ?, session_ref = ?, updated_at = ?
           WHERE job_id = ? AND role = ? AND session_ref = ?`,
        )
        .run(
          input.definitionId,
          input.sessionRef,
          now,
          scope.jobId,
          scope.role,
          input.expectedSessionRef,
        );

      if (result.changes !== 1) {
        throw new AgentSessionBindingConflictError(
          `AgentSession binding replacement lost a concurrent update for ${scope.jobId}/${scope.role}`,
        );
      }

      return this.#requireForScope(scope.jobId, scope.role);
    });

    return commit();
  }

  getForScope(scope: { readonly jobId: string; readonly role: string }): AgentSessionBinding | null {
    const row = this.#db
      .prepare(
        `SELECT job_id, role, definition_id, session_ref, created_at, updated_at
         FROM agent_session_bindings
         WHERE job_id = ? AND role = ?`,
      )
      .get(scope.jobId, scope.role) as BindingRow | undefined;

    return row ? mapBinding(row) : null;
  }

  getByRef(ref: AgentSessionRef): AgentSessionBinding | null {
    const row = this.#db
      .prepare(
        `SELECT job_id, role, definition_id, session_ref, created_at, updated_at
         FROM agent_session_bindings
         WHERE session_ref = ?`,
      )
      .get(ref) as BindingRow | undefined;

    return row ? mapBinding(row) : null;
  }

  #assertBindingInput(input: BindAgentSessionInput): void {
    const scope = input.scope;
    if (scope.jobId.trim().length === 0 || scope.role.trim().length === 0) {
      throw new AgentSessionBindingConflictError(
        "AgentSession binding requires non-empty jobId and role",
      );
    }
    if (input.definitionId.trim().length === 0) {
      throw new AgentSessionBindingConflictError(
        "AgentSession binding requires a non-empty definitionId",
      );
    }
  }

  #assertRefAvailable(
    ref: AgentSessionRef,
    jobId: string,
    role: string,
  ): void {
    const existingRef = this.getByRef(ref);
    if (
      existingRef &&
      (existingRef.jobId !== jobId || existingRef.role !== role)
    ) {
      throw new AgentSessionBindingConflictError(
        `AgentSession ${ref} is already bound to ${existingRef.jobId}/${existingRef.role}`,
      );
    }
  }

  #requireJob(jobId: string): void {
    if (!this.#db.prepare("SELECT id FROM jobs WHERE id = ?").get(jobId)) {
      throw new JobNotFoundError(jobId);
    }
  }

  #requireForScope(jobId: string, role: string): AgentSessionBinding {
    const binding = this.getForScope({ jobId, role });
    if (!binding) {
      throw new Error(
        `AgentSession binding write did not persist for ${jobId}/${role}`,
      );
    }
    return binding;
  }
}
