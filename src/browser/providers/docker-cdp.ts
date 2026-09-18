import { randomUUID } from "node:crypto";

import { chromium, type Browser } from "playwright";

import type {
  BrowserAcquireInput,
  BrowserProvider,
  BrowserProviderHealth,
  BrowserSession,
} from "../provider.js";
import {
  createWebSocketCdpTransport,
  type CdpTransport,
  type ManagedCdpTransport,
} from "./docker-cdp-transport.js";

export const DEFAULT_DOCKER_CDP_ENDPOINT = "http://browser-runtime:9222";
export const DEFAULT_DOCKER_PROFILE_REF = "browser-profile";

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

    await transport.disconnect();
    this.#connections.delete(sessionId);
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
        // Preserve the original connection error.
      }

      throw error;
    }
  }
}
