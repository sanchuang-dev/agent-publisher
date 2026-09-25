import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentDefinition } from "../src/agent/definition.js";
import { PiAgentHost } from "../src/agent/pi-agent-host.js";
import { createControlledPiResourceLoader } from "../src/agent/pi-controlled-resources.js";

const temporaryPaths: string[] = [];
const fixtureProcesses: ChildProcess[] = [];
const fixturePath = resolve("test/fixtures/mcp-fixture-server.mjs");

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

async function createFauxRuntime(provider: ReturnType<typeof fauxProvider>) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(provider.provider);
  return runtime;
}

async function createHost(
  workspace: string,
  faux: ReturnType<typeof fauxProvider>,
): Promise<PiAgentHost> {
  const modelRuntime = await createFauxRuntime(faux);
  return new PiAgentHost({
    model: faux.getModel(),
    modelRuntime,
    cwd: workspace,
    tools: [],
    defaultRunTimeoutMs: 4_000,
    defaultAbortTimeoutMs: 500,
    defaultDisposeTimeoutMs: 2_000,
    sessionOptions: { thinkingLevel: "off" },
    createResourceLoader(input) {
      return createControlledPiResourceLoader({
        cwd: input.cwd,
        systemPrompt: input.systemPrompt,
        allowedTools: input.allowedTools,
        extensionFactories: input.extensionFactories,
        policy: {
          skillPaths: [],
          readRoots: [workspace],
          executionGuardAllowedTools: input.allowedTools,
        },
      });
    },
  });
}

function stdioDefinition(
  includeTools: readonly string[],
): AgentDefinition {
  return {
    id: "mcp-stdio-agent",
    systemPrompt: "Use only the Publisher-provisioned MCP gateway.",
    mcp: {
      servers: [
        {
          name: "stdio-fixture",
          transport: {
            kind: "stdio",
            command: process.execPath,
            args: [fixturePath],
          },
          includeTools,
        },
      ],
    },
  };
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 500);
    forceTimer.unref();
    child.once("exit", () => {
      clearTimeout(forceTimer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

async function startHttpFixture(): Promise<{
  child: ChildProcess;
  url: string;
}> {
  const child = spawn(process.execPath, [fixturePath, "--http", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  fixtureProcesses.push(child);

  const port = await new Promise<number>((resolvePort, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`HTTP fixture startup timed out: ${stderr}`));
    }, 2_000);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/HTTP_PORT=(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolvePort(Number.parseInt(match[1]!, 10));
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `HTTP fixture exited before startup (code=${String(code)}): ${stderr}`,
        ),
      );
    });
  });

  return { child, url: `http://127.0.0.1:${port}/mcp` };
}

function pidFromResult(text: string): number {
  const match = text.match(/PID:(\d+)/);
  if (!match) throw new Error(`Missing fixture pid in result: ${text}`);
  return Number.parseInt(match[1]!, 10);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`MCP fixture pid ${pid} remained alive after session dispose`);
}

afterEach(async () => {
  await Promise.all(fixtureProcesses.splice(0).map(stopProcess));
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Publisher Pi MCP adapter", () => {
  test("discovers and invokes only allowlisted stdio tools through the proxy", async () => {
    const workspace = await createTempDir("publisher-mcp-stdio-");
    await mkdir(workspace, { recursive: true });
    const faux = fauxProvider({ provider: "publisher-mcp-stdio" });
    const host = await createHost(workspace, faux);
    const session = await host.createSession({
      definition: stdioDefinition(["allowed_echo"]),
      scope: { jobId: "job-mcp-stdio", role: "content" },
    });

    faux.setResponses([
      (context) => {
        expect((context.tools ?? []).map((tool) => tool.name)).toEqual(["mcp"]);
        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            { connect: "stdio-fixture" },
            { id: "stdio-connect" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        expect((context.tools ?? []).map((tool) => tool.name)).toEqual(["mcp"]);
        const serialized = JSON.stringify(context.messages);
        expect(serialized).toContain("allowed_echo");
        expect(serialized).not.toContain("denied_secret");
        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: "stdio-fixture",
              tool: "allowed_echo",
              args: { value: "stdio" },
            },
            { id: "stdio-call" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("echo:stdio");
        return fauxAssistantMessage(fauxText("STDIO_OK"));
      },
    ]);

    const result = await session.run({
      prompt: "Discover the allowed MCP tool and invoke it.",
    });

    expect(result.finalText).toBe("STDIO_OK");
    expect(result.toolExecutions.map((entry) => entry.toolName)).toEqual([
      "mcp",
      "mcp",
    ]);

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "mcp",
          {
            server: "stdio-fixture",
            tool: "denied_secret",
            args: {},
          },
          { id: "stdio-denied-call" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const serialized = JSON.stringify(context.messages);
        expect(serialized).not.toContain("DENIED_TOOL_EXECUTED");
        return fauxAssistantMessage(fauxText("DENIED_BLOCKED"));
      },
    ]);

    await expect(
      session.run({ prompt: "Attempt the non-allowlisted MCP tool." }),
    ).resolves.toMatchObject({ finalText: "DENIED_BLOCKED" });

    await session.dispose();
  });

  test("invokes an allowlisted tool over Streamable HTTP", async () => {
    const workspace = await createTempDir("publisher-mcp-http-");
    await mkdir(workspace, { recursive: true });
    const { child, url } = await startHttpFixture();
    const faux = fauxProvider({ provider: "publisher-mcp-http" });
    const host = await createHost(workspace, faux);
    const definition: AgentDefinition = {
      id: "mcp-http-agent",
      systemPrompt: "Use only the Publisher-provisioned MCP gateway.",
      mcp: {
        servers: [
          {
            name: "http-fixture",
            transport: {
              kind: "http",
              url,
              auth: { kind: "none" },
            },
            includeTools: ["allowed_echo"],
          },
        ],
      },
    };
    const session = await host.createSession({
      definition,
      scope: { jobId: "job-mcp-http", role: "content" },
    });

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "mcp",
          { connect: "http-fixture" },
          { id: "http-connect" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const serialized = JSON.stringify(context.messages);
        expect(serialized).toContain("allowed_echo");
        expect(serialized).not.toContain("denied_secret");
        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: "http-fixture",
              tool: "allowed_echo",
              args: { value: "http" },
            },
            { id: "http-call" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("echo:http");
        return fauxAssistantMessage(fauxText("HTTP_OK"));
      },
    ]);

    const result = await session.run({
      prompt: "Use the controlled HTTP MCP fixture.",
    });

    expect(result.finalText).toBe("HTTP_OK");
    await session.dispose();
    await stopProcess(child);
  });

  test("uses independent stdio server processes per AgentSession and tears them down", async () => {
    const workspace = await createTempDir("publisher-mcp-lifecycle-");
    await mkdir(workspace, { recursive: true });
    const faux = fauxProvider({ provider: "publisher-mcp-lifecycle" });
    const host = await createHost(workspace, faux);
    const definition = stdioDefinition(["fixture_pid"]);

    const sessionA = await host.createSession({
      definition,
      scope: { jobId: "job-a", role: "content" },
    });
    const sessionB = await host.createSession({
      definition,
      scope: { jobId: "job-b", role: "content" },
    });

    async function getFixturePid(
      session: Awaited<ReturnType<PiAgentHost["createSession"]>>,
      callPrefix: string,
    ): Promise<number> {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            { search: "fixture pid", server: "stdio-fixture" },
            { id: `${callPrefix}-search` },
          ),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            { server: "stdio-fixture", tool: "fixture_pid", args: {} },
            { id: `${callPrefix}-pid` },
          ),
          { stopReason: "toolUse" },
        ),
        (context) => {
          const serialized = JSON.stringify(context.messages);
          const match = serialized.match(/PID:(\d+)/);
          return fauxAssistantMessage(
            fauxText(match ? `PID:${match[1]}` : "PID:MISSING"),
          );
        },
      ]);
      return pidFromResult(
        (await session.run({ prompt: "Return the MCP fixture pid." })).finalText,
      );
    }

    const pidA = await getFixturePid(sessionA, "a");
    const pidB = await getFixturePid(sessionB, "b");

    expect(pidA).not.toBe(pidB);
    expect(isPidAlive(pidA)).toBe(true);
    expect(isPidAlive(pidB)).toBe(true);

    await sessionA.dispose();
    await waitForPidExit(pidA);
    expect(isPidAlive(pidB)).toBe(true);

    await sessionB.dispose();
    await waitForPidExit(pidB);
  });

  test("contains unavailable MCP failure and keeps the AgentSession usable", async () => {
    const workspace = await createTempDir("publisher-mcp-failure-");
    await mkdir(workspace, { recursive: true });
    const faux = fauxProvider({ provider: "publisher-mcp-failure" });
    const host = await createHost(workspace, faux);
    const definition: AgentDefinition = {
      id: "mcp-failure-agent",
      systemPrompt: "Treat MCP failure as a bounded external dependency failure.",
      mcp: {
        servers: [
          {
            name: "fixture-a",
            transport: {
              kind: "stdio",
              command: "/publisher/ghost-command-x",
              },
            includeTools: ["allowed_echo"],
          },
        ],
      },
    };
    const session = await host.createSession({
      definition,
      scope: { jobId: "job-mcp-failure", role: "content" },
    });

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "mcp",
          { connect: "fixture-a" },
          { id: "unavailable-connect" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const mcpToolResults = context.messages.filter(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === "mcp",
        );
        const serializedResults = JSON.stringify(mcpToolResults);
        expect(mcpToolResults.length).toBeGreaterThan(0);
        const failureVisible =
          serializedResults.includes('"error":"connect_failed"') &&
          serializedResults.includes('Failed to connect to \\"fixture-a\\"');
        return fauxAssistantMessage(
          fauxText(
            failureVisible ? "MCP_FAILURE_OBSERVED" : "MCP_FAILURE_MISSING",
          ),
        );
      },
    ]);

    await expect(
      session.run({ prompt: "Probe the unavailable MCP server." }),
    ).resolves.toMatchObject({ finalText: "MCP_FAILURE_OBSERVED" });

    faux.setResponses([
      fauxAssistantMessage(fauxText("SESSION_STILL_USABLE")),
    ]);
    await expect(
      session.run({ prompt: "Continue without MCP." }),
    ).resolves.toMatchObject({ finalText: "SESSION_STILL_USABLE" });

    await session.dispose();
  });

  test("allows authenticated plaintext HTTP on IPv6 loopback", async () => {
    const workspace = await createTempDir("publisher-mcp-auth-ipv6-");
    await mkdir(workspace, { recursive: true });
    const faux = fauxProvider({ provider: "publisher-mcp-auth-ipv6" });
    const host = await createHost(workspace, faux);
    const definition: AgentDefinition = {
      id: "mcp-auth-ipv6-agent",
      systemPrompt: "Use only the Publisher-provisioned MCP gateway.",
      mcp: {
        servers: [
          {
            name: "loopback-auth",
            transport: {
              kind: "http",
              url: "http://[::1]:65535/mcp",
              auth: { kind: "bearer-env", env: "PUBLISHER_TEST_TOKEN" },
            },
            includeTools: ["allowed_echo"],
          },
        ],
      },
    };

    const session = await host.createSession({
      definition,
      scope: { jobId: "job-mcp-auth-ipv6", role: "content" },
    });
    await session.dispose();
  });

  test("rejects credentials embedded directly in an MCP URL", async () => {
    const workspace = await createTempDir("publisher-mcp-url-credentials-");
    await mkdir(workspace, { recursive: true });
    const faux = fauxProvider({ provider: "publisher-mcp-url-credentials" });
    const host = await createHost(workspace, faux);
    const definition: AgentDefinition = {
      id: "mcp-url-credentials-agent",
      systemPrompt: "Use only the Publisher-provisioned MCP gateway.",
      mcp: {
        servers: [
          {
            name: "embedded-credentials",
            transport: {
              kind: "http",
              url: "https://publisher-test:secret@example.com/mcp",
              auth: { kind: "none" },
            },
            includeTools: ["allowed_echo"],
          },
        ],
      },
    };

    await expect(
      host.createSession({
        definition,
        scope: { jobId: "job-mcp-url-credentials", role: "content" },
      }),
    ).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "AGENT_SESSION_INITIALIZATION_FAILED",
    });
  });

  test("rejects authenticated remote MCP over plaintext HTTP", async () => {
    const workspace = await createTempDir("publisher-mcp-auth-http-");
    await mkdir(workspace, { recursive: true });
    const faux = fauxProvider({ provider: "publisher-mcp-auth-http" });
    const host = await createHost(workspace, faux);
    const definition: AgentDefinition = {
      id: "mcp-auth-http-agent",
      systemPrompt: "Use only the Publisher-provisioned MCP gateway.",
      mcp: {
        servers: [
          {
            name: "remote-auth",
            transport: {
              kind: "http",
              url: "http://example.com/mcp",
              auth: { kind: "bearer-env", env: "PUBLISHER_TEST_TOKEN" },
            },
            includeTools: ["allowed_echo"],
          },
        ],
      },
    };

    await expect(
      host.createSession({
        definition,
        scope: { jobId: "job-mcp-auth-http", role: "content" },
      }),
    ).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "AGENT_SESSION_INITIALIZATION_FAILED",
    });
  });

  test("fails closed on an empty MCP includeTools policy", async () => {
    const workspace = await createTempDir("publisher-mcp-config-");
    await mkdir(workspace, { recursive: true });
    const faux = fauxProvider({ provider: "publisher-mcp-config" });
    const host = await createHost(workspace, faux);

    await expect(
      host.createSession({
        definition: stdioDefinition([]),
        scope: { jobId: "job-mcp-config", role: "content" },
      }),
    ).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "AGENT_SESSION_INITIALIZATION_FAILED",
    });
  });
});
