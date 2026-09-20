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
  | "AGENT_SESSION_BUSY"
  | "AGENT_SESSION_DISPOSED";

interface AgentSessionErrorOptions extends ErrorOptions {
  /**
   * Whether the local Pi prompt promise is known to have settled.
   * This never asserts that an external tool side effect did not occur.
   */
  readonly runStopped?: boolean | null;
  readonly partialResult?: AgentTaskResult | null;
}

export class AgentSessionError extends Error {
  readonly code: AgentSessionErrorCode;
  readonly runStopped: boolean | null;
  readonly partialResult: AgentTaskResult | null;

  constructor(
    code: AgentSessionErrorCode,
    message: string,
    options: AgentSessionErrorOptions = {},
  ) {
    super(message, options);
    this.name = "AgentSessionError";
    this.code = code;
    this.runStopped = options.runStopped ?? null;
    this.partialResult = options.partialResult ?? null;
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
