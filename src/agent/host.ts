import type {
  AgentDefinition,
  AgentSessionScope,
  AgentTaskInput,
  AgentTaskResult,
  CreatePublisherAgentSessionInput,
  ResumePublisherAgentSessionInput,
} from "./definition.js";
import type { AgentSessionRef } from "./session-ref.js";

export type AgentSessionErrorCode =
  | "AGENT_SESSION_INITIALIZATION_FAILED"
  | "AGENT_SESSION_RUN_FAILED"
  | "AGENT_SESSION_TIMEOUT"
  | "AGENT_SESSION_ABORT_UNCONFIRMED"
  | "AGENT_SESSION_BUSY"
  | "AGENT_SESSION_DISPOSED"
  | "AGENT_SESSION_SHUTDOWN_FAILED"
  | "AGENT_SESSION_DISPOSE_FAILED"
  | "AGENT_SESSION_NOT_FOUND"
  | "AGENT_SESSION_INCOMPATIBLE"
  | "AGENT_SESSION_RESUME_FAILED";

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
  /**
   * True only when sessions created by this host can be recovered after a
   * process restart using their opaque AgentSessionRef.
   */
  readonly supportsDurableResume: boolean;

  createSession(
    input: CreatePublisherAgentSessionInput,
  ): Promise<PublisherAgentSession>;

  resumeSession(
    input: ResumePublisherAgentSessionInput,
  ): Promise<PublisherAgentSession>;
}
