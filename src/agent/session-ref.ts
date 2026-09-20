declare const agentSessionRefBrand: unique symbol;

/**
 * Publisher-owned opaque reference for binding a Job/role to an Agent session.
 *
 * Callers may persist and compare it, but only the AgentHost implementation
 * interprets the backing session identity.
 */
export type AgentSessionRef = string & {
  readonly [agentSessionRefBrand]: "AgentSessionRef";
};

export function asAgentSessionRef(value: string): AgentSessionRef {
  return value as AgentSessionRef;
}

const PI_SESSION_REF_PREFIX = "pi-session:v1:";

export function createPiAgentSessionRef(sessionId: string): AgentSessionRef {
  if (sessionId.trim().length === 0) {
    throw new Error("Pi session id must not be empty");
  }

  return asAgentSessionRef(`${PI_SESSION_REF_PREFIX}${sessionId}`);
}

export function parsePiAgentSessionRef(ref: AgentSessionRef): string | null {
  if (!ref.startsWith(PI_SESSION_REF_PREFIX)) {
    return null;
  }

  const sessionId = ref.slice(PI_SESSION_REF_PREFIX.length);
  return sessionId.length > 0 ? sessionId : null;
}
