export interface AgentDefinition {
  readonly id: string;
  readonly systemPrompt: string;
}

export interface AgentSessionScope {
  readonly jobId: string;
  readonly role: string;
}

export interface CreatePublisherAgentSessionInput {
  readonly definition: AgentDefinition;
  readonly scope: AgentSessionScope;
  /**
   * Publisher-owned dynamic context for this Job/role.
   *
   * It is model-facing context only. It must never be treated as durable
   * workflow state or approval/evidence.
   */
  readonly context?: string;
}

export interface ResumePublisherAgentSessionInput
  extends CreatePublisherAgentSessionInput {
  readonly ref: import("./session-ref.js").AgentSessionRef;
}

export interface AgentTaskInput {
  readonly prompt: string;
  readonly timeoutMs?: number;
  readonly abortTimeoutMs?: number;
}

export interface AgentToolExecutionEvidence {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly completed: boolean;
  readonly isError: boolean | null;
}

export interface AgentTaskResult {
  readonly finalText: string;
  readonly eventTypes: readonly string[];
  readonly toolExecutions: readonly AgentToolExecutionEvidence[];
}
