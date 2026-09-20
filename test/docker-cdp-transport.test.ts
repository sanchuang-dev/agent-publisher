import { expect, test } from "vitest";

import { resolveCdpWebSocketEndpoint } from "../src/browser/providers/docker-cdp-transport.js";

test("uses a configured WebSocket CDP endpoint directly", async () => {
  await expect(
    resolveCdpWebSocketEndpoint(
      "ws://browser-runtime:9222/devtools/browser/browser-id",
      1_000,
      async () => {
        throw new Error("fetch should not run for a WebSocket endpoint");
      },
    ),
  ).resolves.toBe(
    "ws://browser-runtime:9222/devtools/browser/browser-id",
  );
});

test("resolves the Compose service name to an internal IP for CDP discovery and WebSocket handshakes", async () => {
  let requestedUrl = "";
  let resolvedHostname = "";

  const fetchImpl = (async (input: string | URL | Request) => {
    requestedUrl = input.toString();
    return new Response(
      JSON.stringify({
        webSocketDebuggerUrl:
          "ws://127.0.0.1:9223/devtools/browser/browser-id",
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  await expect(
    resolveCdpWebSocketEndpoint(
      "http://browser-runtime:9222",
      1_000,
      fetchImpl,
      async (hostname) => {
        resolvedHostname = hostname;
        return "172.18.0.2";
      },
    ),
  ).resolves.toBe(
    "ws://172.18.0.2:9222/devtools/browser/browser-id",
  );

  expect(resolvedHostname).toBe("browser-runtime");
  expect(requestedUrl).toBe(
    "http://172.18.0.2:9222/json/version",
  );
});

test("reports an explicit discovery failure when Chromium health is not successful", async () => {
  const fetchImpl = (async () =>
    new Response("not ready", { status: 503 })) as typeof fetch;

  await expect(
    resolveCdpWebSocketEndpoint(
      "http://127.0.0.1:9222",
      1_000,
      fetchImpl,
    ),
  ).rejects.toThrow(
    "Browser CDP discovery failed with HTTP 503",
  );
});

test("rejects discovery payloads without a browser WebSocket endpoint", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ Browser: "Chromium" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    })) as typeof fetch;

  await expect(
    resolveCdpWebSocketEndpoint(
      "http://127.0.0.1:9222",
      1_000,
      fetchImpl,
    ),
  ).rejects.toThrow(
    "Browser CDP discovery response did not include a WebSocket endpoint",
  );
});

test("reports a clear error when a Compose service name cannot be resolved", async () => {
  await expect(
    resolveCdpWebSocketEndpoint(
      "http://browser-runtime:9222",
      1_000,
      async () => {
        throw new Error("fetch should not run before host resolution");
      },
      async () => {
        throw new Error("getaddrinfo ENOTFOUND browser-runtime");
      },
    ),
  ).rejects.toThrow(
    "Browser CDP host resolution failed for browser-runtime: getaddrinfo ENOTFOUND browser-runtime",
  );
});
