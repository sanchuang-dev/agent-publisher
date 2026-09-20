import {
  SessionManager,
  SettingsManager,
  createAgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

export type PiSdkSessionErrorCode =
  | "PI_SESSION_INITIALIZATION_FAILED"
  | "PI_SESSION_RUN_FAILED"
  | "PI_SESSION_TIMEOUT"
  | "PI_SESSION_ABORT_UNCONFIRMED";

interface PiSdkSessionErrorOptions extends ErrorOptions {
  runStopped?: boolean | null;
}

export class PiSdkSessionError extends Error {
  readonly code: PiSdkSessionErrorCode;
  readonly runStopped: boolean | null;

  constructor(
    code: PiSdkSessionErrorCode,
    message: string,
    options: PiSdkSessionErrorOptions = {},
  ) {
    super(message, options);
    this.name = "PiSdkSessionError";
    this.code = code;
    this.runStopped = options.runStopped ?? null;
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
  abortTimeoutMs?: number;
  sessionOptions: Omit<CreateAgentSessionOptions, "sessionManager" | "settingsManager">;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ABORT_TIMEOUT_MS = 1_000;

class DeadlineExceededError extends Error {}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeDispose(session: { dispose(): void }): void {
  try {
    session.dispose();
  } catch {
    // Cleanup is best-effort after the run has either settled or been abandoned.
  }
}

function assertPositiveDeadline(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PiSdkSessionError(
      "PI_SESSION_INITIALIZATION_FAILED",
      `${label} must be a positive finite number`,
    );
  }
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

async function stopTimedOutRun(
  promptTask: Promise<void>,
  session: { abort(): Promise<void> },
  abortTimeoutMs: number,
): Promise<boolean> {
  const promptSettled = promptTask.then(
    () => undefined,
    () => undefined,
  );

  try {
    await withDeadline(
      Promise.all([session.abort(), promptSettled]).then(() => undefined),
      abortTimeoutMs,
    );
    return true;
  } catch {
    return false;
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
  const abortTimeoutMs = input.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
  assertPositiveDeadline(timeoutMs, "Pi session timeout");
  assertPositiveDeadline(abortTimeoutMs, "Pi session abort timeout");

  const deadline = createDeadline(timeoutMs);
  const cwd = input.sessionOptions.cwd ?? process.cwd();
  const creation = createAgentSession({
    ...input.sessionOptions,
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory(),
  });

  let created: Awaited<ReturnType<typeof createAgentSession>>;
  try {
    created = await withDeadline(creation, deadline);
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      void creation.then(
        ({ session }) => safeDispose(session),
        () => undefined,
      );
      throw new PiSdkSessionError(
        "PI_SESSION_TIMEOUT",
        `Pi session initialization exceeded ${timeoutMs}ms`,
        { cause: error, runStopped: null },
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

    if (event.type === "message_end" && event.message.role === "assistant") {
      finalText = event.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
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

  try {
    const promptTask = session.prompt(input.prompt);

    try {
      await withDeadline(promptTask, timeoutMs);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        const runStopped = await stopTimedOutRun(promptTask, session, abortTimeoutMs);
        if (!runStopped) {
          throw new PiSdkSessionError(
            "PI_SESSION_ABORT_UNCONFIRMED",
            `Pi session exceeded ${timeoutMs}ms and did not confirm stop within ${abortTimeoutMs}ms`,
            { cause: error, runStopped: false },
          );
        }

        throw new PiSdkSessionError(
          "PI_SESSION_TIMEOUT",
          `Pi session run exceeded ${timeoutMs}ms and was stopped`,
          { cause: error, runStopped: true },
        );
      }

      throw new PiSdkSessionError(
        "PI_SESSION_RUN_FAILED",
        `Pi session run failed: ${toMessage(error)}`,
        { cause: error, runStopped: true },
      );
    }

    return {
      finalText,
      eventTypes: [...eventTypes],
      toolExecutions: [...toolExecutions.values()],
    };
  } finally {
    unsubscribe();
    safeDispose(session);
  }
}
