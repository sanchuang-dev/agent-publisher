import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
            <input type="file" />
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
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\function refFor(messages: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = messages.match(
    new RegExp(`${escaped}[^\\n]*\\[ref=(e\\d+)\\]`, "i"),
  );
  if (!match?.[1]) {
    throw new Error(`Could not find snapshot ref for ${label}`);
  }
  return match[1];
}
");
  const match = messages.match(
    new RegExp(`${escaped}[^\\n]*\\[ref=(e\\d+)\\]`, "i"),
  );
  if (!match?.[1]) {
    throw new Error(`Could not find snapshot ref for ${label}`);
  }
  return match[1];
}

async function playwrightMcpPids(): Promise<Set<number>> {
  const pids = new Set<number>();
  let entries;
  try {
    entries = await readdir("/proc", { withFileTypes: true });
  } catch {
    return pids;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\\d+$/.test(entry.name))
      .map(async (entry) => {
        try {
          const cmdline = await readFile(`/proc/${entry.name}/cmdline`, "utf8");
          if (cmdline.includes("@playwright/mcp/cli.js")) {
            pids.add(Number.parseInt(entry.name, 10));
          }
        } catch {
          // Process may exit between directory enumeration and cmdline read.
        }
      }),
  );
  return pids;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidsToExit(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isPidAlive(pid))) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(
    `Playwright MCP child remained alive after AgentSession dispose: ${pids.join(",")}`,
  );
}

async function main(): Promise<void> {
  const uploadRoot = await mkdtemp(join(tmpdir(), "publisher-brw01-smoke-"));
  const coverPath = join(uploadRoot, "cover.txt");
  await writeFile(coverPath, "BRW-01 controlled upload");
  const baselineMcpPids = await playwrightMcpPids();
  const server = await startFixture();
  let session: Awaited<ReturnType<PiAgentHost["createSession"]>> | undefined;

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

    session = await host.createSession({
      definition,
      scope: { jobId: grant.jobId, role: "publishing" },
    });

    let staleUploadImageTextRef: string | undefined;

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
        staleUploadImageTextRef = refFor(messages, "上传图文");

        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_navigate",
              args: { url: `${fixtureOrigin}/image-text` },
            },
            { id: "navigate-away-from-stale-ref" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const messages = serializedMessages(context);
        if (!messages.includes("图文发布") || !staleUploadImageTextRef) {
          throw new Error("Failed to establish the stale-ref test state");
        }

        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_click",
              args: {
                element: "stale 上传图文 ref",
                target: staleUploadImageTextRef,
              },
            },
            { id: "stale-ref-click" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const latestSerialized = JSON.stringify(context.messages.at(-1));
        if (
          !latestSerialized.includes(
            "not found in the current page snapshot",
          )
        ) {
          throw new Error(
            "Playwright MCP silently accepted a stale observation ref",
          );
        }

        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_navigate",
              args: { url: `${fixtureOrigin}/video` },
            },
            { id: "return-video-after-stale-ref" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const messages = serializedMessages(context);
        if (!messages.includes("上传视频")) {
          throw new Error("Failed to return to the video publishing surface");
        }

        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_snapshot",
              args: {},
            },
            { id: "refresh-snapshot-after-stale-ref" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const messages = serializedMessages(context);
        const freshUploadImageTextRef = refFor(messages, "上传图文");

        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_click",
              args: {
                element: "上传图文",
                target: freshUploadImageTextRef,
              },
            },
            { id: "click-image-text-with-fresh-ref" },
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
        const uploadRef = refFor(messages, "Choose File");
        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_click",
              args: {
                element: "Cover file chooser",
                target: uploadRef,
              },
            },
            { id: "open-file-chooser" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const messages = serializedMessages(context);
        if (!messages.includes("File chooser")) {
          throw new Error("browser_click did not open the file chooser modal state");
        }
        return fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool: "browser_file_upload",
              args: { paths: [coverPath] },
            },
            { id: "upload-cover" },
          ),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        const latest = context.messages.at(-1);
        const latestSerialized = JSON.stringify(latest);
        if (
          latestSerialized.includes('"isError":true') ||
          latestSerialized.includes("File access denied")
        ) {
          throw new Error("Controlled browser_file_upload did not succeed");
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

    const activeMcpPids = [...(await playwrightMcpPids())].filter(
      (pid) => !baselineMcpPids.has(pid),
    );
    if (activeMcpPids.length === 0) {
      throw new Error(
        "Playwright MCP integration completed without an observable session-owned MCP child",
      );
    }

    await session.dispose();
    session = undefined;
    await waitForPidsToExit(activeMcpPids);

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
          "stale-snapshot-ref-rejected",
          "snapshot-ref-navigation",
          "controlled-type",
          "controlled-file-upload",
          "mcp-child-stopped-on-session-dispose",
          "persistent-browser-survived-session-dispose",
        ],
      }) + "\n",
    );
  } finally {
    if (session) {
      try {
        await session.dispose();
      } catch {
        // Preserve the primary smoke failure; process teardown is bounded by
        // the outer CI timeout and separately asserted on the success path.
      }
    }
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
