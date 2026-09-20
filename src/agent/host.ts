import type {
  AgentDefinition,
  AgentSessionScope,
  AgentTaskInput,
  AgentTaskResult,
  CreatePublisherAgentSessionInput,
} from "./definition.js";
import type { AgentSessionRef } from "./session-ref.js";

export type AgentSessionErrorCode =
  | "AGENT_SESSION_INITIALIZATION_FAILED"
  | "AGENT_SESSION_RUN_FAILED"
  | "AGENT_SESSION_TIMEOUT"
  | "AGENT_SESSION_ABORT_UNCONFIRMED"
  | "AGENT_SESSION_DISPOSED";

interface AgentSessionErrorOptions extends ErrorOptions {
  readonly runStopped?: boolean | null;
}

export class AgentSessionError extends Error {
  readonly code: AgentSessionErrorCode;
  readonly runStopped: boolean | null;

  constructor(
    code: AgentSessionErrorCode,
    message: string,
    options: AgentSessionErrorOptions = {},
  ) {
    super(message, options);
    this.name = "AgentSessionError";
    this.code = code;
    this.runStopped = options.runStopped ?? null;
  }
}

export interface PublisherAgentSession {
  readonly ref: AgentSessionRef;
  readonly definition: AgentDefinition;
  readonly scope: AgentSessionScope;

  run(input: AgentTaskInput): Promise<AgentTaskResult>;
  dispose(): Promise<void>;
}

export interface AgentHost {
  createSession(
    input: CreatePublisherAgentSessionInput,
  ): Promise<PublisherAgentSession>;
}
