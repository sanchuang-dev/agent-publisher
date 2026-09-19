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
  readonly #releasePromises = new Map<string, Promise<void>>();
  readonly #releasingSessionIds = new Set<string>();
  // MVP exclusivity is process-wide: the accepted deployment is one Node app
  // process driving one browser-runtime/profile. Distributed/multi-replica
  // locking is intentionally out of scope; release ownership remains local to
  // the provider instance that acquired the session.
  static #activeSessionId: string | undefined;

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
    if (DockerCdpBrowserProvider.#activeSessionId !== undefined) {
      throw new Error(
        "Browser session already active or being acquired. Wait for it to be released before acquiring a new session.",
      );
    }

    // Reserve the single MVP slot before the first async boundary so two
    // concurrent acquire() calls cannot both attach to the persistent browser.
    const id = randomUUID();
    DockerCdpBrowserProvider.#activeSessionId = id;

    let connection: ConnectedBrowser | undefined;

    try {
      connection = await this.#connect();

      // A runtime restart or transport loss invalidates the app-side session.
      // Chromium itself is owned by browser-runtime and must not be closed here.
      connection.browser.once("disconnected", () => {
        // release() owns cleanup while an intentional transport teardown is
        // in progress; otherwise this is an unexpected session loss.
        if (this.#releasingSessionIds.has(id)) {
          return;
        }

        this.#clearSession(id);
      });

      const context = connection.browser.contexts()[0];
      if (!context) {
        throw new Error(
          "Browser runtime is reachable but has no browser context",
        );
      }

      const page =
        context.pages().find((candidate) => !candidate.isClosed()) ??
        (await context.newPage());

      if (DockerCdpBrowserProvider.#activeSessionId !== id) {
        throw new Error("Browser session disconnected during acquisition");
      }

      this.#connections.set(id, connection.transport);

      return {
        id,
        page,
        profileRef: this.#profileRef,
      };
    } catch (error) {
      if (connection) {
        try {
          await connection.transport.disconnect();
        } catch (disconnectError) {
          throw new AggregateError(
            [error, disconnectError],
            "Browser session acquisition failed and the app-side CDP connection could not be released",
          );
        }
      }

      throw error;
    } finally {
      if (
        !this.#connections.has(id) &&
        DockerCdpBrowserProvider.#activeSessionId === id
      ) {
        DockerCdpBrowserProvider.#activeSessionId = undefined;
      }
    }
  }

  async release(sessionId: string): Promise<void> {
    const existingRelease =
      this.#releasePromises.get(sessionId);
    if (existingRelease) {
      await existingRelease;
      return;
    }

    const transport = this.#connections.get(sessionId);
    if (!transport) {
      return;
    }

    this.#releasingSessionIds.add(sessionId);
    const releasePromise = Promise.resolve()
      .then(() => transport.disconnect())
      .finally(() => {
        this.#releasingSessionIds.delete(sessionId);
        this.#clearSession(sessionId);
        this.#releasePromises.delete(sessionId);
      });

    this.#releasePromises.set(sessionId, releasePromise);
    await releasePromise;
  }

  #clearSession(sessionId: string): void {
    this.#connections.delete(sessionId);

    if (DockerCdpBrowserProvider.#activeSessionId === sessionId) {
      DockerCdpBrowserProvider.#activeSessionId = undefined;
    }
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
