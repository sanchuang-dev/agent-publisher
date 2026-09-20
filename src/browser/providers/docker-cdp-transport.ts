import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export type ResolveCdpHostname = (hostname: string) => Promise<string>;

async function resolveDockerHostname(hostname: string): Promise<string> {
  if (isLoopbackHost(hostname) || isIP(hostname) !== 0) {
    return hostname;
  }

  const result = await lookup(hostname, { family: 4 });
  return result.address;
}

/**
 * Resolve an HTTP CDP endpoint into the browser WebSocket endpoint that the
 * Playwright client should attach to.
 *
 * Chromium in browser-runtime intentionally keeps DevTools on loopback. A
 * supervised TCP forwarder exposes it only to the Compose network. Chromium's
 * /json/version response therefore advertises its loopback address; rewrite
 * that address to the current Compose-internal browser-runtime IP before
 * handing the WebSocket URL to Playwright.
 *
 * We deliberately do not implement a WebSocket/CDP transport here. Playwright
 * owns that protocol transport and its lifecycle.
 */
export async function resolveCdpWebSocketEndpoint(
  endpoint: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  resolveHostname: ResolveCdpHostname = resolveDockerHostname,
): Promise<string> {
  let endpointUrl: URL;

  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error("Browser CDP endpoint must be an absolute URL");
  }

  if (endpointUrl.protocol === "ws:" || endpointUrl.protocol === "wss:") {
    return endpointUrl.toString();
  }

  if (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") {
    throw new Error("Browser CDP endpoint must use http(s) or ws(s)");
  }

  let connectionHostname = endpointUrl.hostname;

  if (
    endpointUrl.protocol === "http:" &&
    !isLoopbackHost(endpointUrl.hostname) &&
    isIP(endpointUrl.hostname) === 0
  ) {
    try {
      connectionHostname = await resolveHostname(endpointUrl.hostname);
    } catch (error) {
      throw new Error(
        `Browser CDP host resolution failed for ${endpointUrl.hostname}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (isIP(connectionHostname) === 0) {
      throw new Error(
        `Browser CDP host resolution returned a non-IP address for ${endpointUrl.hostname}`,
      );
    }
  }

  const versionUrl = new URL(endpointUrl);
  versionUrl.hostname = connectionHostname;
  const basePath = versionUrl.pathname.endsWith("/")
    ? versionUrl.pathname
    : `${versionUrl.pathname}/`;
  versionUrl.pathname = `${basePath}json/version`;
  versionUrl.search = "";
  versionUrl.hash = "";

  const requestInit: RequestInit = {
    headers: {
      accept: "application/json",
    },
  };

  if (timeoutMs > 0) {
    requestInit.signal = AbortSignal.timeout(timeoutMs);
  }

  const response = await fetchImpl(versionUrl, requestInit);

  if (!response.ok) {
    throw new Error(
      `Browser CDP discovery failed with HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as {
    webSocketDebuggerUrl?: unknown;
  };

  if (typeof payload.webSocketDebuggerUrl !== "string") {
    throw new Error(
      "Browser CDP discovery response did not include a WebSocket endpoint",
    );
  }

  let webSocketUrl: URL;
  try {
    webSocketUrl = new URL(payload.webSocketDebuggerUrl);
  } catch {
    throw new Error("Browser CDP discovery returned an invalid WebSocket URL");
  }

  if (
    webSocketUrl.protocol !== "ws:" &&
    webSocketUrl.protocol !== "wss:"
  ) {
    throw new Error("Browser CDP discovery returned a non-WebSocket URL");
  }

  if (
    isLoopbackHost(webSocketUrl.hostname) &&
    !isLoopbackHost(endpointUrl.hostname)
  ) {
    webSocketUrl.protocol =
      endpointUrl.protocol === "https:" ? "wss:" : "ws:";
    webSocketUrl.hostname = connectionHostname;
    webSocketUrl.port = endpointUrl.port;
  }

  return webSocketUrl.toString();
}
