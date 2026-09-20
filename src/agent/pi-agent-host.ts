import { randomUUID } from "node:crypto";

import {
  SessionManager,
  SettingsManager,
  createAgentSession,
  type CreateAgentSessionOptions,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import type {
  AgentDefinition,
  AgentSessionScope,
  AgentTaskInput,
  AgentTaskResult,
  AgentToolExecutionEvidence,
  CreatePublisherAgentSessionInput,
} from "./definition.js";
import {
  AgentSessionError,
  type AgentHost,
  type PublisherAgentSession,
} from "./host.js";
import { asAgentSessionRef, type AgentSessionRef } from "./session-ref.js";

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
}

export interface PiAgentHostOptions {
  readonly model: NonNullable<CreateAgentSessionOptions["model"]>;
  readonly modelRuntime: NonNullable<CreateAgentSessionOptions["modelRuntime"]>;
  readonly createResourceLoader: (
    input: PiResourceLoaderFactoryInput,
  ) => ResourceLoader;
  readonly tools?: readonly string[];
  readonly sessionOptions?: PiHostSessionOptions;
  readonly cwd?: string;
  readonly initializationTimeoutMs?: number;
  readonly defaultRunTimeoutMs: number;
  readonly defaultAbortTimeoutMs?: number;
}

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000;
const DEFAULT_ABORT_TIMEOUT_MS = 1_000;

class DeadlineExceededError extends Error {}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeDispose(session: PiAgentSession): void {
  try {
    session.dispose();
  } catch {
    // Cleanup after a settled or abandoned session is best-effort.
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

  constructor(
    private readonly session: PiAgentSession,
    definition: AgentDefinition,
    scope: AgentSessionScope,
    private readonly defaultRunTimeoutMs: number,
    private readonly defaultAbortTimeoutMs: number,
  ) {
    this.ref = asAgentSessionRef(`agent-session:${randomUUID()}`);
    this.definition = definition;
    this.scope = scope;
  }

  #invalidate(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    safeDispose(this.session);
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
      let promptSettlementBeforeAbort: PromptSettlement | null = null;
      void promptTask.then(
        () => {
          promptSettlementBeforeAbort = { status: "fulfilled" };
        },
        (reason: unknown) => {
          promptSettlementBeforeAbort = { status: "rejected", reason };
        },
      );

      try {
        await withDeadline(promptTask, timeoutMs);
      } catch (error) {
        if (error instanceof DeadlineExceededError) {
          // Flush already-queued prompt settlement/message events before asking
          // Pi to abort. Only a prompt that genuinely completed before the abort
          // request may be recovered as success.
          await Promise.resolve();
          if (
            promptSettlementBeforeAbort?.status === "fulfilled" &&
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
          this.#invalidate();

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
        this.#invalidate();
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
    this.#invalidate();
  }
}

export class PiAgentHost implements AgentHost {
  readonly #options: PiAgentHostOptions;

  constructor(options: PiAgentHostOptions) {
    const initializationTimeoutMs =
      options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
    const defaultRunTimeoutMs = options.defaultRunTimeoutMs;
    const defaultAbortTimeoutMs =
      options.defaultAbortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;

    assertPositiveFinite(
      initializationTimeoutMs,
      "Agent session initialization timeout",
    );
    assertPositiveFinite(defaultRunTimeoutMs, "Agent session run timeout");
    assertPositiveFinite(
      defaultAbortTimeoutMs,
      "Agent session abort timeout",
    );

    this.#options = {
      ...options,
      initializationTimeoutMs,
      defaultRunTimeoutMs,
      defaultAbortTimeoutMs,
    };
  }

  async createSession(
    input: CreatePublisherAgentSessionInput,
  ): Promise<PublisherAgentSession> {
    assertSessionConfigNonEmpty(input.definition.id, "Agent definition id");
    assertSessionConfigNonEmpty(
      input.definition.systemPrompt,
      "Agent system prompt",
    );
    assertSessionConfigNonEmpty(input.scope.jobId, "Agent session job id");
    assertSessionConfigNonEmpty(input.scope.role, "Agent session role");

    const cwd = this.#options.cwd ?? process.cwd();
    const resourceLoader = this.#options.createResourceLoader({
      definition: input.definition,
      scope: input.scope,
      systemPrompt: input.definition.systemPrompt.trim(),
    });

    const creation = createAgentSession({
      ...this.#options.sessionOptions,
      cwd,
      model: this.#options.model,
      modelRuntime: this.#options.modelRuntime,
      resourceLoader,
      tools: [...(this.#options.tools ?? [])],
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory(),
    });

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
          ({ session }) => safeDispose(session),
          () => undefined,
        );
      }

      throw new AgentSessionError(
        "AGENT_SESSION_INITIALIZATION_FAILED",
        `Agent session initialization failed: ${toMessage(error)}`,
        { cause: error },
      );
    }

    return new PiPublisherAgentSession(
      created.session,
      input.definition,
      input.scope,
      this.#options.defaultRunTimeoutMs,
      this.#options.defaultAbortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS,
    );
  }
}
