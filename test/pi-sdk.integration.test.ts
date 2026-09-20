import {
  Type,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  createExtensionRuntime,
  defineTool,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

import { runInMemoryPiSession } from "../src/agent/pi-sdk-session.js";

function createNoDiscoveryResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "You are an automated Pi SDK integration probe.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

async function createFauxRuntime(provider: ReturnType<typeof fauxProvider>) {
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  return modelRuntime;
}

function lastToolResult(messages: readonly unknown[]): ToolResultMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as ToolResultMessage | undefined;
    if (message?.role === "toolResult") {
      return message;
    }
  }
  return undefined;
}

describe("Pi SDK in-memory session baseline", () => {
  test("creates, observes, runs a real custom Tool path, and returns only the final assistant text", async () => {
    const faux = fauxProvider({ provider: "publisher-pi-sdk-test" });
    const modelRuntime = await createFauxRuntime(faux);

    const executed: string[] = [];
    const probeTool = defineTool({
      name: "publisher_probe",
      label: "Publisher Probe",
      description: "Returns a deterministic probe result for the Publisher Pi integration test.",
      parameters: Type.Object({
        value: Type.String(),
      }),
      async execute(_toolCallId, params) {
        executed.push(params.value);
        return {
          content: [{ type: "text", text: `probe:${params.value}:pong` }],
          details: { value: params.value },
        };
      },
    });

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxText("I will run the probe before answering."),
          fauxToolCall("publisher_probe", { value: "ping" }, { id: "probe-call-1" }),
        ],
        { stopReason: "toolUse" },
      ),
      (context) => {
        const toolResult = lastToolResult(context.messages);
        const text = toolResult?.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("");

        return fauxAssistantMessage(
          fauxText(text === "probe:ping:pong" ? "PI_PROBE_OK" : "PI_PROBE_BAD"),
        );
      },
    ]);

    const result = await runInMemoryPiSession({
      prompt: "Call publisher_probe exactly once with value ping, then report its result.",
      timeoutMs: 2_000,
      sessionOptions: {
        model: faux.getModel(),
        modelRuntime,
        resourceLoader: createNoDiscoveryResourceLoader(),
        tools: ["publisher_probe"],
        customTools: [probeTool],
        thinkingLevel: "off",
      },
    });

    expect(executed).toEqual(["ping"]);
    expect(result.finalText).toBe("PI_PROBE_OK");
    expect(result.finalText).not.toContain("I will run the probe");
    expect(result.eventTypes).toContain("tool_execution_start");
    expect(result.eventTypes).toContain("tool_execution_end");
    expect(result.toolExecutions).toEqual([
      {
        toolCallId: "probe-call-1",
        toolName: "publisher_probe",
        args: { value: "ping" },
        completed: true,
        isError: false,
      },
    ]);
    expect(faux.state.callCount).toBe(2);
  });

  test("aborts and joins an in-flight Tool before reporting a confirmed run timeout", async () => {
    const faux = fauxProvider({ provider: "publisher-pi-sdk-timeout-test" });
    const modelRuntime = await createFauxRuntime(faux);

    let started = 0;
    let aborted = 0;
    let completed = 0;
    const slowTool = defineTool({
      name: "slow_probe",
      label: "Slow Probe",
      description: "Waits long enough for the runner timeout to abort it.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        started += 1;

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            completed += 1;
            resolve();
          }, 500);

          const onAbort = () => {
            clearTimeout(timer);
            aborted += 1;
            reject(new Error("slow_probe aborted"));
          };

          if (signal?.aborted) {
            onAbort();
          } else {
            signal?.addEventListener("abort", onAbort, { once: true });
          }
        });

        return {
          content: [{ type: "text", text: "unexpected completion" }],
          details: {},
        };
      },
    });

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("slow_probe", {}, { id: "slow-probe-call" }),
        { stopReason: "toolUse" },
      ),
    ]);

    await expect(
      runInMemoryPiSession({
        prompt: "Call slow_probe.",
        timeoutMs: 50,
        abortTimeoutMs: 500,
        sessionOptions: {
          model: faux.getModel(),
          modelRuntime,
          resourceLoader: createNoDiscoveryResourceLoader(),
          tools: ["slow_probe"],
          customTools: [slowTool],
          thinkingLevel: "off",
        },
      }),
    ).rejects.toMatchObject({
      name: "PiSdkSessionError",
      code: "PI_SESSION_TIMEOUT",
      runStopped: true,
    });

    expect(started).toBe(1);
    expect(aborted).toBe(1);
    expect(completed).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(completed).toBe(0);
  });

  test("fails closed when a timed-out provider does not acknowledge abort", async () => {
    const faux = fauxProvider({ provider: "publisher-pi-sdk-uncooperative-test" });
    const modelRuntime = await createFauxRuntime(faux);
    faux.setResponses([
      async () => await new Promise<never>(() => undefined),
    ]);

    const startedAt = Date.now();
    await expect(
      runInMemoryPiSession({
        prompt: "Never completes.",
        timeoutMs: 30,
        abortTimeoutMs: 30,
        sessionOptions: {
          model: faux.getModel(),
          modelRuntime,
          resourceLoader: createNoDiscoveryResourceLoader(),
          tools: [],
          thinkingLevel: "off",
        },
      }),
    ).rejects.toMatchObject({
      name: "PiSdkSessionError",
      code: "PI_SESSION_ABORT_UNCONFIRMED",
      runStopped: false,
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("converts session initialization failures into the application error contract", async () => {
    const faux = fauxProvider({ provider: "publisher-pi-sdk-init-failure-test" });
    const modelRuntime = await createFauxRuntime(faux);
    const brokenLoader = createNoDiscoveryResourceLoader();
    brokenLoader.getExtensions = () => {
      throw new Error("loader exploded");
    };

    await expect(
      runInMemoryPiSession({
        prompt: "This should never run.",
        timeoutMs: 500,
        sessionOptions: {
          model: faux.getModel(),
          modelRuntime,
          resourceLoader: brokenLoader,
          tools: [],
          thinkingLevel: "off",
        },
      }),
    ).rejects.toMatchObject({
      name: "PiSdkSessionError",
      code: "PI_SESSION_INITIALIZATION_FAILED",
      runStopped: null,
    });
  });
});
