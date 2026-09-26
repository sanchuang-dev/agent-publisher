export type AgentMcpServerLifecycle = "lazy" | "eager";

export interface AgentMcpStdioTransport {
  readonly kind: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

export type AgentMcpHttpAuth =
  | { readonly kind: "none" }
  | { readonly kind: "oauth" }
  | { readonly kind: "bearer-env"; readonly env: string };

export interface AgentMcpHttpTransport {
  readonly kind: "http";
  readonly url: string;
  readonly auth?: AgentMcpHttpAuth;
}

export type AgentMcpTransport =
  | AgentMcpStdioTransport
  | AgentMcpHttpTransport;

export interface AgentMcpServerDefinition {
  readonly name: string;
  readonly transport: AgentMcpTransport;
  /**
   * Required fail-closed allowlist. Adapter-side excludeTools may narrow it
   * further but may never widen this list.
   */
  readonly includeTools: readonly string[];
  readonly excludeTools?: readonly string[];
  readonly lifecycle?: AgentMcpServerLifecycle;
}

export interface AgentMcpProfile {
  readonly servers: readonly AgentMcpServerDefinition[];
}

export interface AgentDefinition {
  readonly id: string;
  readonly systemPrompt: string;
  readonly mcp?: AgentMcpProfile;
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
  /**
   * Observational only. Implementations must never let a broken observer
   * change Agent execution or external-side-effect semantics.
   */
  readonly onToolExecution?: (execution: AgentToolExecutionEvidence) => void;
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
