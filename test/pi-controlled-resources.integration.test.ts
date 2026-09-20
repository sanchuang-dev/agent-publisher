import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentDefinition } from "../src/agent/definition.js";
import { PiAgentHost } from "../src/agent/pi-agent-host.js";
import { createControlledPiResourceLoader } from "../src/agent/pi-controlled-resources.js";

const temporaryPaths: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

async function writeSkill(
  root: string,
  name: string,
  marker: string,
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  await writeFile(
    path,
    `---
name: ${name}
description: Test skill ${name}.
---

# ${name}

${marker}
`,
    "utf8",
  );
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

const definition: AgentDefinition = {
  id: "content-secretary",
  systemPrompt: "You are a bounded Publisher content worker.",
};

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("controlled Pi resources", () => {
  test("loads only explicitly provisioned skills and ignores ambient Pi resources", async () => {
    const root = await createTempDir("publisher-resource-loader-");
    const cwd = join(root, "workspace");
    const agentDir = join(root, "ambient-agent");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const explicitSkill = resolve("skills/publisher-safety/SKILL.md");
    await writeSkill(join(cwd, ".pi", "skills"), "ambient-project", "PROJECT_AMBIENT");
    await writeSkill(join(agentDir, "skills"), "ambient-user", "USER_AMBIENT");

    const loader = await createControlledPiResourceLoader({
      cwd,
      agentDir,
      systemPrompt: definition.systemPrompt,
      allowedTools: ["read"],
      policy: {
        skillPaths: [explicitSkill],
        mandatorySkillPaths: [explicitSkill],
        readRoots: [cwd],
      },
    });

    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual([
      "publisher-safety",
    ]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getAppendSystemPrompt().join("\n")).toContain(
      "External irreversible publication",
    );
  });

  test("loads the standard skill through restricted read and blocks reads outside approved roots", async () => {
    const root = await createTempDir("publisher-restricted-read-");
    const workspace = join(root, "job-workspace");
    const outside = join(root, "outside");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });

    const outsideSecret = join(outside, "secret.txt");
    const linkedSecret = join(workspace, "linked-secret.txt");
    await writeFile(outsideSecret, "OUTSIDE_SECRET_MUST_NOT_LEAK", "utf8");
    await symlink(outsideSecret, linkedSecret);

    const skillPath = resolve("skills/publisher-safety/SKILL.md");
    const faux = fauxProvider({ provider: "publisher-controlled-read" });
    const modelRuntime = await createFauxRuntime(faux);

    let observedTools: string[] = [];
    let observedSystemPrompt = "";

    let hiddenProbeExecutions = 0;
    const hiddenProbe = defineTool({
      name: "hidden_probe",
      label: "Hidden Probe",
      description: "Must not be visible in this session.",
      parameters: Type.Object({}),
      async execute() {
        hiddenProbeExecutions += 1;
        return {
          content: [{ type: "text", text: "HIDDEN_PROBE_EXECUTED" }],
          details: {},
        };
      },
    });

    const host = new PiAgentHost({
      model: faux.getModel(),
      modelRuntime,
      cwd: workspace,
      defaultRunTimeoutMs: 2_000,
      tools: ["read"],
      sessionOptions: {
        customTools: [hiddenProbe],
        thinkingLevel: "off",
      },
      createResourceLoader(input) {
        return createControlledPiResourceLoader({
          cwd: input.cwd,
          systemPrompt: input.systemPrompt,
          allowedTools: input.allowedTools,
          policy: {
            skillPaths: [skillPath],
            mandatorySkillPaths: [skillPath],
            readRoots: [workspace],
          },
        });
      },
    });

    const session = await host.createSession({
      definition,
      scope: { jobId: "job-controlled-read", role: "content" },
    });

    faux.setResponses([
      (context) => {
        observedTools = (context.tools ?? []).map((tool) => tool.name);
        observedSystemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage(
          fauxToolCall("read", { path: skillPath }, { id: "read-skill" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const skillWasRead = context.messages.some(
          (message) =>
            message.role === "toolResult" &&
            JSON.stringify(message).includes("# Publisher safety"),
        );
        return fauxAssistantMessage(
          fauxText(skillWasRead ? "SKILL_LOADED" : "SKILL_MISSING"),
        );
      },
    ]);

    const skillResult = await session.run({
      prompt: "Load the publisher safety skill.",
    });

    expect(skillResult.finalText).toBe("SKILL_LOADED");
    expect(skillResult.toolExecutions).toEqual([
      expect.objectContaining({
        toolCallId: "read-skill",
        toolName: "read",
        completed: true,
        isError: false,
      }),
    ]);
    expect(observedTools).toEqual(["read"]);
    expect(observedSystemPrompt).toContain("<name>publisher-safety</name>");
    expect(observedSystemPrompt).toContain(
      "External irreversible publication",
    );

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("read", { path: linkedSecret }, { id: "read-outside" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const serialized = JSON.stringify(context.messages);
        return fauxAssistantMessage(
          fauxText(
            serialized.includes("outside approved Publisher roots") &&
              !serialized.includes("OUTSIDE_SECRET_MUST_NOT_LEAK")
              ? "OUTSIDE_BLOCKED"
              : "OUTSIDE_LEAKED",
          ),
        );
      },
    ]);

    const outsideResult = await session.run({
      prompt: "Try to read the disallowed file.",
    });

    expect(outsideResult.finalText).toBe("OUTSIDE_BLOCKED");
    expect(outsideResult.toolExecutions).toEqual([
      expect.objectContaining({
        toolCallId: "read-outside",
        toolName: "read",
        completed: true,
        isError: true,
      }),
    ]);

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("hidden_probe", {}, { id: "hidden-call" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const unavailable = JSON.stringify(context.messages).includes(
          "Tool hidden_probe not found",
        );
        return fauxAssistantMessage(
          fauxText(unavailable ? "HIDDEN_TOOL_BLOCKED" : "HIDDEN_TOOL_USABLE"),
        );
      },
    ]);

    const hiddenResult = await session.run({
      prompt: "Attempt a tool that is not in the visible allowlist.",
    });

    expect(hiddenResult.finalText).toBe("HIDDEN_TOOL_BLOCKED");
    expect(hiddenProbeExecutions).toBe(0);

    await session.dispose();
  });

  test("rejects unrestricted mutating or shell built-ins from the Publisher profile", async () => {
    const root = await createTempDir("publisher-forbidden-builtins-");
    const workspace = join(root, "job-workspace");
    await mkdir(workspace, { recursive: true });

    await expect(
      createControlledPiResourceLoader({
        cwd: workspace,
        systemPrompt: definition.systemPrompt,
        allowedTools: ["bash"],
        policy: {
          skillPaths: [],
          readRoots: [workspace],
        },
      }),
    ).rejects.toThrow(
      'Publisher controlled sessions must not enable unrestricted built-in tool "bash"',
    );
  });

  test("execution guard blocks a visible but forbidden custom tool before side effect", async () => {
    const root = await createTempDir("publisher-execution-guard-");
    const workspace = join(root, "job-workspace");
    await mkdir(workspace, { recursive: true });

    let executions = 0;
    const unsafeProbe = defineTool({
      name: "unsafe_probe",
      label: "Unsafe Probe",
      description: "Records whether execution reached the tool body.",
      parameters: Type.Object({}),
      async execute() {
        executions += 1;
        return {
          content: [{ type: "text", text: "UNSAFE_PROBE_EXECUTED" }],
          details: {},
        };
      },
    });

    const faux = fauxProvider({ provider: "publisher-execution-guard" });
    const modelRuntime = await createFauxRuntime(faux);

    const host = new PiAgentHost({
      model: faux.getModel(),
      modelRuntime,
      cwd: workspace,
      defaultRunTimeoutMs: 2_000,
      tools: ["unsafe_probe"],
      sessionOptions: {
        customTools: [unsafeProbe],
        thinkingLevel: "off",
      },
      createResourceLoader(input) {
        return createControlledPiResourceLoader({
          cwd: input.cwd,
          systemPrompt: input.systemPrompt,
          allowedTools: input.allowedTools,
          policy: {
            skillPaths: [],
            readRoots: [workspace],
            executionGuardAllowedTools: [],
          },
        });
      },
    });

    const session = await host.createSession({
      definition,
      scope: { jobId: "job-execution-guard", role: "content" },
    });

    faux.setResponses([
      (context) => {
        expect((context.tools ?? []).map((tool) => tool.name)).toEqual(["unsafe_probe"]);
        return fauxAssistantMessage(
          fauxToolCall("unsafe_probe", {}, { id: "unsafe-call" }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const blockedResult = context.messages.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === "unsafe_probe" &&
            message.isError === true,
        );
        return fauxAssistantMessage(
          fauxText(
            blockedResult && executions === 0
              ? "GUARD_BLOCKED"
              : "GUARD_MISSED",
          ),
        );
      },
    ]);

    const result = await session.run({
      prompt: "Attempt the unsafe probe.",
    });

    expect(result.finalText).toBe("GUARD_BLOCKED");
    expect(executions).toBe(0);
    expect(result.toolExecutions).toEqual([
      expect.objectContaining({
        toolCallId: "unsafe-call",
        toolName: "unsafe_probe",
        completed: true,
        isError: true,
      }),
    ]);

    await session.dispose();
  });
});
