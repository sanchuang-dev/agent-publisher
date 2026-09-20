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
  test("creates isolated job/role sessions from one reusable definition", async () => {
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
      context: "JOB_A_CONTEXT_SECRET",
    });
    const sessionB = await host.createSession({
      definition,
      scope: { jobId: "job-b", role: "content" },
      context: "JOB_B_CONTEXT",
    });

    faux.setResponses([
      (context) => {
        const serialized = JSON.stringify(context);
        return fauxAssistantMessage(
          fauxText(
            serialized.includes("JOB_A_CONTEXT_SECRET")
              ? "A_CONTEXT_VISIBLE"
              : "A_CONTEXT_MISSING",
          ),
        );
      },
      (context) => {
        const serialized = JSON.stringify(context);
        const leaked =
          serialized.includes("JOB_A_CONTEXT_SECRET") ||
          serialized.includes("JOB_A_PROMPT_SECRET");
        return fauxAssistantMessage(
          fauxText(leaked ? "JOB_A_LEAKED" : "JOB_B_ISOLATED"),
        );
      },
    ]);

    const resultA = await sessionA.run({
      prompt: "JOB_A_PROMPT_SECRET",
    });
    const resultB = await sessionB.run({
      prompt: "Check only your own session.",
    });

    expect(resultA.finalText).toBe("A_CONTEXT_VISIBLE");
    expect(resultB.finalText).toBe("JOB_B_ISOLATED");
    expect(sessionA.ref).not.toBe(sessionB.ref);
    expect(sessionA.definition).toBe(definition);
    expect(sessionB.definition).toBe(definition);
    expect(sessionA.scope).toEqual({ jobId: "job-a", role: "content" });
    expect(sessionB.scope).toEqual({ jobId: "job-b", role: "content" });
    expect(loaderInputs).toEqual([
      {
        jobId: "job-a",
        role: "content",
        systemPrompt:
          "You are a bounded Publisher content worker.\n\nSession context:\nJOB_A_CONTEXT_SECRET",
      },
      {
        jobId: "job-b",
        role: "content",
        systemPrompt:
          "You are a bounded Publisher content worker.\n\nSession context:\nJOB_B_CONTEXT",
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

  test("keeps Pi framework types out of Publisher-facing contract modules", async () => {
    const contractFiles = [
      "src/agent/definition.ts",
      "src/agent/host.ts",
      "src/agent/session-ref.ts",
    ];

    for (const path of contractFiles) {
      const source = await readFile(path, "utf8");
      expect(source).not.toContain("@earendil-works/");
      expect(source).not.toMatch(/\b(?:PiAgentSession|ResourceLoader|CreateAgentSessionOptions)\b/);
    }
  });
});
