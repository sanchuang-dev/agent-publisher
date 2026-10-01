import { createHash, randomUUID } from "node:crypto";

import { chromium, type Browser } from "playwright";

import type {
  BrowserAcquireInput,
  BrowserAutomationAttachmentProvider,
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

const JOB_PAGE_MARKER_PREFIX = "__agent_publisher_job__:";

function requiredJobId(input: BrowserAcquireInput): string {
  const jobId = input.jobId.trim();
  if (!jobId) {
    throw new Error("Browser acquisition requires a non-empty Job id");
  }
  return jobId;
}

function jobPageMarker(jobId: string): string {
  // The marker survives CDP reconnects/navigation through window.name without
  // exposing the Publisher Job id itself to page script.
  return (
    JOB_PAGE_MARKER_PREFIX +
    createHash("sha256").update(jobId).digest("hex")
  );
}

async function readPageMarker(page: import("playwright").Page): Promise<string | null> {
  if (page.isClosed()) return null;

  try {
    return await page.evaluate(() => window.name);
  } catch {
    return null;
  }
}

async function findJobPage(
  pages: readonly import("playwright").Page[],
  marker: string,
): Promise<import("playwright").Page | null> {
  for (const page of pages) {
    if ((await readPageMarker(page)) === marker) {
      return page;
    }
  }
  return null;
}

async function bindJobPage(
  page: import("playwright").Page,
  marker: string,
): Promise<void> {
  await page.evaluate((value) => {
    window.name = value;
  }, marker);
}

export class DockerCdpBrowserProvider
  implements BrowserAutomationAttachmentProvider
{
  readonly #endpoint: string;
  readonly #connectTimeoutMs: number;
  readonly #profileRef: string;
  readonly #resolveEndpoint: ResolveCdpEndpoint;
  readonly #connectOverCDP: ConnectOverCdp;
  readonly #connections = new Map<
    string,
    { readonly browser: Browser; readonly pageRef: string }
  >();
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

  async acquire(input: BrowserAcquireInput): Promise<BrowserSession> {
    const jobId = requiredJobId(input);

    if (DockerCdpBrowserProvider.#activeSessionId !== undefined) {
      throw new Error(
        "Browser session already active or being acquired. Wait for it to be released before acquiring a new session.",
      );
    }

    const id = randomUUID();
    const marker = jobPageMarker(jobId);
    DockerCdpBrowserProvider.#activeSessionId = id;

    let browser: Browser | undefined;
    let createdPage: import("playwright").Page | undefined;

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

      let page = await findJobPage(context.pages(), marker);
      if (!page) {
        createdPage = await context.newPage();
        await bindJobPage(createdPage, marker);
        page = createdPage;
      }

      await page.bringToFront();

      if (DockerCdpBrowserProvider.#activeSessionId !== id) {
        throw new Error("Browser session disconnected during acquisition");
      }

      this.#connections.set(id, {
        browser,
        pageRef: marker,
      });

      return {
        id,
        page,
        profileRef: this.#profileRef,
      };
    } catch (error) {
      if (createdPage && !createdPage.isClosed()) {
        try {
          await createdPage.close();
        } catch {
          // The primary acquisition error remains authoritative. A failed
          // best-effort cleanup must not replace it.
        }
      }

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

  async resolveAutomationAttachment(sessionId: string): Promise<{
    readonly sessionId: string;
    readonly cdpEndpoint: string;
  }> {
    const connection = this.#connections.get(sessionId);
    const browser = connection?.browser;
    if (
      !connection ||
      !browser ||
      !browser.isConnected() ||
      DockerCdpBrowserProvider.#activeSessionId !== sessionId ||
      this.#releasingSessionIds.has(sessionId)
    ) {
      throw new Error(
        "Browser automation attachment requires a currently acquired session owned by this provider instance",
      );
    }

    return {
      sessionId,
      cdpEndpoint: await this.#resolveEndpoint(
        this.#endpoint,
        this.#connectTimeoutMs,
      ),
      pageRef: connection.pageRef,
    };
  }

  async release(sessionId: string): Promise<void> {
    const existingRelease = this.#releasePromises.get(sessionId);
    if (existingRelease) {
      await existingRelease;
      return;
    }

    const connection = this.#connections.get(sessionId);
    const browser = connection?.browser;
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
