import { JobNotFoundError } from "../contracts/job.js";
import {
  AgentSessionBindingConflictError,
  type AgentSessionBinding,
  type AgentSessionBindingRepository as AgentSessionBindingRepositoryContract,
  type BindAgentSessionInput,
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

    const commit = this.#db.transaction(() => {
      if (!this.#db.prepare("SELECT id FROM jobs WHERE id = ?").get(scope.jobId)) {
        throw new JobNotFoundError(scope.jobId);
      }

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

      const existingRef = this.getByRef(input.sessionRef);
      if (existingRef) {
        throw new AgentSessionBindingConflictError(
          `AgentSession ${input.sessionRef} is already bound to ${existingRef.jobId}/${existingRef.role}`,
        );
      }

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

  #requireForScope(jobId: string, role: string): AgentSessionBinding {
    const binding = this.getForScope({ jobId, role });
    if (!binding) {
      throw new Error(
        `AgentSession binding insert did not persist for ${jobId}/${role}`,
      );
    }
    return binding;
  }
}
