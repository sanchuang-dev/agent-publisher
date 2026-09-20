import {
  SessionManager,
  SettingsManager,
  createAgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

export type PiSdkSessionErrorCode =
  | "PI_SESSION_INITIALIZATION_FAILED"
  | "PI_SESSION_RUN_FAILED"
  | "PI_SESSION_TIMEOUT";

export class PiSdkSessionError extends Error {
  readonly code: PiSdkSessionErrorCode;

  constructor(code: PiSdkSessionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiSdkSessionError";
    this.code = code;
  }
}

export interface PiSdkToolExecution {
  toolCallId: string;
  toolName: string;
  args: unknown;
  completed: boolean;
  isError: boolean | null;
}

export interface PiSdkRunResult {
  finalText: string;
  eventTypes: string[];
  toolExecutions: PiSdkToolExecution[];
}

export interface RunInMemoryPiSessionInput {
  prompt: string;
  timeoutMs?: number;
  sessionOptions: Omit<CreateAgentSessionOptions, "sessionManager" | "settingsManager">;
}

const DEFAULT_TIMEOUT_MS = 10_000;

class DeadlineExceededError extends Error {}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineExceededError(`Pi session exceeded ${timeoutMs}ms deadline`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Minimal programmatic Pi SDK boundary for AGT-01.
 *
 * It deliberately owns only one in-memory AgentSession lifecycle. AgentDefinition,
 * PiAgentHost, Skills/MCP policy, and durable resume belong to later work items.
 */
export async function runInMemoryPiSession(
  input: RunInMemoryPiSessionInput,
): Promise<PiSdkRunResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PiSdkSessionError(
      "PI_SESSION_INITIALIZATION_FAILED",
      "Pi session timeout must be a positive finite number",
    );
  }

  const cwd = input.sessionOptions.cwd ?? process.cwd();
  const creation = createAgentSession({
    ...input.sessionOptions,
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
  });

  let created: Awaited<ReturnType<typeof createAgentSession>>;
  try {
    created = await withDeadline(creation, timeoutMs);
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      void creation.then(
        ({ session }) => session.dispose(),
        () => undefined,
      );
      throw new PiSdkSessionError(
        "PI_SESSION_TIMEOUT",
        `Pi session initialization exceeded ${timeoutMs}ms`,
        { cause: error },
      );
    }

    throw new PiSdkSessionError(
      "PI_SESSION_INITIALIZATION_FAILED",
      `Pi session initialization failed: ${toMessage(error)}`,
      { cause: error },
    );
  }

  const { session } = created;
  const eventTypes: string[] = [];
  const toolExecutions = new Map<string, PiSdkToolExecution>();
  let finalText = "";

  const unsubscribe = session.subscribe((event) => {
    eventTypes.push(event.type);

    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      finalText += event.assistantMessageEvent.delta;
      return;
    }

    if (event.type === "tool_execution_start") {
      toolExecutions.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        completed: false,
        isError: null,
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const previous = toolExecutions.get(event.toolCallId);
      toolExecutions.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: previous?.args,
        completed: true,
        isError: event.isError,
      });
    }
  });

  let result: PiSdkRunResult | undefined;
  try {
    try {
      await withDeadline(session.prompt(input.prompt), timeoutMs);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        throw new PiSdkSessionError(
          "PI_SESSION_TIMEOUT",
          `Pi session run exceeded ${timeoutMs}ms`,
          { cause: error },
        );
      }

      throw new PiSdkSessionError(
        "PI_SESSION_RUN_FAILED",
        `Pi session run failed: ${toMessage(error)}`,
        { cause: error },
      );
    }

    result = {
      finalText,
      eventTypes: [...eventTypes],
      toolExecutions: [...toolExecutions.values()],
    };
  } finally {
    unsubscribe();
    session.dispose();
  }

  return result;
}
