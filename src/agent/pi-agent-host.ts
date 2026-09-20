import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type CreateAgentSessionOptions,
  type InlineExtension,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import type {
  AgentDefinition,
  AgentSessionScope,
  AgentTaskInput,
  AgentTaskResult,
  AgentToolExecutionEvidence,
  CreatePublisherAgentSessionInput,
  ResumePublisherAgentSessionInput,
} from "./definition.js";
import {
  AgentSessionError,
  type AgentHost,
  type PublisherAgentSession,
} from "./host.js";
import { compilePublisherMcpProfile } from "./pi-mcp.js";
import {
  createPiAgentSessionRef,
  parsePiAgentSessionRef,
  type AgentSessionRef,
} from "./session-ref.js";

type PiAgentSession = Awaited<
  ReturnType<typeof createAgentSession>
>["session"];

type PiHostSessionOptions = Omit<
  CreateAgentSessionOptions,
  | "sessionManager"
  | "settingsManager"
  | "model"
  | "modelRuntime"
  | "resourceLoader"
  | "tools"
  | "cwd"
>;

export interface PiResourceLoaderFactoryInput {
  readonly definition: AgentDefinition;
  readonly scope: AgentSessionScope;
  readonly systemPrompt: string;
  readonly cwd: string;
  readonly allowedTools: readonly string[];
  readonly extensionFactories: readonly InlineExtension[];
}

export interface PiAgentHostOptions {
  readonly model: NonNullable<CreateAgentSessionOptions["model"]>;
  readonly modelRuntime: NonNullable<CreateAgentSessionOptions["modelRuntime"]>;
  readonly createResourceLoader: (
    input: PiResourceLoaderFactoryInput,
  ) => ResourceLoader | Promise<ResourceLoader>;
  readonly tools?: readonly string[];
  readonly sessionOptions?: PiHostSessionOptions;
  readonly cwd?: string;
  /**
   * Explicit Publisher-owned Pi session directory. When omitted, newly created
   * sessions remain in-memory and process-restart resume is unavailable.
   */
  readonly sessionDirectory?: string;
  readonly initializationTimeoutMs?: number;
  readonly defaultRunTimeoutMs: number;
  readonly defaultAbortTimeoutMs?: number;
  readonly defaultDisposeTimeoutMs?: number;
}

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000;
const DEFAULT_ABORT_TIMEOUT_MS = 1_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 2_000;

class DeadlineExceededError extends Error {}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function shutdownAndDispose(
  session: PiAgentSession,
  timeoutMs: number,
): Promise<void> {
  let shutdownError: unknown;
  try {
    await withDeadline(
      session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      }),
      timeoutMs,
    );
  } catch (error) {
    shutdownError = error;
  }

  let disposeError: unknown;
  try {
    session.dispose();
  } catch (error) {
    disposeError = error;
  }

  if (shutdownError !== undefined) throw shutdownError;
  if (disposeError !== undefined) throw disposeError;
}

async function safeDispose(
  session: PiAgentSession,
  timeoutMs: number,
): Promise<void> {
  try {
    await shutdownAndDispose(session, timeoutMs);
  } catch {
    // Initialization/run failure cleanup remains best-effort.
  }
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AgentSessionError(
      "AGENT_SESSION_INITIALIZATION_FAILED",
      `${label} must be a positive finite number`,
    );
  }
}

function assertSessionConfigNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new AgentSessionError(
      "AGENT_SESSION_INITIALIZATION_FAILED",
      `${label} must not be empty`,
    );
  }
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) {
    throw new DeadlineExceededError("Agent session deadline exceeded");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineExceededError("Agent session deadline exceeded"));
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

type PromptSettlement =
  | { readonly status: "fulfilled" }
  | { readonly status: "rejected"; readonly reason: unknown };

function observePromptSettlement(
  promptTask: Promise<void>,
): () => PromptSettlement | null {
  let settlement: PromptSettlement | null = null;
  void promptTask.then(
    () => {
      settlement = { status: "fulfilled" };
    },
    (reason: unknown) => {
      settlement = { status: "rejected", reason };
    },
  );
  return () => settlement;
}

async function settleTimedOutRun(
  promptTask: Promise<void>,
  session: PiAgentSession,
  abortTimeoutMs: number,
): Promise<PromptSettlement | null> {
  const settlement: Promise<PromptSettlement> = promptTask.then(
    (): PromptSettlement => ({ status: "fulfilled" }),
    (reason: unknown): PromptSettlement => ({
      status: "rejected",
      reason,
    }),
  );

  // Abort is a best-effort request. The prompt promise settling is the
  // evidence that local execution stopped; neither signal proves that an
  // already-completed external side effect did not occur.
  void session.abort().catch(() => undefined);

  try {
    return await withDeadline(settlement, abortTimeoutMs);
  } catch {
    return null;
  }
}

class PiPublisherAgentSession implements PublisherAgentSession {
  readonly ref: AgentSessionRef;
  readonly definition: AgentDefinition;
  readonly scope: AgentSessionScope;

  #disposed = false;
  #running = false;
  #disposeTask: Promise<void> | null = null;

  constructor(
    private readonly session: PiAgentSession,
    ref: AgentSessionRef,
    definition: AgentDefinition,
    scope: AgentSessionScope,
    private readonly defaultRunTimeoutMs: number,
    private readonly defaultAbortTimeoutMs: number,
    private readonly defaultDisposeTimeoutMs: number,
  ) {
    this.ref = ref;
    this.definition = definition;
    this.scope = scope;
  }

  async #invalidate(reportFailure = false): Promise<void> {
    if (!this.#disposeTask) {
      this.#disposed = true;
      this.#disposeTask = shutdownAndDispose(
        this.session,
        this.defaultDisposeTimeoutMs,
      );
    }

    try {
      await this.#disposeTask;
    } catch (error) {
      if (reportFailure) {
        throw new AgentSessionError(
          "AGENT_SESSION_DISPOSE_FAILED",
          `Agent session disposal failed: ${toMessage(error)}`,
          { cause: error, runStopped: true },
        );
      }
    }
  }

  async run(input: AgentTaskInput): Promise<AgentTaskResult> {
    if (this.#disposed) {
      throw new AgentSessionError(
        "AGENT_SESSION_DISPOSED",
        `Agent session ${this.ref} has already been disposed`,
        { runStopped: true },
      );
    }

    if (this.#running) {
      throw new AgentSessionError(
        "AGENT_SESSION_BUSY",
        `Agent session ${this.ref} already has a run in progress`,
        { runStopped: false },
      );
    }

    if (input.prompt.trim().length === 0) {
      throw new AgentSessionError(
        "AGENT_SESSION_RUN_FAILED",
        "Agent task prompt must not be empty",
        { runStopped: true },
      );
    }

    const timeoutMs = input.timeoutMs ?? this.defaultRunTimeoutMs;
    const abortTimeoutMs =
      input.abortTimeoutMs ?? this.defaultAbortTimeoutMs;

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new AgentSessionError(
        "AGENT_SESSION_RUN_FAILED",
        "Agent task timeout must be a positive finite number",
        { runStopped: true },
      );
    }
    if (!Number.isFinite(abortTimeoutMs) || abortTimeoutMs <= 0) {
      throw new AgentSessionError(
        "AGENT_SESSION_RUN_FAILED",
        "Agent task abort timeout must be a positive finite number",
        { runStopped: true },
      );
    }

    const eventTypes: string[] = [];
    const toolExecutions = new Map<string, AgentToolExecutionEvidence>();
    let finalText = "";
    let finalAssistantMessageObserved = false;

    const snapshotResult = (): AgentTaskResult => ({
      finalText,
      eventTypes: [...eventTypes],
      toolExecutions: [...toolExecutions.values()],
    });

    const unsubscribe = this.session.subscribe((event) => {
      eventTypes.push(event.type);

      if (
        event.type === "message_end" &&
        event.message.role === "assistant"
      ) {
        finalAssistantMessageObserved = true;
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

    this.#running = true;

    try {
      const promptTask = this.session.prompt(input.prompt);
      const getPromptSettlement = observePromptSettlement(promptTask);

      try {
        await withDeadline(promptTask, timeoutMs);
      } catch (error) {
        if (error instanceof DeadlineExceededError) {
          // Flush already-queued prompt settlement/message events before asking
          // Pi to abort. Only a prompt that genuinely completed before the abort
          // request may be recovered as success.
          await Promise.resolve();
          const settlementBeforeAbort = getPromptSettlement();
          if (
            settlementBeforeAbort?.status === "fulfilled" &&
            finalAssistantMessageObserved
          ) {
            return snapshotResult();
          }

          const settlementAfterAbort = await settleTimedOutRun(
            promptTask,
            this.session,
            abortTimeoutMs,
          );
          const partialResult = snapshotResult();
          await this.#invalidate();

          if (!settlementAfterAbort) {
            throw new AgentSessionError(
              "AGENT_SESSION_ABORT_UNCONFIRMED",
              `Agent session exceeded the ${timeoutMs}ms run deadline and did not confirm local prompt settlement within ${abortTimeoutMs}ms`,
              { cause: error, runStopped: false, partialResult },
            );
          }

          throw new AgentSessionError(
            "AGENT_SESSION_TIMEOUT",
            `Agent session exceeded the ${timeoutMs}ms run deadline and local prompt settlement was confirmed`,
            {
              cause:
                settlementAfterAbort.status === "rejected"
                  ? settlementAfterAbort.reason
                  : error,
              runStopped: true,
              partialResult,
            },
          );
        }

        if (error instanceof AgentSessionError) {
          throw error;
        }

        const partialResult = snapshotResult();
        await this.#invalidate();
        throw new AgentSessionError(
          "AGENT_SESSION_RUN_FAILED",
          `Agent session run failed: ${toMessage(error)}`,
          { cause: error, runStopped: null, partialResult },
        );
      }

      return snapshotResult();
    } finally {
      this.#running = false;
      unsubscribe();
    }
  }

  async dispose(): Promise<void> {
    await this.#invalidate(true);
  }
}

function buildSessionSystemPrompt(
  input: CreatePublisherAgentSessionInput,
): string {
  const stablePrompt = input.definition.systemPrompt.trim();
  const dynamicContext = input.context?.trim();

  return dynamicContext
    ? `${stablePrompt}\n\n${dynamicContext}`
    : stablePrompt;
}

export class PiAgentHost implements AgentHost {
  readonly #options: PiAgentHostOptions;

  get supportsDurableResume(): boolean {
    return Boolean(this.#options.sessionDirectory);
  }

  constructor(options: PiAgentHostOptions) {
    const initializationTimeoutMs =
      options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
    const defaultRunTimeoutMs = options.defaultRunTimeoutMs;
    const defaultAbortTimeoutMs =
      options.defaultAbortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
    const defaultDisposeTimeoutMs =
      options.defaultDisposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;

    assertPositiveFinite(
      initializationTimeoutMs,
      "Agent session initialization timeout",
    );
    assertPositiveFinite(defaultRunTimeoutMs, "Agent session run timeout");
    assertPositiveFinite(
      defaultAbortTimeoutMs,
      "Agent session abort timeout",
    );
    assertPositiveFinite(
      defaultDisposeTimeoutMs,
      "Agent session dispose timeout",
    );

    this.#options = {
      ...options,
      initializationTimeoutMs,
      defaultRunTimeoutMs,
      defaultAbortTimeoutMs,
      defaultDisposeTimeoutMs,
    };
  }

  async createSession(
    input: CreatePublisherAgentSessionInput,
  ): Promise<PublisherAgentSession> {
    this.#assertInput(input);

    const cwd = this.#options.cwd ?? process.cwd();
    let sessionManager: SessionManager;
    let ref: AgentSessionRef;
    try {
      sessionManager = this.#options.sessionDirectory
        ? SessionManager.create(cwd, this.#options.sessionDirectory)
        : SessionManager.inMemory(cwd);
      ref = createPiAgentSessionRef(sessionManager.getSessionId());
    } catch (error) {
      throw new AgentSessionError(
        "AGENT_SESSION_INITIALIZATION_FAILED",
        `Agent session persistence initialization failed: ${toMessage(error)}`,
        { cause: error, runStopped: true },
      );
    }

    return this.#createWithSessionManager(
      input,
      sessionManager,
      ref,
      "AGENT_SESSION_INITIALIZATION_FAILED",
      "initialization",
    );
  }

  async resumeSession(
    input: ResumePublisherAgentSessionInput,
  ): Promise<PublisherAgentSession> {
    this.#assertInput(input);

    const sessionDirectory = this.#options.sessionDirectory;
    if (!sessionDirectory) {
      throw new AgentSessionError(
        "AGENT_SESSION_RESUME_FAILED",
        "Pi session resume requires an explicit Publisher session directory",
        { runStopped: true },
      );
    }

    const sessionId = parsePiAgentSessionRef(input.ref);
    if (!sessionId) {
      throw new AgentSessionError(
        "AGENT_SESSION_INCOMPATIBLE",
        `Agent session reference is not compatible with this Pi host: ${input.ref}`,
        { runStopped: true },
      );
    }

    const cwd = this.#options.cwd ?? process.cwd();
    let info: Awaited<ReturnType<typeof SessionManager.list>>[number] | undefined;
    try {
      const sessions = await SessionManager.list(cwd, sessionDirectory);
      info = sessions.find((candidate) => candidate.id === sessionId);
    } catch (error) {
      throw new AgentSessionError(
        "AGENT_SESSION_RESUME_FAILED",
        `Failed to discover persisted Pi session ${input.ref}: ${toMessage(error)}`,
        { cause: error, runStopped: true },
      );
    }

    if (!info) {
      throw new AgentSessionError(
        "AGENT_SESSION_NOT_FOUND",
        `Persisted Pi session is missing or unreadable: ${input.ref}`,
        { runStopped: true },
      );
    }

    let sessionManager: SessionManager;
    try {
      sessionManager = SessionManager.open(
        info.path,
        sessionDirectory,
        cwd,
      );
    } catch (error) {
      throw new AgentSessionError(
        "AGENT_SESSION_RESUME_FAILED",
        `Persisted Pi session could not be opened: ${input.ref}: ${toMessage(error)}`,
        { cause: error, runStopped: true },
      );
    }

    const header = sessionManager.getHeader();
    const persistedVersion = header?.version ?? 1;
    if (
      !header ||
      header.id !== sessionId ||
      persistedVersion > CURRENT_SESSION_VERSION
    ) {
      throw new AgentSessionError(
        "AGENT_SESSION_INCOMPATIBLE",
        `Persisted Pi session is incompatible with @earendil-works/pi-coding-agent 0.85.1: ${input.ref}`,
        { runStopped: true },
      );
    }

    return this.#createWithSessionManager(
      input,
      sessionManager,
      input.ref,
      "AGENT_SESSION_RESUME_FAILED",
      "resume",
    );
  }

  #assertInput(input: CreatePublisherAgentSessionInput): void {
    assertSessionConfigNonEmpty(input.definition.id, "Agent definition id");
    assertSessionConfigNonEmpty(
      input.definition.systemPrompt,
      "Agent system prompt",
    );
    assertSessionConfigNonEmpty(input.scope.jobId, "Agent session job id");
    assertSessionConfigNonEmpty(input.scope.role, "Agent session role");
  }

  async #createWithSessionManager(
    input: CreatePublisherAgentSessionInput,
    sessionManager: SessionManager,
    ref: AgentSessionRef,
    failureCode:
      | "AGENT_SESSION_INITIALIZATION_FAILED"
      | "AGENT_SESSION_RESUME_FAILED",
    operation: "initialization" | "resume",
  ): Promise<PublisherAgentSession> {
    const cwd = this.#options.cwd ?? process.cwd();
    let mcp;
    try {
      mcp = compilePublisherMcpProfile(input.definition.mcp);
    } catch (error) {
      throw new AgentSessionError(
        failureCode,
        `Agent MCP profile is invalid during ${operation}: ${toMessage(error)}`,
        { cause: error, runStopped: true },
      );
    }

    const allowedTools = [
      ...new Set([
        ...(this.#options.tools ?? []),
        ...mcp.toolNames,
      ]),
    ];
    const systemPrompt = buildSessionSystemPrompt(input);
    const creation = (async () => {
      const resourceLoader = await this.#options.createResourceLoader({
        definition: input.definition,
        scope: input.scope,
        systemPrompt,
        cwd,
        allowedTools,
        extensionFactories: mcp.extensionFactories,
      });

      return createAgentSession({
        ...this.#options.sessionOptions,
        cwd,
        model: this.#options.model,
        modelRuntime: this.#options.modelRuntime,
        resourceLoader,
        tools: allowedTools,
        sessionManager,
        settingsManager: SettingsManager.inMemory(),
      });
    })();

    let created: Awaited<ReturnType<typeof createAgentSession>>;
    try {
      created = await withDeadline(
        creation,
        this.#options.initializationTimeoutMs ??
          DEFAULT_INITIALIZATION_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        void creation.then(
          ({ session }) =>
            safeDispose(
              session,
              this.#options.defaultDisposeTimeoutMs ??
                DEFAULT_DISPOSE_TIMEOUT_MS,
            ),
          () => undefined,
        );
      }

      throw new AgentSessionError(
        failureCode,
        `Agent session ${operation} failed: ${toMessage(error)}`,
        { cause: error, runStopped: true },
      );
    }

    if (created.session.sessionId !== sessionManager.getSessionId()) {
      await safeDispose(
        created.session,
        this.#options.defaultDisposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS,
      );
      throw new AgentSessionError(
        "AGENT_SESSION_INCOMPATIBLE",
        `Pi session identity changed while binding ${ref}`,
        { runStopped: true },
      );
    }

    return new PiPublisherAgentSession(
      created.session,
      ref,
      input.definition,
      input.scope,
      this.#options.defaultRunTimeoutMs,
      this.#options.defaultAbortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS,
      this.#options.defaultDisposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS,
    );
  }
}
