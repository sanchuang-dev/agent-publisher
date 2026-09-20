declare const agentSessionRefBrand: unique symbol;

/**
 * Publisher-owned opaque reference for binding a Job/role to an Agent session.
 *
 * It intentionally does not expose a Pi session identifier. Durable persistence
 * and process-restart resume are defined by a later work item.
 */
export type AgentSessionRef = string & {
  readonly [agentSessionRefBrand]: "AgentSessionRef";
};

export function asAgentSessionRef(value: string): AgentSessionRef {
  return value as AgentSessionRef;
}
