import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  PUBLISHING_BROWSER_MCP_SERVER,
  PUBLISHING_BROWSER_MCP_TOOLS,
  PLAYWRIGHT_MCP_VERSION,
  createPublishingBrowserMcpProfile,
  createPublishingBrowserResourceLoader,
  type PublishingBrowserCapabilityGrant,
} from "../src/agent/publishing-browser-mcp.js";

const fixturePath = resolve("test/fixtures/mcp-fixture-server.mjs");
const temporaryPaths: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createRuntime(faux: ReturnType<typeof fauxProvider>) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  return runtime;
}

function fixtureDefinition(): AgentDefinition {
  return {
    id: "publishing-browser-policy-test",
    systemPrompt: "Use only the bounded Publisher browser capability.",
    mcp: {
      servers: [
        {
          name: PUBLISHING_BROWSER_MCP_SERVER,
          transport: {
            kind: "stdio",
            command: process.execPath,
            args: [fixturePath],
          },
          includeTools: [
            "browser_navigate",
            "browser_file_upload",
            "browser_click",
          ],
        },
      ],
    },
  };
}

async function createHost(
  faux: ReturnType<typeof fauxProvider>,
  grant: PublishingBrowserCapabilityGrant,
) {
  const runtime = await createRuntime(faux);
  return new PiAgentHost({
    model: faux.getModel(),
    modelRuntime: runtime,
    tools: [],
    defaultRunTimeoutMs: 4_000,
    defaultAbortTimeoutMs: 500,
    defaultDisposeTimeoutMs: 2_000,
    sessionOptions: { thinkingLevel: "off" },
    createResourceLoader: (input) =>
      createPublishingBrowserResourceLoader(input, grant),
  });
}

function grant(uploadRoot: string): PublishingBrowserCapabilityGrant {
  return {
    jobId: "job-browser",
    browserSessionId: "browser-session-a",
    cdpEndpoint: "http://browser-runtime:9222",
    allowedOrigins: [
      "https://creator.xiaohongshu.com",
      "https://www.xiaohongshu.com/some/path",
    ],
    uploadRoot,
  };
}

describe("Publishing browser MCP capability", () => {
  test("pins the official Playwright MCP CDP profile to the bounded tool surface", async () => {
    const uploadRoot = await tempDir("publisher-browser-profile-");
    const profile = createPublishingBrowserMcpProfile(grant(uploadRoot));
    const server = profile.servers[0];

    expect(PLAYWRIGHT_MCP_VERSION).toBe("0.0.82");
    expect(server?.name).toBe(PUBLISHING_BROWSER_MCP_SERVER);
    expect(server?.includeTools).toEqual(PUBLISHING_BROWSER_MCP_TOOLS);
    expect(server?.includeTools).not.toContain("browser_evaluate");
    expect(server?.includeTools).not.toContain("browser_run_code_unsafe");
    expect(server?.includeTools).not.toContain("browser_close");

    if (server?.transport.kind !== "stdio") {
      throw new Error("Expected Playwright MCP stdio transport");
    }

    expect(server.transport.command).toBe(process.execPath);
    expect(server.transport.cwd).toBe(resolve(uploadRoot));
    expect(server.transport.args).toEqual(
      expect.arrayContaining([
        expect.stringContaining("@playwright/mcp/cli.js"),
        "--cdp-endpoint=http://browser-runtime:9222",
        "--allowed-origins=https://creator.xiaohongshu.com;https://www.xiaohongshu.com",
        "--block-service-workers",
        "--codegen=none",
        "--image-responses=omit",
        "--no-webmcp",
      ]),
    );
    expect(server.transport.args).not.toContain(
      "--allow-unrestricted-file-access",
    );
  });

  test("fails closed when a browser grant is reused across Job scope", async () => {
    const uploadRoot = await tempDir("publisher-browser-scope-");
    const faux = fauxProvider({ provider: "publisher-browser-scope" });
    const host = await createHost(faux, grant(uploadRoot));

    await expect(
      host.createSession({
        definition: fixtureDefinition(),
        scope: { jobId: "job-other", role: "publishing" },
      }),
    ).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "AGENT_SESSION_INITIALIZATION_FAILED",
    });

    await expect(
      host.createSession({
        definition: fixtureDefinition(),
        scope: { jobId: "job-browser", role: "content" },
      }),
    ).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "AGENT_SESSION_INITIALIZATION_FAILED",
    });
  });

  test("blocks wrong-origin navigation before the MCP browser server executes it", async () => {
    const uploadRoot = await tempDir("publisher-browser-origin-");
    const faux = fauxProvider({ provider: "publisher-browser-origin" });
    const host = await createHost(faux, grant(uploadRoot));
    const session = await host.createSession({
      definition: fixtureDefinition(),
      scope: { jobId: "job-browser", role: "publishing" },
    });

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "mcp",
          {
            server: PUBLISHING_BROWSER_MCP_SERVER,
            tool: "browser_navigate",
            args: { url: "https://example.com/escape" },
          },
          { id: "wrong-origin" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const messages = JSON.stringify(context.messages);
        expect(messages).toContain("outside the Publisher browser grant");
        expect(messages).not.toContain("BROWSER_NAVIGATE_EXECUTED");
        return fauxAssistantMessage(fauxText("WRONG_ORIGIN_BLOCKED"));
      },
    ]);

    await expect(
      session.run({ prompt: "Attempt a navigation outside the Job grant." }),
    ).resolves.toMatchObject({ finalText: "WRONG_ORIGIN_BLOCKED" });

    await session.dispose();
  });

  test("permits only upload files contained by the canonical Job upload root", async () => {
    const uploadRoot = await tempDir("publisher-browser-upload-");
    const outsideRoot = await tempDir("publisher-browser-outside-");
    const allowedPath = join(uploadRoot, "cover.png");
    const deniedPath = join(outsideRoot, "secret.png");
    await writeFile(allowedPath, "allowed");
    await writeFile(deniedPath, "denied");

    const faux = fauxProvider({ provider: "publisher-browser-upload" });
    const host = await createHost(faux, grant(uploadRoot));
    const session = await host.createSession({
      definition: fixtureDefinition(),
      scope: { jobId: "job-browser", role: "publishing" },
    });

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "mcp",
          {
            server: PUBLISHING_BROWSER_MCP_SERVER,
            tool: "browser_file_upload",
            args: { paths: [deniedPath] },
          },
          { id: "outside-upload" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const messages = JSON.stringify(context.messages);
        expect(messages).toContain("outside the Publisher-approved upload root");
        expect(messages).not.toContain("BROWSER_UPLOAD_EXECUTED");
        return fauxAssistantMessage(fauxText("OUTSIDE_UPLOAD_BLOCKED"));
      },
    ]);

    await expect(
      session.run({ prompt: "Attempt an upload outside the Job root." }),
    ).resolves.toMatchObject({ finalText: "OUTSIDE_UPLOAD_BLOCKED" });

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "mcp",
          {
            server: PUBLISHING_BROWSER_MCP_SERVER,
            tool: "browser_file_upload",
            args: { paths: [allowedPath] },
          },
          { id: "inside-upload" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain(
          "BROWSER_UPLOAD_EXECUTED",
        );
        return fauxAssistantMessage(fauxText("INSIDE_UPLOAD_ALLOWED"));
      },
    ]);

    await expect(
      session.run({ prompt: "Upload the controlled Job asset." }),
    ).resolves.toMatchObject({ finalText: "INSIDE_UPLOAD_ALLOWED" });

    await session.dispose();
  });

  test("keeps obvious final-publish clicks outside the browser capability grant", async () => {
    const uploadRoot = await tempDir("publisher-browser-publish-");
    await mkdir(uploadRoot, { recursive: true });
    const faux = fauxProvider({ provider: "publisher-browser-publish" });
    const host = await createHost(faux, grant(uploadRoot));
    const session = await host.createSession({
      definition: fixtureDefinition(),
      scope: { jobId: "job-browser", role: "publishing" },
    });

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "mcp",
          {
            server: PUBLISHING_BROWSER_MCP_SERVER,
            tool: "browser_click",
            args: { element: "发布", target: "e99" },
          },
          { id: "final-publish" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const messages = JSON.stringify(context.messages);
        expect(messages).toContain(
          "Final publication is Publisher-owned",
        );
        expect(messages).not.toContain("BROWSER_CLICK_EXECUTED");
        return fauxAssistantMessage(fauxText("FINAL_PUBLISH_BLOCKED"));
      },
    ]);

    await expect(
      session.run({ prompt: "Attempt the final publication control." }),
    ).resolves.toMatchObject({ finalText: "FINAL_PUBLISH_BLOCKED" });

    await session.dispose();
  });
});
