import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import type { Page } from "playwright";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentDefinition } from "../src/agent/definition.js";
import { PiAgentHost } from "../src/agent/pi-agent-host.js";
import type {
  BrowserAutomationAttachmentProvider,
  BrowserSession,
} from "../src/browser/provider.js";
import {
  PUBLISHING_BROWSER_MCP_SERVER,
  PUBLISHING_BROWSER_MCP_TOOLS,
  PLAYWRIGHT_MCP_VERSION,
  createPublishingBrowserMcpProfile,
  createPublishingBrowserResourceLoader,
  issuePublishingBrowserCapabilityGrant,
  type PublishingBrowserCapabilityGrant,
  type PublishingBrowserClickAuthorizer,
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

function browserHarness(
  initialUrl = "https://creator.xiaohongshu.com/publish",
) {
  let currentUrl = initialUrl;
  let closed = false;
  const page = {
    url: () => currentUrl,
    isClosed: () => closed,
  } as unknown as Page;
  const session: BrowserSession = {
    id: "browser-session-a",
    page,
    profileRef: "browser-profile",
  };
  const provider: BrowserAutomationAttachmentProvider = {
    async acquire() {
      return session;
    },
    async release() {
      closed = true;
    },
    async health() {
      return { status: "reachable" };
    },
    async resolveAutomationAttachment(sessionId) {
      if (sessionId !== session.id || closed) {
        throw new Error("session is not owned by this provider");
      }
      return {
        sessionId,
        cdpEndpoint:
          "ws://browser-runtime:9222/devtools/browser/test-browser",
      };
    },
  };

  return {
    page,
    session,
    provider,
    setUrl(url: string) {
      currentUrl = url;
    },
  };
}

const allowSafeClicks: PublishingBrowserClickAuthorizer = async ({
  observedTarget,
}) => ({
  allowed: !observedTarget.includes("发布"),
  ...(observedTarget.includes("发布")
    ? { reason: "Publisher policy denied the observed publish control" }
    : {}),
});

async function grant(
  uploadRoot: string,
  options: {
    harness?: ReturnType<typeof browserHarness>;
    authorizeClick?: PublishingBrowserClickAuthorizer;
  } = {},
): Promise<{
  grant: PublishingBrowserCapabilityGrant;
  harness: ReturnType<typeof browserHarness>;
}> {
  const harness = options.harness ?? browserHarness();
  const issued = await issuePublishingBrowserCapabilityGrant({
    jobId: "job-browser",
    browserProvider: harness.provider,
    browserSession: harness.session,
    allowedOrigins: [
      "https://creator.xiaohongshu.com",
      "https://www.xiaohongshu.com/some/path",
    ],
    uploadRoot,
    authorizeClick: options.authorizeClick ?? allowSafeClicks,
  });
  return { grant: issued, harness };
}

describe("Publishing browser MCP capability", () => {
  test("pins the official Playwright MCP CDP profile to the bounded tool surface", async () => {
    const uploadRoot = await tempDir("publisher-browser-profile-");
    const { grant: issued } = await grant(uploadRoot);
    const profile = createPublishingBrowserMcpProfile(issued);
    const server = profile.servers[0];

    expect(PLAYWRIGHT_MCP_VERSION).toBe("0.0.82");
    expect(server?.name).toBe(PUBLISHING_BROWSER_MCP_SERVER);
    expect(server?.includeTools).toEqual(PUBLISHING_BROWSER_MCP_TOOLS);
    expect(server?.includeTools).not.toContain("browser_evaluate");
    expect(server?.includeTools).not.toContain("browser_run_code_unsafe");
    expect(server?.includeTools).not.toContain("browser_close");
    expect(server?.includeTools).not.toContain("browser_tabs");

    if (server?.transport.kind !== "stdio") {
      throw new Error("Expected Playwright MCP stdio transport");
    }

    expect(server.transport.command).toBe(process.execPath);
    expect(server.transport.cwd).toBe(resolve(uploadRoot));
    expect(server.transport.args).toEqual(
      expect.arrayContaining([
        expect.stringContaining("@playwright/mcp/cli.js"),
        "--cdp-endpoint=ws://browser-runtime:9222/devtools/browser/test-browser",
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
    const { grant: issued } = await grant(uploadRoot);
    const host = await createHost(faux, issued);

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
    const { grant: issued } = await grant(uploadRoot);
    const host = await createHost(faux, issued);
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
    const { grant: issued } = await grant(uploadRoot);
    const host = await createHost(faux, issued);
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

  test("denies a publish ref even when the model supplies a misleading safe label", async () => {
    const uploadRoot = await tempDir("publisher-browser-publish-");
    const faux = fauxProvider({ provider: "publisher-browser-publish" });
    const { grant: issued } = await grant(uploadRoot);
    const host = await createHost(faux, issued);
    const session = await host.createSession({
      definition: fixtureDefinition(),
      scope: { jobId: "job-browser", role: "publishing" },
    });

    let publishToken: string | undefined;
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "mcp",
          {
            server: PUBLISHING_BROWSER_MCP_SERVER,
            tool: "browser_navigate",
            args: { url: "https://creator.xiaohongshu.com/publish" },
          },
          { id: "observe-controls" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const messages = JSON.stringify(context.messages);
        publishToken = messages.match(/发布[^\\n]*\\[ref=(g\\d+:e99)\\]/)?.[1];
        expect(publishToken).toMatch(/^g\\d+:e99$/);
        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_click",
              args: { element: "Safe next", target: publishToken! },
            },
            { id: "misleading-publish-click" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const messages = JSON.stringify(context.messages);
        expect(messages).toContain(
          "Publisher policy denied the observed publish control",
        );
        expect(messages).not.toContain("BROWSER_CLICK_EXECUTED");
        return fauxAssistantMessage(fauxText("PUBLISH_REF_BLOCKED"));
      },
    ]);

    await expect(
      session.run({
        prompt:
          "Observe the page, then try the control described as safe even if the ref points elsewhere.",
      }),
    ).resolves.toMatchObject({ finalText: "PUBLISH_REF_BLOCKED" });

    await session.dispose();
  });

  test("blocks browser actions when the acquired current page drifts outside the Job origin grant", async () => {
    const uploadRoot = await tempDir("publisher-browser-current-origin-");
    const faux = fauxProvider({ provider: "publisher-browser-current-origin" });
    const { grant: issued, harness } = await grant(uploadRoot);
    const host = await createHost(faux, issued);
    const session = await host.createSession({
      definition: fixtureDefinition(),
      scope: { jobId: "job-browser", role: "publishing" },
    });

    harness.setUrl("https://example.com/escaped");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "mcp",
          {
            server: PUBLISHING_BROWSER_MCP_SERVER,
            tool: "browser_click",
            args: { element: "Safe next", target: "e2" },
          },
          { id: "escaped-origin-click" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const messages = JSON.stringify(context.messages);
        expect(messages).toContain(
          "Current browser page is outside the Publisher browser grant",
        );
        expect(messages).not.toContain("BROWSER_CLICK_EXECUTED");
        return fauxAssistantMessage(fauxText("CURRENT_ORIGIN_BLOCKED"));
      },
    ]);

    await expect(
      session.run({ prompt: "Attempt an action on the drifted current page." }),
    ).resolves.toMatchObject({ finalText: "CURRENT_ORIGIN_BLOCKED" });

    await session.dispose();
  });

  test("refuses to issue a grant when BrowserProvider returns another session attachment", async () => {
    const uploadRoot = await tempDir("publisher-browser-attachment-");
    const harness = browserHarness();
    const mismatchedProvider: BrowserAutomationAttachmentProvider = {
      ...harness.provider,
      async resolveAutomationAttachment() {
        return {
          sessionId: "another-session",
          cdpEndpoint:
            "ws://browser-runtime:9222/devtools/browser/other-browser",
        };
      },
    };

    await expect(
      issuePublishingBrowserCapabilityGrant({
        jobId: "job-browser",
        browserProvider: mismatchedProvider,
        browserSession: harness.session,
        allowedOrigins: ["https://creator.xiaohongshu.com"],
        uploadRoot,
        authorizeClick: allowSafeClicks,
      }),
    ).rejects.toThrow(
      "BrowserProvider returned an attachment for a different session",
    );
  });
});
