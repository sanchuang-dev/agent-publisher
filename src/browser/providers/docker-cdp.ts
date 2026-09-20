import { randomUUID } from "node:crypto";

import { chromium, type Browser } from "playwright";

import type {
  BrowserAcquireInput,
  BrowserProvider,
  BrowserProviderHealth,
  BrowserSession,
} from "../provider.js";
import { resolveCdpWebSocketEndpoint } from "./docker-cdp-transport.js";

export const DEFAULT_DOCKER_CDP_ENDPOINT = "http://browser-runtime:9222";
export const DEFAULT_DOCKER_PROFILE_REF = "browser-profile";

type ResolveCdpEndpoint = (
  endpoint: string,
  timeoutMs: number,
) => Promise<string>;

type ConnectOverCdp = (
  endpointURL: string,
  options: {
    timeout: number;
    noDefaults: true;
    isLocal: false;
  },
) => Promise<Browser>;

export interface DockerCdpBrowserProviderOptions {
  readonly endpoint?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly connectTimeoutMs?: number;
  readonly profileRef?: string;
  readonly resolveEndpoint?: ResolveCdpEndpoint;
  readonly connectOverCDP?: ConnectOverCdp;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DockerCdpBrowserProvider implements BrowserProvider {
  readonly #endpoint: string;
  readonly #connectTimeoutMs: number;
  readonly #profileRef: string;
  readonly #resolveEndpoint: ResolveCdpEndpoint;
  readonly #connectOverCDP: ConnectOverCdp;
  readonly #connections = new Map<string, Browser>();
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
    this.#resolveEndpoint =
      options.resolveEndpoint ?? resolveCdpWebSocketEndpoint;
    this.#connectOverCDP =
      options.connectOverCDP ??
      ((endpointURL, connectOptions) =>
        chromium.connectOverCDP(endpointURL, connectOptions));
  }

  async acquire(_input: BrowserAcquireInput): Promise<BrowserSession> {
    if (DockerCdpBrowserProvider.#activeSessionId !== undefined) {
      throw new Error(
        "Browser session already active or being acquired. Wait for it to be released before acquiring a new session.",
      );
    }

    const id = randomUUID();
    DockerCdpBrowserProvider.#activeSessionId = id;

    let browser: Browser | undefined;

    try {
      browser = await this.#connect();

      browser.once("disconnected", () => {
        if (this.#releasingSessionIds.has(id)) {
          return;
        }

        this.#clearSession(id);
      });

      const context = browser.contexts()[0];
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

      this.#connections.set(id, browser);

      return {
        id,
        page,
        profileRef: this.#profileRef,
      };
    } catch (error) {
      if (browser) {
        try {
          await browser.close();
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
    const existingRelease = this.#releasePromises.get(sessionId);
    if (existingRelease) {
      await existingRelease;
      return;
    }

    const browser = this.#connections.get(sessionId);
    if (!browser) {
      if (DockerCdpBrowserProvider.#activeSessionId === sessionId) {
        throw new Error(
          "Browser session is owned by another provider instance and cannot be released here",
        );
      }
      return;
    }

    this.#releasingSessionIds.add(sessionId);
    const releasePromise = Promise.resolve()
      // For a browser obtained through connectOverCDP(), Playwright closes the
      // client transport here; it does not terminate the externally-owned
      // Chromium process. The real integration/runtime smokes enforce this.
      .then(() => browser.close())
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
    let browser: Browser | undefined;

    try {
      browser = await this.#connect();
      await browser.close();

      return {
        status: "reachable",
      };
    } catch (error) {
      if (browser) {
        try {
          await browser.close();
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

  async #connect(): Promise<Browser> {
    const endpointURL = await this.#resolveEndpoint(
      this.#endpoint,
      this.#connectTimeoutMs,
    );

    return await this.#connectOverCDP(endpointURL, {
      timeout: this.#connectTimeoutMs,
      noDefaults: true,
      isLocal: false,
    });
  }
}
