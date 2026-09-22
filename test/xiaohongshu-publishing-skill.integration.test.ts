import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryCredentialStore,
  Type,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";

import { PiAgentHost } from "../src/agent/pi-agent-host.js";
import {
  XIAOHONGSHU_PUBLISHING_LOCAL_TOOLS,
  XIAOHONGSHU_PUBLISHING_ROLE,
  createXiaohongshuPublishingDefinition,
  createXiaohongshuPublishingResourceLoader,
  xiaohongshuPublishingDefinition,
  xiaohongshuPublishingReferencePath,
} from "../src/agent/xiaohongshu-publishing-skill.js";

const temporaryPaths: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
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

async function createPublishingHost(
  cwd: string,
  faux: ReturnType<typeof fauxProvider>,
  customTools: readonly ToolDefinition[] = [],
) {
  const modelRuntime = await createFauxRuntime(faux);
  return new PiAgentHost({
    model: faux.getModel(),
    modelRuntime,
    cwd,
    defaultRunTimeoutMs: 2_000,
    tools: XIAOHONGSHU_PUBLISHING_LOCAL_TOOLS,
    sessionOptions: {
      customTools: [...customTools],
      thinkingLevel: "off",
    },
    createResourceLoader: createXiaohongshuPublishingResourceLoader,
  });
}

function skillIsPresent(systemPrompt: string | undefined): boolean {
  const prompt = systemPrompt ?? "";
  return (
    prompt.includes("<name>xiaohongshu-publishing</name>") &&
    prompt.includes("上传图文") &&
    prompt.includes("Final publish is forbidden") &&
    prompt.includes("unknown draft")
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("XHS-SKILL-01 Xiaohongshu Publishing Skill", () => {
  test("loads only the reviewed Publisher/XHS skills and rejects unrelated top-level tools", async () => {
    const cwd = await createTempDir("publisher-xhs-skill-loader-");

    const loader = await createXiaohongshuPublishingResourceLoader({
      definition: xiaohongshuPublishingDefinition,
      scope: {
        jobId: "job-xhs-skill-loader",
        role: XIAOHONGSHU_PUBLISHING_ROLE,
      },
      systemPrompt: xiaohongshuPublishingDefinition.systemPrompt,
      cwd,
      allowedTools: ["read"],
      extensionFactories: [],
    });

    expect(
      loader
        .getSkills()
        .skills.map((skill) => skill.name)
        .sort(),
    ).toEqual(["publisher-safety", "xiaohongshu-publishing"]);

    const mandatoryPrompt = loader.getAppendSystemPrompt().join("\n");
    expect(mandatoryPrompt).toContain("Final publish is forbidden");
    expect(mandatoryPrompt).toContain("unknown draft");
    expect(mandatoryPrompt).toContain("authorized human");
    expect(mandatoryPrompt).toContain("approval");
    expect(mandatoryPrompt).toContain(
      "references/2026-09-22-creator-mode-entry.md",
    );
    expect(mandatoryPrompt).toContain("generic browser click capability");
    expect(mandatoryPrompt).toContain("External irreversible publication");
    expect(mandatoryPrompt).toContain(
      "current observed page is stronger evidence than a historical reference",
    );
    expect(mandatoryPrompt).toContain(
      "do not repeat the same failed action",
    );
    expect(mandatoryPrompt).toContain(
      "recovery may use multiple loops",
    );
    expect(xiaohongshuPublishingDefinition.systemPrompt).toContain(
      "Ordinary page ambiguity is a reason to re-observe",
    );
    expect(xiaohongshuPublishingDefinition.systemPrompt).toContain(
      "materially different safe exploration no longer produces new evidence",
    );

    const mcpReadyDefinition = createXiaohongshuPublishingDefinition({
      servers: [
        {
          name: "playwright",
          transport: {
            kind: "stdio",
            command: "playwright-mcp-placeholder",
          },
          includeTools: ["browser_snapshot", "browser_click"],
        },
      ],
    });
    await expect(
      createXiaohongshuPublishingResourceLoader({
        definition: mcpReadyDefinition,
        scope: {
          jobId: "job-xhs-skill-mcp-ready",
          role: XIAOHONGSHU_PUBLISHING_ROLE,
        },
        systemPrompt: mcpReadyDefinition.systemPrompt,
        cwd,
        allowedTools: ["read", "mcp"],
        extensionFactories: [],
      }),
    ).resolves.toBeDefined();

    expect(() =>
      createXiaohongshuPublishingDefinition({
        servers: [
          {
            name: "playwright",
            transport: {
              kind: "stdio",
              command: "playwright-mcp-placeholder",
            },
            includeTools: ["browser_evaluate"],
          },
        ],
      }),
    ).toThrow(
      'Xiaohongshu Publishing MCP profile must not expose non-browser or overpowered tool "browser_evaluate"',
    );

    expect(() =>
      createXiaohongshuPublishingResourceLoader({
        definition: xiaohongshuPublishingDefinition,
        scope: {
          jobId: "job-xhs-skill-unrelated-tool",
          role: XIAOHONGSHU_PUBLISHING_ROLE,
        },
        systemPrompt: xiaohongshuPublishingDefinition.systemPrompt,
        cwd,
        allowedTools: ["read", "unsafe_probe"],
        extensionFactories: [],
      }),
    ).toThrow(
      'Xiaohongshu Publishing sessions must not inherit unrelated top-level tool "unsafe_probe"',
    );
  });

  test("provides guidance context for different Creator starting states without encoding a standard answer", async () => {
    const cwd = await createTempDir("publisher-xhs-skill-fixtures-");
    const faux = fauxProvider({ provider: "publisher-xhs-skill-fixtures" });
    const host = await createPublishingHost(cwd, faux);
    const session = await host.createSession({
      definition: xiaohongshuPublishingDefinition,
      scope: {
        jobId: "job-xhs-skill-fixtures",
        role: XIAOHONGSHU_PUBLISHING_ROLE,
      },
    });

    const runStartingState = async (statePrompt: string) => {
      faux.setResponses([
        (context) => {
          const prompt = context.systemPrompt ?? "";
          const hasExplorationGuidance =
            skillIsPresent(prompt) &&
            prompt.includes("current observed page is stronger evidence") &&
            prompt.includes("revise the working hypothesis") &&
            prompt.includes("recovery may use multiple loops");

          expect((context.tools ?? []).map((tool) => tool.name)).toEqual(["read"]);
          expect(JSON.stringify(context.messages)).toContain(statePrompt);

          return fauxAssistantMessage(
            fauxText(hasExplorationGuidance ? "GUIDANCE_AVAILABLE" : "SKILL_MISSING"),
          );
        },
      ]);

      return session.run({
        prompt: [
          "GOAL=IMAGE_TEXT",
          statePrompt,
          "Reason from the page that exists now. Historical experience is guidance, not a mandatory action.",
        ].join("\n"),
      });
    };

    await expect(
      runStartingState(
        "START=VIDEO_MODE; observed choices include 上传视频 / 上传图文 / 写文章.",
      ),
    ).resolves.toMatchObject({
      finalText: "GUIDANCE_AVAILABLE",
      toolExecutions: [],
    });

    await expect(
      runStartingState(
        "START=IMAGE_TEXT_COMPOSER; current composer appears fresh.",
      ),
    ).resolves.toMatchObject({
      finalText: "GUIDANCE_AVAILABLE",
      toolExecutions: [],
    });

    await session.dispose();
  });

  test("stops on an unknown draft and does not expose a dedicated final-publish tool", async () => {
    const cwd = await createTempDir("publisher-xhs-skill-safety-");
    const faux = fauxProvider({ provider: "publisher-xhs-skill-safety" });
    let publishExecutions = 0;

    const finalPublish = defineTool({
      name: "final_publish",
      label: "Final Publish",
      description: "Forbidden irreversible publication probe.",
      parameters: Type.Object({}),
      async execute() {
        publishExecutions += 1;
        return {
          content: [{ type: "text" as const, text: "PUBLISHED" }],
          details: {},
        };
      },
    });

    const host = await createPublishingHost(cwd, faux, [finalPublish]);
    const session = await host.createSession({
      definition: xiaohongshuPublishingDefinition,
      scope: {
        jobId: "job-xhs-skill-safety",
        role: XIAOHONGSHU_PUBLISHING_ROLE,
      },
    });

    faux.setResponses([
      (context) => {
        const serialized = JSON.stringify(context.messages);
        const guided =
          skillIsPresent(context.systemPrompt) &&
          serialized.includes("UNKNOWN_DRAFT") &&
          serialized.includes("existing title/body/media");

        return fauxAssistantMessage(
          fauxText(guided ? "STOP_UNKNOWN_DRAFT" : "SKILL_MISSING"),
        );
      },
    ]);

    await expect(
      session.run({
        prompt: [
          "STATE=UNKNOWN_DRAFT",
          "The composer already contains existing title/body/media of unknown ownership.",
          "Decide whether to overwrite it.",
        ].join("\n"),
      }),
    ).resolves.toMatchObject({
      finalText: "STOP_UNKNOWN_DRAFT",
      toolExecutions: [],
    });

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("final_publish", {}, { id: "forbidden-final-publish" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const serialized = JSON.stringify(context.messages);
        const unavailable = serialized.includes("Tool final_publish not found");
        return fauxAssistantMessage(
          fauxText(
            unavailable && skillIsPresent(context.systemPrompt)
              ? "FINAL_PUBLISH_UNAVAILABLE"
              : "FINAL_PUBLISH_EXPOSED",
          ),
        );
      },
    ]);

    const publishAttempt = await session.run({
      prompt: "Attempt the final publish capability. It must not be available.",
    });

    expect(publishAttempt.finalText).toBe("FINAL_PUBLISH_UNAVAILABLE");
    expect(publishExecutions).toBe(0);

    await session.dispose();
  });

  test("makes reviewed real-smoke experience available as a read-only Skill reference", async () => {
    const cwd = await createTempDir("publisher-xhs-skill-reference-");
    const faux = fauxProvider({ provider: "publisher-xhs-skill-reference" });
    const host = await createPublishingHost(cwd, faux);
    const session = await host.createSession({
      definition: xiaohongshuPublishingDefinition,
      scope: {
        jobId: "job-xhs-skill-reference",
        role: XIAOHONGSHU_PUBLISHING_ROLE,
      },
    });

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "read",
          { path: xiaohongshuPublishingReferencePath },
          { id: "read-xhs-reference" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const serialized = JSON.stringify(context.messages);
        const referenceLoaded =
          serialized.includes("Issue #95") &&
          serialized.includes("上传视频 / 上传图文 / 写文章") &&
          serialized.includes("legacy fixed") &&
          serialized.includes("does NOT prove");

        return fauxAssistantMessage(
          fauxText(referenceLoaded ? "REFERENCE_LOADED" : "REFERENCE_MISSING"),
        );
      },
    ]);

    const result = await session.run({
      prompt: [
        "Use the Xiaohongshu Skill's reviewed experience index.",
        "Read the Creator mode-entry reference named there before reasoning about the mismatch.",
      ].join("\n"),
    });

    expect(result.finalText).toBe("REFERENCE_LOADED");
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({
        toolCallId: "read-xhs-reference",
        toolName: "read",
        completed: true,
        isError: false,
      }),
    ]);

    await session.dispose();
  });
});
