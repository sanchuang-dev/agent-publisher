import { randomUUID } from "node:crypto";

import { chromium, type Browser } from "playwright";

import type {
  BrowserAcquireInput,
  BrowserProvider,
  BrowserProviderHealth,
  BrowserSession,
} from "../provider.js";

export const DEFAULT_DOCKER_CDP_ENDPOINT = "http://browser-runtime:9222";
export const DEFAULT_DOCKER_PROFILE_REF = "browser-profile";

interface CdpTransport {
  open?(): void;
  send(message: object): void;
  close(): void;
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
}

interface ManagedCdpTransport extends CdpTransport {
  disconnect(): Promise<void>;
}

type CreateCdpTransport = (
  endpoint: string,
  timeoutMs: number,
) => Promise<ManagedCdpTransport>;

type ConnectOverCdp = (
  transport: CdpTransport,
  options: {
    timeout: number;
    noDefaults: true;
  },
) => Promise<Browser>;

export interface DockerCdpBrowserProviderOptions {
  readonly endpoint?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly connectTimeoutMs?: number;
  readonly profileRef?: string;
  readonly createTransport?: CreateCdpTransport;
  readonly connectOverCDP?: ConnectOverCdp;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

async function resolveCdpWebSocketEndpoint(
  endpoint: string,
  timeoutMs: number,
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

  const versionUrl = new URL(endpointUrl);
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

  const response = await fetch(versionUrl, requestInit);

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
    webSocketUrl.hostname = endpointUrl.hostname;
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

async function createWebSocketCdpTransport(
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

interface ConnectedBrowser {
  readonly browser: Browser;
  readonly transport: ManagedCdpTransport;
}

export class DockerCdpBrowserProvider implements BrowserProvider {
  readonly #endpoint: string;
  readonly #connectTimeoutMs: number;
  readonly #profileRef: string;
  readonly #createTransport: CreateCdpTransport;
  readonly #connectOverCDP: ConnectOverCdp;
  readonly #connections = new Map<string, ManagedCdpTransport>();

  constructor(options: DockerCdpBrowserProviderOptions = {}) {
    const env = options.env ?? process.env;
    const endpoint = (
      options.endpoint ??
      env.BROWSER_CDP_ENDPOINT ??
      DEFAULT_DOCKER_CDP_ENDPOINT
    ).trim();

    if (endpoint.length === 0) {
      throw new Error("Browser CDP endpoint must not be empty");
    }

    const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 0) {
      throw new Error(
        "Browser CDP connect timeout must be a non-negative finite number",
      );
    }

    this.#endpoint = endpoint;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#profileRef = options.profileRef ?? DEFAULT_DOCKER_PROFILE_REF;
    this.#createTransport =
      options.createTransport ?? createWebSocketCdpTransport;
    this.#connectOverCDP =
      options.connectOverCDP ??
      ((transport, connectOptions) =>
        chromium.connectOverCDP(transport, connectOptions));
  }

  async acquire(_input: BrowserAcquireInput): Promise<BrowserSession> {
    const connection = await this.#connect();

    try {
      const context = connection.browser.contexts()[0];
      if (!context) {
        throw new Error(
          "Browser runtime is reachable but has no browser context",
        );
      }

      const page =
        context.pages().find((candidate) => !candidate.isClosed()) ??
        (await context.newPage());

      const id = randomUUID();
      this.#connections.set(id, connection.transport);

      return {
        id,
        page,
        profileRef: this.#profileRef,
      };
    } catch (error) {
      try {
        await connection.transport.disconnect();
      } catch (disconnectError) {
        throw new AggregateError(
          [error, disconnectError],
          "Browser session acquisition failed and the app-side CDP connection could not be released",
        );
      }

      throw error;
    }
  }

  async release(sessionId: string): Promise<void> {
    const transport = this.#connections.get(sessionId);
    if (!transport) {
      return;
    }

    this.#connections.delete(sessionId);
    await transport.disconnect();
  }

  async health(): Promise<BrowserProviderHealth> {
    let connection: ConnectedBrowser | undefined;

    try {
      connection = await this.#connect();
      await connection.transport.disconnect();

      return {
        status: "reachable",
      };
    } catch (error) {
      if (connection) {
        try {
          await connection.transport.disconnect();
        } catch (disconnectError) {
          return {
            status: "unavailable",
            message: `${errorMessage(error)}; connection cleanup failed: ${errorMessage(
              disconnectError,
            )}`,
          };
        }
      }

      return {
        status: "unavailable",
        message: errorMessage(error),
      };
    }
  }

  async #connect(): Promise<ConnectedBrowser> {
    const transport = await this.#createTransport(
      this.#endpoint,
      this.#connectTimeoutMs,
    );

    try {
      const browser = await this.#connectOverCDP(transport, {
        timeout: this.#connectTimeoutMs,
        noDefaults: true,
      });

      return {
        browser,
        transport,
      };
    } catch (error) {
      try {
        await transport.disconnect();
      } catch {
        // Preserve the original connection error. The health/acquire caller
        // already treats this attempt as unavailable.
      }

      throw error;
    }
  }
}
