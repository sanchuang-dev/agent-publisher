import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface CdpTransport {
  open?(): void;
  send(message: object): void;
  close(): void;
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
}

export interface ManagedCdpTransport extends CdpTransport {
  disconnect(): Promise<void>;
}

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

  // Headful Chromium exposes DevTools on loopback and rejects non-IP Host
  // headers. Keep the configured Compose service name as the stable contract,
  // but resolve it on every connection so discovery and WebSocket handshakes
  // use the browser-runtime container's current internal IP.
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

async function waitForWebSocketOpen(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      if (timer) {
        clearTimeout(timer);
      }
    };

    const handleOpen = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error("Browser CDP WebSocket connection failed"));
    };

    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Browser CDP WebSocket connection timed out"));
      }, timeoutMs);
    }
  });
}

async function webSocketDataToText(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text();
  }

  throw new Error("Browser CDP WebSocket received an unsupported frame");
}

class WebSocketCdpTransport implements ManagedCdpTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;

  readonly #socket: WebSocket;
  readonly #closed: Promise<void>;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    this.#closed = new Promise((resolve) => {
      socket.addEventListener(
        "close",
        (event) => {
          resolve();
          this.onclose?.(event.reason || undefined);
        },
        { once: true },
      );
    });

    socket.addEventListener("message", (event) => {
      void webSocketDataToText(event.data)
        .then((text) => {
          this.onmessage?.(JSON.parse(text) as object);
        })
        .catch(() => {
          if (
            this.#socket.readyState === WebSocket.CONNECTING ||
            this.#socket.readyState === WebSocket.OPEN
          ) {
            this.#socket.close(1002, "Invalid CDP frame");
          }
        });
    });
  }

  send(message: object): void {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Browser CDP WebSocket is not open");
    }

    this.#socket.send(JSON.stringify(message));
  }

  close(): void {
    if (
      this.#socket.readyState === WebSocket.CONNECTING ||
      this.#socket.readyState === WebSocket.OPEN
    ) {
      this.#socket.close();
    }
  }

  async disconnect(): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) {
      return;
    }

    this.close();
    await this.#closed;
  }
}

export async function createWebSocketCdpTransport(
  endpoint: string,
  timeoutMs: number,
): Promise<ManagedCdpTransport> {
  const webSocketEndpoint = await resolveCdpWebSocketEndpoint(
    endpoint,
    timeoutMs,
  );
  const socket = new WebSocket(webSocketEndpoint);
  socket.binaryType = "arraybuffer";

  try {
    await waitForWebSocketOpen(socket, timeoutMs);
  } catch (error) {
    socket.close();
    throw error;
  }

  return new WebSocketCdpTransport(socket);
}
