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
  test("creates, observes, runs a real custom Tool path, and disposes without CLI/TUI", async () => {
    const faux = fauxProvider({ provider: "publisher-pi-sdk-test" });
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);

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
        fauxToolCall("publisher_probe", { value: "ping" }, { id: "probe-call-1" }),
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

  test("turns a stalled model run into a bounded application timeout", async () => {

    const faux = fauxProvider({ provider: "publisher-pi-sdk-stalled-test" });
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      async () => await new Promise<never>(() => undefined),
    ]);

    const startedAt = Date.now();
    await expect(
      runInMemoryPiSession({
        prompt: "Never completes.",
        timeoutMs: 50,
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
      code: "PI_SESSION_TIMEOUT",
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
