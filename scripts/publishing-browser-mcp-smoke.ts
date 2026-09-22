import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { AgentDefinition } from "../src/agent/definition.js";
import { PiAgentHost } from "../src/agent/pi-agent-host.js";
import { resolveCdpWebSocketEndpoint } from "../src/browser/providers/docker-cdp-transport.js";
import {
  PUBLISHING_BROWSER_MCP_SERVER,
  createPublishingBrowserMcpProfile,
  createPublishingBrowserResourceLoader,
  type PublishingBrowserCapabilityGrant,
} from "../src/agent/publishing-browser-mcp.js";

const cdpEndpoint =
  process.env.BROWSER_CDP_ENDPOINT?.trim() || "http://browser-runtime:9222";
const fixtureOrigin =
  process.env.BRW01_SMOKE_ORIGIN?.trim() || "http://app-smoke:3101";
const fixturePort = Number(new URL(fixtureOrigin).port || "80");

function fixtureHtml(pathname: string): string {
  if (pathname === "/image-text") {
    return `<!doctype html>
      <html lang="zh-CN">
        <head><meta charset="utf-8"><title>图文发布</title></head>
        <body>
          <main>
            <h1>图文发布</h1>
            <label>标题 <input aria-label="标题" /></label>
            <p>BRW-01 destination reached</p>
          </main>
        </body>
      </html>`;
  }

  return `<!doctype html>
    <html lang="zh-CN">
      <head><meta charset="utf-8"><title>上传视频</title></head>
      <body>
        <main>
          <h1>上传视频</h1>
          <button onclick="location.href='/image-text'">上传图文</button>
        </main>
      </body>
    </html>`;
}

async function startFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", fixtureOrigin);
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(fixtureHtml(url.pathname));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(fixturePort, "0.0.0.0", resolve);
  });

  return server;
}

function serializedMessages(context: { messages: readonly unknown[] }): string {
  return JSON.stringify(context.messages);
}

function refFor(messages: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = messages.match(
    new RegExp(`${escaped}[^\\n]*\\[ref=(e\\d+)\\]`, "i"),
  );
  if (!match?.[1]) {
    throw new Error(`Could not find snapshot ref for ${label}`);
  }
  return match[1];
}

async function main(): Promise<void> {
  const uploadRoot = await mkdtemp(join(tmpdir(), "publisher-brw01-smoke-"));
  const server = await startFixture();

  try {
    const faux = fauxProvider({ provider: "publisher-brw01-docker-smoke" });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);

    const grant: PublishingBrowserCapabilityGrant = {
      jobId: "brw01-docker-smoke",
      browserSessionId: "brw01-docker-browser",
      cdpEndpoint,
      allowedOrigins: [fixtureOrigin],
      uploadRoot,
    };

    const browserMcpProfile = await createPublishingBrowserMcpProfile(grant);

    const definition: AgentDefinition = {
      id: "publishing-secretary-browser-smoke",
      systemPrompt: [
        "You are the bounded Publishing Secretary browser smoke worker.",
        "Use only the Publisher-provisioned browser MCP capability.",
        "Do not use selectors supplied by the prompt; observe the current page and act using snapshot refs.",
        "Never attempt a final publication action.",
      ].join("\n"),
      mcp: browserMcpProfile,
    };

    const host = new PiAgentHost({
      model: faux.getModel(),
      modelRuntime,
      tools: [],
      defaultRunTimeoutMs: 15_000,
      defaultAbortTimeoutMs: 1_000,
      defaultDisposeTimeoutMs: 3_000,
      sessionOptions: { thinkingLevel: "off" },
      createResourceLoader: (input) =>
        createPublishingBrowserResourceLoader(input, grant),
    });

    const session = await host.createSession({
      definition,
      scope: { jobId: grant.jobId, role: "publishing" },
    });

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "mcp",
          {
            search: "page snapshot navigate click type",
            server: PUBLISHING_BROWSER_MCP_SERVER,
          },
          { id: "discover-browser-tools" },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const messages = serializedMessages(context);
        for (const expected of [
          "browser_snapshot",
          "browser_navigate",
          "browser_click",
          "browser_type",
          "browser_file_upload",
        ]) {
          if (!messages.includes(expected)) {
            throw new Error(`Allowed Playwright MCP tool missing: ${expected}`);
          }
        }
        for (const forbidden of [
          "browser_evaluate",
          "browser_run_code_unsafe",
          "browser_close",
        ]) {
          if (messages.includes(forbidden)) {
            throw new Error(`Forbidden Playwright MCP tool leaked: ${forbidden}`);
          }
        }

        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_navigate",
              args: { url: "https://example.com/not-authorized" },
            },
            { id: "wrong-origin" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const messages = serializedMessages(context);
        if (!messages.includes("outside the Publisher browser grant")) {
          throw new Error("Wrong-origin browser navigation was not blocked");
        }

        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_navigate",
              args: { url: `${fixtureOrigin}/video` },
            },
            { id: "navigate-video" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const messages = serializedMessages(context);
        if (!messages.includes("上传视频")) {
          throw new Error("Playwright MCP did not observe the video fixture page");
        }

        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_snapshot",
              args: {},
            },
            { id: "snapshot-video" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const messages = serializedMessages(context);
        const uploadImageTextRef = refFor(messages, "上传图文");

        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_click",
              args: {
                element: "上传图文",
                target: uploadImageTextRef,
              },
            },
            { id: "click-image-text" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const messages = serializedMessages(context);
        if (
          !messages.includes("图文发布") ||
          !messages.includes("BRW-01 destination reached")
        ) {
          throw new Error(
            "Agent-selected click did not reach the image-text destination",
          );
        }
        const titleRef = refFor(messages, "标题");

        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_type",
              args: {
                element: "标题",
                target: titleRef,
                text: "BRW-01 controlled fill",
              },
            },
            { id: "type-title" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const messages = serializedMessages(context);
        if (!messages.includes("BRW-01 controlled fill")) {
          throw new Error("Controlled browser_type did not update the form");
        }
        return fauxAssistantMessage(fauxText("BRW01_DOCKER_MCP_SMOKE_OK"));
      },
    ]);

    const result = await session.run({
      prompt:
        "From the current publishing surface, enter the image-text publishing surface and fill the title field. Choose the route from page observation; no selector is provided.",
    });

    if (result.finalText !== "BRW01_DOCKER_MCP_SMOKE_OK") {
      throw new Error(`Unexpected smoke result: ${result.finalText}`);
    }

    await session.dispose();

    try {
      await resolveCdpWebSocketEndpoint(cdpEndpoint, 5_000);
    } catch (error) {
      throw new Error(
        "Disposing the AgentSession made the persistent Docker Chromium unavailable",
        { cause: error },
      );
    }

    process.stdout.write(
      JSON.stringify({
        status: "ok",
        evidence: [
          "official-playwright-mcp-connected-over-cdp",
          "bounded-tool-catalog",
          "wrong-origin-blocked",
          "snapshot-ref-navigation",
          "controlled-type",
          "persistent-browser-survived-session-dispose",
        ],
      }) + "\n",
    );
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(uploadRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? `BRW-01 Docker MCP smoke failed: ${error.message}`
      : "BRW-01 Docker MCP smoke failed",
  );
  process.exitCode = 1;
});
