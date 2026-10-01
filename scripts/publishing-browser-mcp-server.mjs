import { createRequire } from "node:module";

import playwrightMcp from "@playwright/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

function requiredArg(name) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((value) => value.startsWith(prefix));
  const value = raw?.slice(prefix.length).trim();
  if (!value) {
    throw new Error(`Missing required ${prefix}<value>`);
  }
  return value;
}

function playwrightFromMcpPackage() {
  const require = createRequire(import.meta.url);
  const mcpPackagePath = require.resolve("@playwright/mcp/package.json");
  const mcpRequire = createRequire(mcpPackagePath);
  return mcpRequire("playwright");
}

async function findBoundPage(context, pageRef) {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    try {
      if ((await page.evaluate(() => window.name)) === pageRef) {
        return page;
      }
    } catch {
      // A page that cannot be inspected is not the Publisher-bound page.
    }
  }
  return null;
}

function narrowContextToPage(context, page) {
  let proxy;
  proxy = new Proxy(context, {
    get(target, property) {
      if (property === "pages") {
        return () => (page.isClosed() ? [] : [page]);
      }
      if (property === "newPage") {
        return async () => {
          throw new Error(
            "Publisher browser attachment does not authorize creating another page",
          );
        };
      }
      if (
        property === "on" ||
        property === "addListener" ||
        property === "once"
      ) {
        const subscribe = target[property].bind(target);
        return (event, listener) => {
          if (event === "page") return proxy;
          subscribe(event, listener);
          return proxy;
        };
      }
      if (property === "off" || property === "removeListener") {
        const unsubscribe = target[property].bind(target);
        return (event, listener) => {
          if (event === "page") return proxy;
          unsubscribe(event, listener);
          return proxy;
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxy;
}

const cdpEndpoint = requiredArg("cdp-endpoint");
const pageRef = requiredArg("page-ref");
const { chromium } = playwrightFromMcpPackage();
const browser = await chromium.connectOverCDP(cdpEndpoint, {
  timeout: 30_000,
  noDefaults: true,
});

const context = browser.contexts()[0];
if (!context) {
  await browser.close().catch(() => {});
  throw new Error("Publisher MCP attachment found no browser context");
}

const page = await findBoundPage(context, pageRef);
if (!page) {
  await browser.close().catch(() => {});
  throw new Error("Publisher MCP attachment could not find the Job-owned page");
}

const narrowedContext = narrowContextToPage(context, page);
const createConnection = playwrightMcp.createConnection;
if (typeof createConnection !== "function") {
  await browser.close().catch(() => {});
  throw new Error("@playwright/mcp does not expose createConnection");
}

const server = await createConnection(
  {
    webmcp: false,
    imageResponses: "omit",
    codegen: "none",
  },
  async () => narrowedContext,
);
const transport = new StdioServerTransport();

let closing = false;
async function shutdown(exitCode = 0) {
  if (closing) return;
  closing = true;
  await server.close().catch(() => {});
  await browser.close().catch(() => {});
  process.exitCode = exitCode;
}

process.once("SIGTERM", () => {
  void shutdown(0);
});
process.once("SIGINT", () => {
  void shutdown(0);
});
process.stdin.once("end", () => {
  void shutdown(0);
});

try {
  await server.connect(transport);
} catch (error) {
  await shutdown(1);
  throw error;
}
