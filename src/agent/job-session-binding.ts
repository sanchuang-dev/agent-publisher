import type { AgentSessionScope } from "./definition.js";
import type { AgentSessionRef } from "./session-ref.js";

export interface AgentSessionBinding {
  readonly jobId: string;
  readonly role: string;
  readonly definitionId: string;
  readonly sessionRef: AgentSessionRef;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BindAgentSessionInput {
  readonly scope: AgentSessionScope;
  readonly definitionId: string;
  readonly sessionRef: AgentSessionRef;
}

export interface AgentSessionBindingRepository {
  bind(input: BindAgentSessionInput): AgentSessionBinding;
  getForScope(scope: AgentSessionScope): AgentSessionBinding | null;
  getByRef(ref: AgentSessionRef): AgentSessionBinding | null;
}

export class AgentSessionBindingNotFoundError extends Error {
  constructor(readonly scope: AgentSessionScope) {
    super(
      `No durable AgentSession binding for job ${scope.jobId} role ${scope.role}`,
    );
    this.name = "AgentSessionBindingNotFoundError";
  }
}

export class AgentSessionBindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSessionBindingConflictError";
  }
}

export class AgentSessionBindingMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSessionBindingMismatchError";
  }
}
