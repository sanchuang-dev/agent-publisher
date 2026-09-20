import { readFile } from "node:fs/promises";

import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  createExtensionRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

import type { AgentDefinition } from "../src/agent/definition.js";
import { PiAgentHost } from "../src/agent/pi-agent-host.js";

function createResourceLoader(systemPrompt: string): ResourceLoader {
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
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

async function createFauxRuntime(provider: ReturnType<typeof fauxProvider>) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  return modelRuntime;
}

const definition: AgentDefinition = {
  id: "content-secretary",
  systemPrompt: "You are a bounded Publisher content worker.",
};

describe("PiAgentHost", () => {
  test("keeps transcript/context isolated across sessions from one definition", async () => {
    const faux = fauxProvider({ provider: "publisher-agent-host-isolation" });
    const modelRuntime = await createFauxRuntime(faux);
    const loaderInputs: Array<{
      jobId: string;
      role: string;
      systemPrompt: string;
    }> = [];

    const host = new PiAgentHost({
      model: faux.getModel(),
      modelRuntime,
      tools: [],
      sessionOptions: {
        thinkingLevel: "off",
      },
      createResourceLoader(input) {
        loaderInputs.push({
          jobId: input.scope.jobId,
          role: input.scope.role,
          systemPrompt: input.systemPrompt,
        });
        return createResourceLoader(input.systemPrompt);
      },
    });

    const sessionA = await host.createSession({
      definition,
      scope: { jobId: "job-a", role: "content" },
    });
    const sessionB = await host.createSession({
      definition,
      scope: { jobId: "job-b", role: "content" },
    });

    faux.setResponses([
      (context) => {
        const serialized = JSON.stringify(context);
        return fauxAssistantMessage(
          fauxText(
            serialized.includes("JOB_A_CONTEXT_SECRET")
              ? "A_CONTEXT_STORED"
              : "A_CONTEXT_MISSING",
          ),
        );
      },
      (context) => {
        const serialized = JSON.stringify(context);
        return fauxAssistantMessage(
          fauxText(
            serialized.includes("JOB_A_CONTEXT_SECRET")
              ? "JOB_A_LEAKED"
              : "JOB_B_ISOLATED",
          ),
        );
      },
      (context) => {
        const serialized = JSON.stringify(context);
        return fauxAssistantMessage(
          fauxText(
            serialized.includes("JOB_A_CONTEXT_SECRET")
              ? "A_CONTEXT_RETAINED"
              : "A_CONTEXT_LOST",
          ),
        );
      },
    ]);

    const firstA = await sessionA.run({
      prompt: "Remember this session-only context: JOB_A_CONTEXT_SECRET",
    });
    const resultB = await sessionB.run({
      prompt: "Check only your own session transcript.",
    });
    const secondA = await sessionA.run({
      prompt: "Check whether your earlier session context is still present.",
    });

    expect(firstA.finalText).toBe("A_CONTEXT_STORED");
    expect(resultB.finalText).toBe("JOB_B_ISOLATED");
    expect(secondA.finalText).toBe("A_CONTEXT_RETAINED");
    expect(sessionA.ref).not.toBe(sessionB.ref);
    expect(sessionA.definition).toBe(definition);
    expect(sessionB.definition).toBe(definition);
    expect(sessionA.scope).toEqual({ jobId: "job-a", role: "content" });
    expect(sessionB.scope).toEqual({ jobId: "job-b", role: "content" });
    expect(loaderInputs).toEqual([
      {
        jobId: "job-a",
        role: "content",
        systemPrompt: "You are a bounded Publisher content worker.",
      },
      {
        jobId: "job-b",
        role: "content",
        systemPrompt: "You are a bounded Publisher content worker.",
      },
    ]);

    await sessionA.dispose();
    await sessionB.dispose();
  });

  test("disposing one session does not invalidate another session", async () => {
    const faux = fauxProvider({ provider: "publisher-agent-host-lifecycle" });
    const modelRuntime = await createFauxRuntime(faux);
    const host = new PiAgentHost({
      model: faux.getModel(),
      modelRuntime,
      tools: [],
      sessionOptions: {
        thinkingLevel: "off",
      },
      createResourceLoader: ({ systemPrompt }) =>
        createResourceLoader(systemPrompt),
    });

    const sessionA = await host.createSession({
      definition,
      scope: { jobId: "job-a", role: "content" },
    });
    const sessionB = await host.createSession({
      definition,
      scope: { jobId: "job-b", role: "content" },
    });

    await sessionA.dispose();
    await sessionA.dispose();

    await expect(
      sessionA.run({ prompt: "Should fail after disposal." }),
    ).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "AGENT_SESSION_DISPOSED",
      runStopped: true,
    });

    faux.setResponses([
      fauxAssistantMessage(fauxText("JOB_B_STILL_ALIVE")),
    ]);

    await expect(
      sessionB.run({ prompt: "Remain usable." }),
    ).resolves.toMatchObject({
      finalText: "JOB_B_STILL_ALIVE",
    });

    await sessionB.dispose();
  });

  test("rejects overlapping runs on the same session while allowing sequential reuse", async () => {
    const faux = fauxProvider({ provider: "publisher-agent-host-single-flight" });
    const modelRuntime = await createFauxRuntime(faux);
    const host = new PiAgentHost({
      model: faux.getModel(),
      modelRuntime,
      tools: [],
      sessionOptions: {
        thinkingLevel: "off",
      },
      createResourceLoader: ({ systemPrompt }) =>
        createResourceLoader(systemPrompt),
    });

    const session = await host.createSession({
      definition,
      scope: { jobId: "job-single-flight", role: "content" },
    });

    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    faux.setResponses([
      async () => {
        markStarted();
        await released;
        return fauxAssistantMessage(fauxText("FIRST_DONE"));
      },
    ]);

    const firstRun = session.run({ prompt: "First task." });
    await started;

    await expect(
      session.run({ prompt: "Overlapping task." }),
    ).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "AGENT_SESSION_BUSY",
      runStopped: false,
    });

    releaseFirst();
    await expect(firstRun).resolves.toMatchObject({
      finalText: "FIRST_DONE",
    });

    faux.setResponses([
      fauxAssistantMessage(fauxText("SECOND_DONE")),
    ]);

    await expect(
      session.run({ prompt: "Sequential task after first completion." }),
    ).resolves.toMatchObject({
      finalText: "SECOND_DONE",
    });

    await session.dispose();
  });

  test("invalidates a session when a timed-out run cannot confirm abort", async () => {
    const faux = fauxProvider({
      provider: "publisher-agent-host-unconfirmed-abort",
    });
    const modelRuntime = await createFauxRuntime(faux);
    const host = new PiAgentHost({
      model: faux.getModel(),
      modelRuntime,
      tools: [],
      sessionOptions: {
        thinkingLevel: "off",
      },
      createResourceLoader: ({ systemPrompt }) =>
        createResourceLoader(systemPrompt),
    });

    const session = await host.createSession({
      definition,
      scope: { jobId: "job-timeout", role: "content" },
    });

    faux.setResponses([
      async () => await new Promise<never>(() => undefined),
    ]);

    await expect(
      session.run({
        prompt: "Never completes.",
        timeoutMs: 30,
        abortTimeoutMs: 30,
      }),
    ).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "AGENT_SESSION_ABORT_UNCONFIRMED",
      runStopped: false,
    });

    await expect(
      session.run({ prompt: "Must require a fresh session." }),
    ).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "AGENT_SESSION_DISPOSED",
      runStopped: true,
    });
  });

  test("keeps Pi framework types out of Publisher-facing contract modules", async () => {
    const contractFiles = [
      "src/agent/definition.ts",
      "src/agent/host.ts",
      "src/agent/session-ref.ts",
    ];

    for (const path of contractFiles) {
      const source = await readFile(path, "utf8");
      expect(source).not.toContain("@earendil-works/");
      expect(source).not.toMatch(
        /\b(?:PiAgentSession|ResourceLoader|CreateAgentSessionOptions)\b/,
      );
    }
  });
});
